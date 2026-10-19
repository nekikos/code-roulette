// Code Roulette — логика панели (колесо, таймер, кнопки).
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

    let functions = [];      // [{ name, signature, lines }]
    let minutes = 5;         // выбранное время
    let rotation = 0;        // текущий поворот колеса в радианах
    let spinning = false;
    let winner = -1;         // индекс подсвеченного сектора
    let soundOn = true;
    let lightsPhase = 0;     // для мигания лампочек по краю

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

    function fanfare() {
        const notes = [523, 659, 784, 1046];
        for (let i = 0; i < notes.length; i++) {
            setTimeout(() => beep(notes[i], 0.18, 'triangle', 0.08), i * 110);
        }
    }

    function sadTrombone() {
        const notes = [392, 370, 349, 330];
        for (let i = 0; i < notes.length; i++) {
            setTimeout(() => beep(notes[i], 0.32, 'sawtooth', 0.04), i * 260);
        }
    }

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

            // сектор: тёмная заливка с градиентом к цвету
            const grad = ctx.createRadialGradient(c, c, r * 0.2, c, c, r);
            grad.addColorStop(0, '#0b0618');
            grad.addColorStop(1, hexAlpha(color, i === winner ? 0.85 : 0.35));
            ctx.beginPath();
            ctx.moveTo(c, c);
            ctx.arc(c, c, r, a0, a1);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();

            // светящаяся граница сектора
            ctx.lineWidth = i === winner ? 6 : 3;
            ctx.strokeStyle = color;
            ctx.shadowColor = color;
            ctx.shadowBlur = i === winner ? 30 : 12;
            ctx.stroke();
            ctx.shadowBlur = 0;

            // подпись: на левой половине колеса переворачиваем, чтобы текст не был вверх ногами
            const mid = a0 + seg / 2;
            const cos = Math.cos(mid);
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
            if (cos < 0) {
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
    function spinTo(index) {
        const n = functions.length;
        const seg = (Math.PI * 2) / n;
        // центр выбранного сектора должен оказаться под стрелкой, плюс небольшой случайный сдвиг
        const jitter = (Math.random() - 0.5) * seg * 0.6;
        let target = -Math.PI / 2 - (index + 0.5) * seg + jitter;
        const full = Math.PI * 2;
        while (target < rotation + full * 6) {
            target += full;
        }
        const start = rotation;
        const t0 = performance.now();
        let lastSector = sectorAtPointer();
        spinning = true;
        winner = -1;
        setControlsEnabled(false);

        function frame(now) {
            const t = Math.min(1, (now - t0) / SPIN_MS);
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
                spinning = false;
                winner = index;
                drawWheel();
                beep(1320, 0.25, 'triangle', 0.08);
                setTimeout(() => vscode.postMessage({ type: 'spinDone' }), 900);
            }
        }
        requestAnimationFrame(frame);
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
        toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
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

    // ---------- кнопки ----------
    function spin() {
        if (spinning || functions.length === 0) {
            return;
        }
        vscode.postMessage({ type: 'spin', minutes: minutes });
    }

    $('spin').addEventListener('click', spin);
    $('hub').addEventListener('click', spin);
    $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    $('done').addEventListener('click', () => vscode.postMessage({ type: 'done' }));
    $('giveup').addEventListener('click', () => vscode.postMessage({ type: 'giveUp' }));
    $('again').addEventListener('click', () => vscode.postMessage({ type: 'again' }));
    $('original').addEventListener('click', () => vscode.postMessage({ type: 'showOriginal' }));
    $('restore').addEventListener('click', () => vscode.postMessage({ type: 'restore' }));
    $('sound').addEventListener('click', () => {
        soundOn = !soundOn;
        $('sound').textContent = soundOn ? '🔊' : '🔇';
    });

    const segs = document.querySelectorAll('.seg');
    for (let i = 0; i < segs.length; i++) {
        segs[i].addEventListener('click', () => {
            for (let k = 0; k < segs.length; k++) {
                segs[k].classList.remove('active');
            }
            segs[i].classList.add('active');
            minutes = Number(segs[i].dataset.min);
            beep(500 + minutes * 40, 0.06, 'square', 0.04);
        });
    }

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
                winner = -1;
                $('file').textContent = msg.file || 'нет файла';
                $('empty').classList.toggle('hidden', functions.length > 0);
                setStats(msg.stats);
                drawWheel();
                if (msg.game) {
                    showSolving(msg.game);
                } else {
                    show('wheel');
                    setControlsEnabled(true);
                }
                break;
            case 'spin':
                functions = msg.functions;
                drawWheel();
                spinTo(msg.index);
                break;
            case 'solving':
                showSolving(msg);
                break;
            case 'tick':
                setTimer(msg.left, msg.total);
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
            case 'restored':
                $('restore').disabled = true;
                toast('↩ Оригинал функции возвращён');
                break;
            case 'error':
                toast('⚠ ' + msg.message);
                setControlsEnabled(true);
                spinning = false;
                break;
        }
    });

    // вспышка и тряска экрана, когда пойман на Ctrl+Z
    function cheatAlarm(penalty, count) {
        document.body.classList.remove('cheat');
        void document.body.offsetWidth;
        document.body.classList.add('cheat');
        $('cheat-text').textContent = '−' + penalty + ' СЕК' + (count > 1 ? '  ×' + count : '');
        sadTrombone();
        setTimeout(() => document.body.classList.remove('cheat'), 1800);
    }

    function showSolving(g) {
        $('solve-name').textContent = g.name;
        $('solve-sig').textContent = g.signature;
        setTimer(g.left, g.total);
        show('solve');
    }

    function showResult(r) {
        const title = $('result-title');
        title.textContent = r.win ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ';
        title.className = 'result-title ' + (r.win ? 'win' : 'lose');
        $('result-text').textContent = r.text;
        $('restore').disabled = !r.canRestore;
        setStats(r.stats);
        show('result');
        if (r.win) {
            confetti();
            fanfare();
        } else {
            sadTrombone();
        }
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
        let stats = { wins: 3, losses: 1, streak: 2, bestSeconds: 142 };
        let timer = null;
        let picked = 0;
        const send = (m) => setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: m })), 50);
        return {
            postMessage(m) {
                if (m.type === 'ready' || m.type === 'refresh' || m.type === 'again') {
                    send({ type: 'init', file: 'demo.cpp', functions: demo, stats: stats });
                } else if (m.type === 'spin') {
                    picked = Math.floor(Math.random() * demo.length);
                    send({ type: 'spin', index: picked, functions: demo });
                } else if (m.type === 'spinDone') {
                    const total = m.minutes || 300;
                    let left = total;
                    send({ type: 'solving', name: demo[picked].name, signature: demo[picked].signature, left: left, total: total });
                    timer = setInterval(() => {
                        left -= 15;
                        send({ type: 'tick', left: left, total: total });
                        if (left <= 0) {
                            clearInterval(timer);
                        }
                    }, 1000);
                } else if (m.type === 'done' || m.type === 'giveUp') {
                    clearInterval(timer);
                    const win = m.type === 'done';
                    send({ type: 'checking' });
                    setTimeout(() => {
                        stats = win ? { wins: stats.wins + 1, losses: stats.losses, streak: stats.streak + 1, bestSeconds: 95 }
                                    : { wins: stats.wins, losses: stats.losses + 1, streak: 0, bestSeconds: stats.bestSeconds };
                        send({
                            type: 'result', win: win, stats: stats, canRestore: !win,
                            text: win ? 'Функция partition написана за 01:35.\nТесты прошли ✔' : 'Ты сдался. Оригинал функции возвращён.'
                        });
                    }, win ? 1500 : 10);
                } else if (m.type === 'restore') {
                    send({ type: 'restored' });
                }
            }
        };
    }

    drawWheel();
    vscode.postMessage({ type: 'ready' });
})();
