// Code Roulette — логика панели (колесо, таймер, кнопки, достижения).
// Панель только показывает состояние: решения принимает плагин (extension.ts),
// общение идёт сообщениями postMessage.
(function () {
    'use strict';

    // В VS Code есть acquireVsCodeApi; в обычном браузере включаем демо-режим для проверки вёрстки.
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : createDemoApi();

    const COLORS = ['#ff2bd6', '#00f0ff', '#9d4dff', '#ffe600'];
    const SPIN_MS = 5200;

    const $ = (id) => document.getElementById(id);
    const canvas = $('wheel');
    const ctx = canvas.getContext('2d');

    let functions = [];        // [{ name, signature, lines }]
    let minutes = 5;           // выбранное время
    let level = 'medium';      // выбранная сложность
    let rotation = 0;          // текущий поворот колеса в радианах
    let spinning = false;
    let winners = [];          // индексы подсвеченных секторов
    let soundOn = true;
    let lightsPhase = 0;       // для мигания лампочек по краю
    let examActive = false;
    let allAchievements = [];
    let unlocked = [];
    let defaultCommand = '';   // команда проверки из настроек — подставляется в форму экзамена
    const examForm = { rounds: 3, minutes: 5, level: 'medium' };

    // ---------- звук (короткие сигналы через Web Audio) ----------
    let audio = null;
    function beep(freq, duration, type, volume) {
        if (!soundOn) {
            return;
        }
        try {
            if (audio === null) {
                audio = new AudioContext();
            }
            const osc = audio.createOscillator();
            const gain = audio.createGain();
            osc.type = type || 'square';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(volume || 0.04, audio.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
            osc.connect(gain);
            gain.connect(audio.destination);
            osc.start();
            osc.stop(audio.currentTime + duration);
        } catch (e) {
            // звук не обязателен
        }
    }

    function playNotes(notes, step, type, volume, length) {
        for (let i = 0; i < notes.length; i++) {
            setTimeout(() => beep(notes[i], length, type, volume), i * step);
        }
    }

    const fanfare = () => playNotes([523, 659, 784, 1046], 110, 'triangle', 0.08, 0.18);
    const sadTrombone = () => playNotes([392, 370, 349, 330], 260, 'sawtooth', 0.04, 0.32);
    const achievementJingle = () => playNotes([784, 988, 1175, 1568], 90, 'triangle', 0.07, 0.15);

    // ---------- рисование колеса ----------
    function drawWheel() {
        const size = canvas.width;
        const c = size / 2;
        const r = c - 30;
        ctx.clearRect(0, 0, size, size);

        // внешнее кольцо
        ctx.beginPath();
        ctx.arc(c, c, r + 18, 0, Math.PI * 2);
        ctx.fillStyle = '#12082a';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#9d4dff';
        ctx.shadowColor = '#9d4dff';
        ctx.shadowBlur = 20;
        ctx.stroke();
        ctx.shadowBlur = 0;

        const n = functions.length;
        if (n === 0) {
            ctx.beginPath();
            ctx.arc(c, c, r, 0, Math.PI * 2);
            ctx.fillStyle = '#0d0620';
            ctx.fill();
            ctx.fillStyle = '#9a8cc2';
            ctx.font = 'bold 30px Segoe UI';
            ctx.textAlign = 'center';
            ctx.fillText('нет функций', c, c - 90);
            drawLights(c, r + 18, 24);
            return;
        }

        const seg = (Math.PI * 2) / n;
        for (let i = 0; i < n; i++) {
            const a0 = rotation + i * seg;
            const a1 = a0 + seg;
            const color = COLORS[i % COLORS.length];
            const hot = winners.indexOf(i) !== -1;

            // сектор: тёмная заливка с градиентом к цвету
            const grad = ctx.createRadialGradient(c, c, r * 0.2, c, c, r);
            grad.addColorStop(0, '#0b0618');
            grad.addColorStop(1, hexAlpha(color, hot ? 0.85 : 0.35));
            ctx.beginPath();
            ctx.moveTo(c, c);
            ctx.arc(c, c, r, a0, a1);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();

            // светящаяся граница сектора
            ctx.lineWidth = hot ? 6 : 3;
            ctx.strokeStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = hot ? 30 : 12;
            ctx.stroke();
            ctx.shadowBlur = 0;

            // подпись: на левой половине колеса переворачиваем, чтобы текст не был вверх ногами
            const mid = a0 + seg / 2;
            ctx.save();
            ctx.translate(c, c);
            ctx.rotate(mid);
            ctx.textBaseline = 'middle';
            const fontSize = Math.max(16, Math.min(34, 260 / Math.max(n, 4) + 8));
            ctx.font = 'bold ' + fontSize + 'px Consolas, monospace';
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = color;
            ctx.shadowBlur = 10;
            const label = shorten(functions[i].name, 14);
            if (Math.cos(mid) < 0) {
                ctx.rotate(Math.PI);
                ctx.textAlign = 'left';
                ctx.fillText(label, -(r - 22), 0);
            } else {
                ctx.textAlign = 'right';
                ctx.fillText(label, r - 22, 0);
            }
            ctx.restore();
        }
        drawLights(c, r + 18, Math.max(24, n * 3));
    }

    // лампочки по краю колеса, мигают через одну
    function drawLights(c, radius, count) {
        for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2;
            const x = c + Math.cos(a) * radius;
            const y = c + Math.sin(a) * radius;
            const on = (i + lightsPhase) % 2 === 0;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = on ? '#ffe600' : '#5a4a10';
            ctx.shadowColor = '#ffe600';
            ctx.shadowBlur = on ? 14 : 0;
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    }

    function shorten(s, max) {
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function hexAlpha(hex, alpha) {
        const v = parseInt(hex.slice(1), 16);
        return 'rgba(' + (v >> 16) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + alpha + ')';
    }

    // индекс сектора под стрелкой (стрелка сверху, угол -π/2)
    function sectorAtPointer() {
        const n = functions.length;
        const seg = (Math.PI * 2) / n;
        let a = (-Math.PI / 2 - rotation) % (Math.PI * 2);
        if (a < 0) {
            a += Math.PI * 2;
        }
        return Math.floor(a / seg) % n;
    }

    // ---------- вращение ----------

    // Докручивает колесо до сектора index; turns — сколько полных оборотов минимум.
    function spinTo(index, duration, turns, onDone) {
        const n = functions.length;
        const seg = (Math.PI * 2) / n;
        // центр выбранного сектора должен оказаться под стрелкой, плюс небольшой случайный сдвиг
        const jitter = (Math.random() - 0.5) * seg * 0.6;
        let target = -Math.PI / 2 - (index + 0.5) * seg + jitter;
        const full = Math.PI * 2;
        while (target < rotation + full * turns) {
            target += full;
        }
        const start = rotation;
        const t0 = performance.now();
        let lastSector = sectorAtPointer();

        function frame(now) {
            const t = Math.min(1, (now - t0) / duration);
            const eased = 1 - Math.pow(1 - t, 4); // плавное замедление
            rotation = start + (target - start) * eased;
            const s = sectorAtPointer();
            if (s !== lastSector) {
                lastSector = s;
                beep(900 + Math.random() * 200, 0.03, 'square', 0.03);
                const p = document.querySelector('.pointer');
                p.classList.remove('tick');
                void p.offsetWidth;
                p.classList.add('tick');
            }
            drawWheel();
            if (t < 1) {
                requestAnimationFrame(frame);
            } else {
                winners.push(index);
                drawWheel();
                beep(1320, 0.25, 'triangle', 0.08);
                onDone();
            }
        }
        requestAnimationFrame(frame);
    }

    // Крутит колесо до всех выпавших секторов по очереди (на адском их два).
    function spinAll(indexes) {
        spinning = true;
        winners = [];
        setControlsEnabled(false);
        let k = 0;
        function next() {
            if (k >= indexes.length) {
                spinning = false;
                setTimeout(() => vscode.postMessage({ type: 'spinDone' }), 900);
                return;
            }
            const first = k === 0;
            const idx = indexes[k];
            k++;
            if (!first) {
                // второй сектор: баннер «двойной удар» и короткое вращение
                const d = $('double');
                d.classList.remove('show');
                void d.offsetWidth;
                d.classList.add('show');
                playNotes([220, 330, 440], 120, 'sawtooth', 0.05, 0.2);
                setTimeout(() => spinTo(idx, 3000, 2, next), 900);
            } else {
                spinTo(idx, SPIN_MS, 6, next);
            }
        }
        next();
    }

    // ---------- экраны ----------
    function show(view) {
        const views = document.querySelectorAll('.view');
        for (let i = 0; i < views.length; i++) {
            views[i].classList.toggle('active', views[i].id === 'view-' + view);
        }
    }

    function setControlsEnabled(on) {
        const ok = on && functions.length > 0;
        $('spin').disabled = !ok;
        $('hub').disabled = !ok;
        $('refresh').disabled = !on;
        const segs = document.querySelectorAll('.seg');
        for (let i = 0; i < segs.length; i++) {
            segs[i].disabled = !on;
        }
    }

    function setStats(s) {
        if (!s) {
            return;
        }
        $('st-wins').textContent = s.wins;
        $('st-losses').textContent = s.losses;
        $('st-streak').textContent = s.streak;
        $('st-best').textContent = s.bestSeconds > 0 ? formatTime(s.bestSeconds) : '—';
    }

    function setExam(exam) {
        examActive = !!exam;
        $('exam-bar').classList.toggle('hidden', !examActive);
        $('setup').classList.toggle('hidden', examActive); // время и сложность на экзамене задаёт практик
        $('exam-btn').classList.toggle('hidden', examActive);
        if (examActive) {
            $('exam-student').textContent = exam.student;
            $('exam-round').textContent = 'РАУНД ' + exam.round + '/' + exam.rounds;
            $('exam-rules').textContent = exam.minutes + ' мин · ' + exam.difficultyName +
                (exam.hintsAllowed ? ' · 💡 можно' : ' · 💡 нельзя');
        }
    }

    function formatTime(sec) {
        sec = Math.max(0, Math.floor(sec));
        const m = Math.floor(sec / 60);
        const r = sec % 60;
        return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }

    function setTimer(left, total) {
        $('timer').textContent = formatTime(left);
        const len = 603.2; // длина окружности 2π·96
        const part = total > 0 ? left / total : 0;
        $('ring').style.strokeDashoffset = String(len * (1 - part));
        $('timer').parentElement.classList.toggle('danger', left <= 60);
        if (left <= 10 && left > 0) {
            beep(660, 0.08, 'square', 0.05);
        }
    }

    function toast(text) {
        const t = $('toast');
        t.textContent = text;
        t.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
    }

    // создаёт элемент с классом и текстом (textContent — безопасно для любых имён функций)
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) {
            e.className = cls;
        }
        if (text !== undefined) {
            e.textContent = text;
        }
        return e;
    }

    // ---------- конфетти ----------
    function confetti() {
        const cv = $('confetti');
        const c2 = cv.getContext('2d');
        cv.width = window.innerWidth;
        cv.height = window.innerHeight;
        const parts = [];
        for (let i = 0; i < 160; i++) {
            parts.push({
                x: cv.width / 2,
                y: cv.height / 3,
                vx: (Math.random() - 0.5) * 14,
                vy: Math.random() * -14 - 4,
                size: 4 + Math.random() * 6,
                color: COLORS[i % COLORS.length],
                rot: Math.random() * Math.PI,
                vr: (Math.random() - 0.5) * 0.3
            });
        }
        const t0 = performance.now();
        function frame(now) {
            c2.clearRect(0, 0, cv.width, cv.height);
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                p.vy += 0.35;
                p.x += p.vx;
                p.y += p.vy;
                p.rot += p.vr;
                c2.save();
                c2.translate(p.x, p.y);
                c2.rotate(p.rot);
                c2.fillStyle = p.color;
                c2.shadowColor = p.color;
                c2.shadowBlur = 8;
                c2.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
                c2.restore();
            }
            if (now - t0 < 3500) {
                requestAnimationFrame(frame);
            } else {
                c2.clearRect(0, 0, cv.width, cv.height);
            }
        }
        requestAnimationFrame(frame);
    }

    // ---------- достижения ----------
    function renderAchievements() {
        const grid = $('ach-grid');
        grid.innerHTML = '';
        for (let i = 0; i < allAchievements.length; i++) {
            const a = allAchievements[i];
            const open = unlocked.indexOf(a.id) !== -1;
            const item = el('div', 'ach-item ' + (open ? 'open' : 'locked'));
            item.appendChild(el('div', 'ico', open ? a.icon : '🔒'));
            item.appendChild(el('div', 'ttl', a.title));
            item.appendChild(el('div', 'dsc', a.description));
            grid.appendChild(item);
        }
        $('ach-count').textContent = unlocked.length + '/' + allAchievements.length;
    }

    // показывает новые достижения по одному всплывающим окном
    function popAchievements(list) {
        let i = 0;
        function next() {
            if (i >= list.length) {
                return;
            }
            const a = list[i++];
            $('ach-pop-icon').textContent = a.icon;
            $('ach-pop-title').textContent = a.title;
            const pop = $('ach-pop');
            pop.classList.add('show');
            achievementJingle();
            setTimeout(() => {
                pop.classList.remove('show');
                setTimeout(next, 600);
            }, 2600);
        }
        setTimeout(next, 1200);
    }

    // ---------- кнопки ----------
    function spin() {
        if (spinning || functions.length === 0) {
            return;
        }
        vscode.postMessage({ type: 'spin', minutes: minutes, difficulty: level });
    }

    $('spin').addEventListener('click', spin);
    $('hub').addEventListener('click', spin);
    $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    $('done').addEventListener('click', () => vscode.postMessage({ type: 'done' }));
    $('hint').addEventListener('click', () => vscode.postMessage({ type: 'hint' }));
    $('giveup').addEventListener('click', () => vscode.postMessage({ type: 'giveUp' }));
    $('again').addEventListener('click', () => vscode.postMessage({ type: 'again' }));
    $('report').addEventListener('click', () => vscode.postMessage({ type: 'openReport' }));
    $('original').addEventListener('click', () => vscode.postMessage({ type: 'showOriginal' }));
    $('restore').addEventListener('click', () => vscode.postMessage({ type: 'restore' }));
    $('sound').addEventListener('click', () => {
        soundOn = !soundOn;
        $('sound').textContent = soundOn ? '🔊' : '🔇';
    });
    $('trophies').addEventListener('click', () => {
        renderAchievements();
        $('ach-modal').classList.remove('hidden');
    });
    // любое окно закрывается крестиком или кликом по тёмному фону
    const closers = document.querySelectorAll('.modal-close');
    for (let i = 0; i < closers.length; i++) {
        closers[i].addEventListener('click', () => $(closers[i].dataset.modal).classList.add('hidden'));
    }
    const modals = document.querySelectorAll('.modal');
    for (let i = 0; i < modals.length; i++) {
        modals[i].addEventListener('click', (e) => {
            if (e.target === modals[i]) {
                modals[i].classList.add('hidden');
            }
        });
    }

    // ---------- экзамен: форма практика и остановка по PIN ----------
    $('exam-btn').addEventListener('click', () => {
        if (examActive) {
            toast('🎓 Экзамен уже идёт');
            return;
        }
        $('ex-command').value = defaultCommand;
        $('ex-pin').value = '';
        $('ex-pin2').value = '';
        $('ex-error').textContent = '';
        $('exam-modal').classList.remove('hidden');
        $('ex-student').focus();
    });

    // подсвечивает поле с ошибкой и пишет, что не так
    function formError(errorId, inputId, text) {
        $(errorId).textContent = text;
        if (inputId) {
            const input = $(inputId);
            input.classList.remove('bad');
            void input.offsetWidth;
            input.classList.add('bad');
            input.focus();
        }
        beep(180, 0.15, 'sawtooth', 0.04);
    }

    function submitExam() {
        const student = $('ex-student').value.trim();
        const pin = $('ex-pin').value;
        if (student === '') {
            formError('ex-error', 'ex-student', 'Введите ФИО студента');
            return;
        }
        if (pin.length < 4) {
            formError('ex-error', 'ex-pin', 'PIN — минимум 4 символа');
            return;
        }
        if (pin !== $('ex-pin2').value) {
            formError('ex-error', 'ex-pin2', 'PIN не совпадает');
            return;
        }
        vscode.postMessage({
            type: 'startExam',
            student: student,
            rounds: examForm.rounds,
            minutes: examForm.minutes,
            difficulty: examForm.level,
            hintsAllowed: $('ex-hints').checked,
            checkCommand: $('ex-command').value.trim(),
            pin: pin
        });
    }

    $('ex-start').addEventListener('click', submitExam);
    $('ex-pin2').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            submitExam();
        }
    });

    $('exam-stop').addEventListener('click', () => {
        $('stop-pin').value = '';
        $('stop-error').textContent = '';
        $('stop-modal').classList.remove('hidden');
        $('stop-pin').focus();
    });

    function submitStop() {
        vscode.postMessage({ type: 'stopExam', pin: $('stop-pin').value });
    }

    $('stop-confirm').addEventListener('click', submitStop);
    $('stop-pin').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            submitStop();
        }
    });

    // группа кнопок-переключателей: активна одна, onPick получает выбранную кнопку
    function segGroup(selector, onPick) {
        const btns = document.querySelectorAll(selector);
        for (let i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', () => {
                for (let k = 0; k < btns.length; k++) {
                    btns[k].classList.remove('active');
                }
                btns[i].classList.add('active');
                onPick(btns[i]);
            });
        }
    }

    segGroup('.seg.tm', (b) => {
        minutes = Number(b.dataset.min);
        beep(500 + minutes * 40, 0.06, 'square', 0.04);
    });
    segGroup('.seg.ex-rounds', (b) => { examForm.rounds = Number(b.dataset.v); });
    segGroup('.seg.ex-min', (b) => { examForm.minutes = Number(b.dataset.v); });
    segGroup('.seg.ex-level', (b) => { examForm.level = b.dataset.v; });
    segGroup('.seg.lvl', (b) => {
        level = b.dataset.level;
        beep(level === 'hard' ? 220 : level === 'easy' ? 880 : 520, 0.08, 'square', 0.04);
    });

    // мигание лампочек, пока колесо стоит
    setInterval(() => {
        lightsPhase = (lightsPhase + 1) % 2;
        if (!spinning) {
            drawWheel();
        }
    }, 600);

    // ---------- сообщения от плагина ----------
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'init':
                functions = msg.functions;
                winners = [];
                $('file').textContent = msg.file || 'нет файла';
                $('empty').classList.toggle('hidden', functions.length > 0);
                setStats(msg.stats);
                setExam(msg.exam);
                if (msg.defaultCommand !== undefined) {
                    defaultCommand = msg.defaultCommand;
                }
                if (msg.achievements) {
                    allAchievements = msg.achievements.all;
                    unlocked = msg.achievements.unlocked;
                }
                drawWheel();
                if (msg.locked) {
                    showLock(msg.locked);
                } else if (msg.game) {
                    showSolving(msg.game);
                } else {
                    show('wheel');
                    setControlsEnabled(true);
                }
                break;
            case 'spin':
                functions = msg.functions;
                drawWheel();
                spinAll(msg.indexes);
                break;
            case 'solving':
                showSolving(msg);
                break;
            case 'tick':
                setTimer(msg.left, msg.total);
                break;
            case 'hint':
                addHint(msg.text);
                toast('💡 Подсказка: −' + msg.penalty + ' секунд');
                beep(1046, 0.12, 'triangle', 0.06);
                break;
            case 'checking':
                show('check');
                break;
            case 'result':
                showResult(msg);
                break;
            case 'cheat':
                cheatAlarm(msg.penalty, msg.count);
                break;
            case 'notice':
                toast(msg.text);
                break;
            case 'examStarted':
                $('exam-modal').classList.add('hidden');
                $('ex-pin').value = '';
                $('ex-pin2').value = '';
                toast('🎓 Экзамен начат — передайте компьютер студенту');
                playNotes([523, 784, 1046], 120, 'triangle', 0.07, 0.2);
                break;
            case 'locked':
                showLock(msg);
                break;
            case 'lockWrong':
                formError('lock-error', 'lock-pin', '❌ Неверный PIN' + (msg.count > 1 ? ' (попыток: ' + msg.count + ')' : ''));
                $('lock-pin').value = '';
                break;
            case 'examError':
                formError('ex-error', null, msg.message);
                break;
            case 'pinWrong':
                formError('stop-error', 'stop-pin', '❌ Неверный PIN');
                $('stop-pin').value = '';
                break;
            case 'examStopped':
                $('stop-modal').classList.add('hidden');
                toast('⏹ Экзамен остановлен, отчёт сохранён');
                break;
            case 'restored':
                $('restore').disabled = true;
                toast('↩ Оригинал возвращён');
                break;
            case 'error':
                toast('⚠ ' + msg.message);
                if (!spinning) {
                    setControlsEnabled(true);
                }
                break;
        }
    });

    function addHint(text) {
        $('hints-box').classList.remove('hidden');
        $('hints-list').appendChild(el('li', '', text));
    }

    function showSolving(g) {
        const box = $('solve-names');
        box.innerHTML = '';
        for (let i = 0; i < g.names.length; i++) {
            const block = el('div', 'fn-block');
            block.appendChild(el('div', 'fn-name', g.names[i]));
            block.appendChild(el('code', 'signature', g.signatures[i]));
            box.appendChild(block);
        }
        $('solve-label').textContent = g.names.length > 1 ? 'ВЫПАЛИ ФУНКЦИИ' : 'ВЫПАЛА ФУНКЦИЯ';
        $('solve-level').textContent = g.difficultyName || '';
        $('hints-list').innerHTML = '';
        $('hints-box').classList.toggle('hidden', !g.hints || g.hints.length === 0);
        for (let i = 0; g.hints && i < g.hints.length; i++) {
            $('hints-list').appendChild(el('li', '', g.hints[i]));
        }
        $('hint').classList.toggle('hidden', !g.hintsAllowed);
        setTimer(g.left, g.total);
        show('solve');
    }

    // вспышка и тряска экрана, когда пойман на Ctrl+Z
    function cheatAlarm(penalty, count) {
        document.body.classList.remove('cheat');
        void document.body.offsetWidth;
        document.body.classList.add('cheat');
        $('cheat-text').textContent = '−' + penalty + ' СЕК' + (count > 1 ? '  ×' + count : '');
        sadTrombone();
        setTimeout(() => document.body.classList.remove('cheat'), 1800);
    }

    function showLock(info) {
        $('lock-round').textContent = 'РАУНД ' + info.round + '/' + info.rounds;
        $('lock-error').textContent = '';
        $('lock-pin').value = '';
        document.querySelector('.lock-icon').classList.remove('open');
        show('lock');
        playNotes([330, 262], 220, 'square', 0.05, 0.25);
        setTimeout(() => $('lock-pin').focus(), 300);
    }

    function submitUnlock() {
        vscode.postMessage({ type: 'unlock', pin: $('lock-pin').value });
    }

    $('lock-open').addEventListener('click', submitUnlock);
    $('lock-pin').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            submitUnlock();
        }
    });

    function showResult(r) {
        const lockView = $('view-lock');
        if (lockView.classList.contains('active')) {
            // замок открывается — и только потом показываем результат
            document.querySelector('.lock-icon').classList.add('open');
            playNotes([523, 659, 784], 90, 'triangle', 0.06, 0.15);
            setTimeout(() => revealResult(r), 650);
            return;
        }
        revealResult(r);
    }

    function revealResult(r) {
        const title = $('result-title');
        title.textContent = r.win ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
        title.className = 'result-title ' + (r.win ? 'win' : 'lose');
        $('result-text').textContent = r.text;
        $('restore').disabled = !r.canRestore;
        setStats(r.stats);

        // журнал раунда
        const jl = $('journal-list');
        jl.innerHTML = '';
        const lines = r.journal && r.journal.length > 0 ? r.journal : ['✅ Чисто: без уходов, вставок и Ctrl+Z'];
        for (let i = 0; i < lines.length; i++) {
            jl.appendChild(el('li', '', lines[i]));
        }
        $('journal-box').classList.remove('hidden');
        $('journal-box').classList.toggle('clean', !r.journal || r.journal.length === 0);

        // новые достижения — значками на экране результата
        const na = $('new-ach');
        na.innerHTML = '';
        const fresh = r.achievements || [];
        for (let i = 0; i < fresh.length; i++) {
            const b = el('div', 'badge');
            b.style.animationDelay = (0.2 + i * 0.15) + 's';
            b.appendChild(el('span', 'ico', fresh[i].icon));
            b.appendChild(el('span', '', fresh[i].title));
            na.appendChild(b);
        }
        na.classList.toggle('hidden', fresh.length === 0);
        if (r.unlocked) {
            unlocked = r.unlocked;
        }

        // экзамен: следующий раунд или итог и отчёт
        const ex = r.exam;
        $('exam-summary').classList.toggle('hidden', !ex || !ex.finished);
        $('report').classList.toggle('hidden', !ex || !ex.finished);
        $('again').classList.remove('hidden');
        if (ex && !ex.finished) {
            $('again-text').textContent = '▶ СЛЕДУЮЩИЙ РАУНД (' + (ex.round + 1) + '/' + ex.rounds + ')';
            $('exam-round').textContent = 'РАУНД ' + ex.round + '/' + ex.rounds + ' ✓';
        } else if (ex && ex.finished) {
            $('exam-summary').textContent = '🎓 ЭКЗАМЕН ЗАВЕРШЁН: ' + ex.wins + ' из ' + ex.rounds +
                ' раундов. Отчёт сохранён в папку проекта.';
            $('again-text').textContent = '🎰 ИГРАТЬ ДАЛЬШЕ';
        } else {
            $('again-text').textContent = '🎰 ЕЩЁ РАЗ';
        }

        show('result');
        if (r.win) {
            confetti();
            fanfare();
        } else {
            sadTrombone();
        }
        popAchievements(fresh);
    }

    // ---------- демо-режим для обычного браузера ----------
    function createDemoApi() {
        const demo = [
            { name: 'partition', signature: 'int partition(int* a, int l, int r)', lines: 9 },
            { name: 'quickSort', signature: 'void quickSort(int* a, int l, int r)', lines: 5 },
            { name: 'siftDown', signature: 'void siftDown(int i, int n)', lines: 12 },
            { name: 'binarySearch', signature: 'int binarySearch(int* a, int n, int x)', lines: 10 },
            { name: 'merge', signature: 'void merge(int* a, int l, int m, int r)', lines: 14 },
            { name: 'printArray', signature: 'void printArray(int* a, int n)', lines: 4 }
        ];
        const ach = [
            { id: 'first_win', icon: '🩸', title: 'Первая кровь', description: 'Первая победа' },
            { id: 'lightning', icon: '⚡', title: 'Молния', description: 'Победа меньше чем за минуту' },
            { id: 'hell', icon: '😈', title: 'Из ада', description: 'Победа на адском уровне' },
            { id: 'busted', icon: '🚨', title: 'Пойман', description: 'Попался на Ctrl+Z' },
            { id: 'exam', icon: '🎓', title: 'Экзамен сдан', description: 'Все раунды экзамена выиграны' }
        ];
        const exam = location.hash === '#exam'
            ? { student: 'Иванов Иван, M3118', round: 1, rounds: 3, minutes: 5, difficultyName: '🔴 Адский', hintsAllowed: true }
            : null;
        let stats = { wins: 3, losses: 1, streak: 2, bestSeconds: 142 };
        let timer = null;
        let picked = [0];
        let hints = 0;
        let sealed = null;
        let wrong = 0;
        const send = (m) => setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: m })), 50);
        return {
            postMessage(m) {
                if (m.type === 'ready' || m.type === 'refresh' || m.type === 'again') {
                    send({ type: 'init', file: 'demo.cpp', functions: demo, stats: stats, exam: exam,
                        defaultCommand: 'cmake --build build && ctest --test-dir build',
                        achievements: { all: ach, unlocked: ['first_win'] } });
                } else if (m.type === 'spin') {
                    const a = Math.floor(Math.random() * demo.length);
                    picked = (m.difficulty === 'hard' || exam) ? [a, (a + 2) % demo.length] : [a];
                    send({ type: 'spin', indexes: picked, functions: demo });
                } else if (m.type === 'spinDone') {
                    const total = 300;
                    let left = total;
                    hints = 0;
                    send({ type: 'solving', names: picked.map(i => demo[i].name), signatures: picked.map(i => demo[i].signature),
                        left: left, total: total, hints: [], hintsAllowed: true, difficultyName: picked.length > 1 ? '🔴 Адский' : '🟡 Средний' });
                    timer = setInterval(() => {
                        left -= 15;
                        send({ type: 'tick', left: left, total: total });
                        if (left <= 0) {
                            clearInterval(timer);
                        }
                    }, 1000);
                } else if (m.type === 'hint') {
                    hints++;
                    send({ type: 'hint', text: ['int pivot = a[r];', 'int i = l - 1;', 'for (int j = l; j < r; j++) {'][(hints - 1) % 3], penalty: 60 });
                } else if (m.type === 'unlock') {
                    if (m.pin === '1234') {
                        send(sealed);
                    } else {
                        wrong++;
                        send({ type: 'lockWrong', count: wrong });
                    }
                } else if (m.type === 'done' || m.type === 'giveUp') {
                    clearInterval(timer);
                    const win = m.type === 'done';
                    send({ type: 'checking' });
                    setTimeout(() => {
                        if (exam) {
                            wrong = 0;
                            sealed = {
                                type: 'result', win: win, stats: stats, canRestore: !win,
                                text: win ? 'Написано за 01:35: partition.\nПроверка пройдена ✔' : 'Ты сдался. Оригинал возвращён.',
                                journal: [], achievements: [], unlocked: ['first_win'],
                                exam: { round: 1, rounds: 3, finished: false, wins: win ? 1 : 0 }
                            };
                            send({ type: 'locked', round: 1, rounds: 3 });
                            return;
                        }
                        stats = win ? { wins: stats.wins + 1, losses: stats.losses, streak: stats.streak + 1, bestSeconds: 95 }
                                    : { wins: stats.wins, losses: stats.losses + 1, streak: 0, bestSeconds: stats.bestSeconds };
                        send({
                            type: 'result', win: win, stats: stats, canRestore: !win,
                            text: win ? 'Написано за 01:35: partition.\nПроверка пройдена ✔' : 'Ты сдался. Оригинал возвращён.',
                            journal: win ? [] : ['🪟 Уходил из VS Code: 2 раз, всего 01:05', '📋 Большие вставки: 1 шт., 140 символов'],
                            achievements: win ? [ach[1], ach[2]] : [ach[3]],
                            unlocked: win ? ['first_win', 'lightning', 'hell'] : ['first_win', 'busted'],
                            exam: exam ? { round: 3, rounds: 3, finished: true, wins: 2 } : null
                        });
                    }, win ? 1500 : 10);
                } else if (m.type === 'restore') {
                    send({ type: 'restored' });
                } else if (m.type === 'startExam') {
                    send({ type: 'examStarted' });
                    send({ type: 'init', file: 'demo.cpp', functions: demo, stats: stats,
                        exam: { student: m.student, round: 1, rounds: m.rounds, minutes: m.minutes,
                            difficultyName: m.difficulty, hintsAllowed: m.hintsAllowed },
                        achievements: { all: ach, unlocked: ['first_win'] } });
                } else if (m.type === 'stopExam') {
                    if (m.pin === '1234') {
                        send({ type: 'examStopped' });
                        send({ type: 'init', file: 'demo.cpp', functions: demo, stats: stats, exam: null,
                            achievements: { all: ach, unlocked: ['first_win'] } });
                    } else {
                        send({ type: 'pinWrong' });
                    }
                }
            }
        };
    }

    drawWheel();
    vscode.postMessage({ type: 'ready' });
})();
