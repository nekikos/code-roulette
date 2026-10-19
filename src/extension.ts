/**
 * Точка входа плагина Code Roulette.
 * Класс RouletteController управляет игрой: панелью, редактором, таймером, проверкой,
 * журналом, режимом экзамена и достижениями.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { findFunctions, indentAt, FunctionRange } from './parser';
import { getPanelHtml } from './panel';
import {
    GameState, canTransition, pushRecent, formatTime,
    Stats, emptyStats, updateStats, placeholderBody, looksLikeOriginal, CHEAT_PENALTY
} from './game';
import { JournalEvent, EventKind, makeEvent, isBigInsert, countChars, summarize, suspiciousLines, MIN_FOCUS_LOSS } from './journal';
import {
    Difficulty, DIFFICULTY_NAMES, pickTargets, hintLines, HINT_PENALTY,
    ACHIEVEMENTS, newAchievements, Exam, createExam, checkPin, examFinished, examAllWon, buildReport
} from './modes';

/** Ключи для хранения данных между запусками VS Code. */
const STATS_KEY = 'codeRoulette.stats';
const RECENT_KEY = 'codeRoulette.recent';
const ROUND_KEY = 'codeRoulette.round';
const EXAM_KEY = 'codeRoulette.exam';
const ACH_KEY = 'codeRoulette.achievements';

/** Стёртая функция: что вернуть и как её найти. */
interface Target {
    name: string;
    signature: string;
    /** Исходное тело функции (между `{` и `}`). */
    originalBody: string;
    restored: boolean;
}

/**
 * Текущий раунд. Хранится на диске (globalState), поэтому переживает закрытие VS Code:
 * после перезапуска раунд продолжается, а время всё это время шло.
 */
interface Round {
    uri: string;
    targets: Target[];
    /** Сколько секунд дано. */
    total: number;
    /** Время старта (мс). Штрафы сдвигают его назад. */
    startedAt: number;
    difficulty: Difficulty;
    cheats: number;
    hints: number;
    events: JournalEvent[];
    /** Когда плагин последний раз был жив (мс) — чтобы понять, сколько VS Code был закрыт. */
    lastSeen: number;
    /** Когда окно VS Code потеряло фокус (мс), 0 — окно в фокусе. */
    focusLostAt: number;
}

/** Сообщение от панели: тип и необязательные поля (время, сложность, форма экзамена, PIN). */
interface PanelMessage {
    type: string;
    minutes?: number;
    difficulty?: Difficulty;
    student?: string;
    rounds?: number;
    hintsAllowed?: boolean;
    checkCommand?: string;
    pin?: string;
}

class RouletteController {
    private panel: vscode.WebviewPanel | undefined;
    private state: GameState = 'idle';
    private uri: vscode.Uri | undefined;          // файл, с которым играем
    private candidates: FunctionRange[] = [];      // функции на колесе
    private pending: FunctionRange[] = [];         // выпавшие, но ещё не стёртые
    private pendingMinutes = 5;
    private pendingDifficulty: Difficulty = 'medium';
    private round: Round | undefined;
    private exam: Exam | undefined;
    private lastReport: string | undefined;        // путь к последнему отчёту экзамена
    private timer: NodeJS.Timeout | undefined;
    private ticks = 0;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly output: vscode.OutputChannel;
    /** Плагин сам правит файл — такие правки не проверяем на читерство. */
    private ownEdit = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = 'codeRoulette.open';
        this.output = vscode.window.createOutputChannel('Code Roulette');
        this.exam = context.globalState.get<Exam>(EXAM_KEY);
        this.resetStatusBar();
        this.statusBar.show();
        context.subscriptions.push(this.statusBar, this.output);
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => this.watchEdits(e)));
        context.subscriptions.push(vscode.window.onDidChangeWindowState(s => this.watchFocus(s.focused)));
        this.resumeRound();
        if (this.isLocked()) {
            this.state = 'finished';
            this.showLock();
        }
    }

    // ======================= панель =======================

    /** Открывает панель рулетки рядом с редактором (или показывает уже открытую). */
    open(): void {
        this.rememberActiveFile();
        if (this.panel !== undefined) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            this.sendInit();
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'codeRoulette', '🎰 Code Roulette', vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
            }
        );
        this.panel.webview.html = getPanelHtml(this.panel.webview, this.context.extensionUri);
        this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), undefined, this.context.subscriptions);
        this.panel.onDidDispose(() => {
            // игра продолжается и без панели: таймер виден в строке состояния
            this.panel = undefined;
        }, undefined, this.context.subscriptions);
    }

    /** Отправляет сообщение в панель, если она открыта. */
    private post(msg: object): void {
        if (this.panel !== undefined) {
            this.panel.webview.postMessage(msg);
        }
    }

    /** Обработка нажатий кнопок в панели. */
    private async onMessage(msg: PanelMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
            case 'refresh':
                this.rememberActiveFile();
                this.sendInit();
                break;
            case 'spin':
                await this.spin(msg.minutes || 5, msg.difficulty || 'medium');
                break;
            case 'spinDone':
                await this.startRound();
                break;
            case 'done':
                await this.finishByDone();
                break;
            case 'giveUp':
                await this.giveUp();
                break;
            case 'hint':
                this.giveHint();
                break;
            case 'showOriginal':
                await this.showOriginal();
                break;
            case 'restore':
                if (await this.restoreOriginal()) {
                    this.post({ type: 'restored' });
                }
                break;
            case 'openReport':
                this.openReport();
                break;
            case 'startExam':
                this.startExamFromPanel(msg);
                break;
            case 'stopExam':
                await this.stopExamWithPin(msg.pin || '');
                break;
            case 'unlock':
                this.unlock(msg.pin || '');
                break;
            case 'again':
                if (canTransition(this.state, 'idle')) {
                    this.state = 'idle';
                }
                this.rememberActiveFile();
                this.sendInit();
                break;
        }
    }

    /** Запоминает активный C/C++ файл — с ним и будем играть. */
    private rememberActiveFile(): void {
        if (this.state === 'solving' || this.state === 'checking' || this.state === 'spinning') {
            return; // во время игры файл не меняем
        }
        const editor = vscode.window.activeTextEditor;
        if (editor !== undefined && (editor.document.languageId === 'cpp' || editor.document.languageId === 'c')) {
            this.uri = editor.document.uri;
        }
    }

    /** Данные экзамена для панели (или null, если экзамена нет). */
    private examInfo(): object | null {
        if (this.exam === undefined) {
            return null;
        }
        const c = this.exam.config;
        return {
            student: c.student,
            round: Math.min(this.exam.results.length + 1, c.rounds),
            rounds: c.rounds,
            minutes: c.minutes,
            difficulty: c.difficulty,
            difficultyName: DIFFICULTY_NAMES[c.difficulty],
            hintsAllowed: c.hintsAllowed
        };
    }

    /** Отправляет в панель список функций, статистику, экзамен и текущую игру (если идёт). */
    private async sendInit(): Promise<void> {
        let fileName = '';
        this.candidates = [];
        if (this.uri !== undefined) {
            const doc = await vscode.workspace.openTextDocument(this.uri);
            fileName = path.basename(this.uri.fsPath);
            this.candidates = this.filterCandidates(findFunctions(doc.getText()));
        }
        let game = null;
        if (this.state === 'solving' && this.round !== undefined) {
            game = this.solvingInfo();
        }
        this.post({
            type: 'init',
            file: fileName,
            functions: this.wheelItems(),
            stats: this.getStats(),
            game: game,
            exam: this.examInfo(),
            locked: this.isLocked() ? this.lockInfo() : null,
            defaultCommand: vscode.workspace.getConfiguration('codeRoulette').get<string>('checkCommand', ''),
            achievements: { all: ACHIEVEMENTS, unlocked: this.getUnlocked() }
        });
    }

    /** Секторы колеса: имя, заголовок, длина. */
    private wheelItems(): object[] {
        return this.candidates.map(f => ({ name: f.name, signature: f.signature, lines: f.bodyLines }));
    }

    /** Всё о текущем раунде для экрана решения. */
    private solvingInfo(): object {
        const r = this.round!;
        return {
            names: r.targets.map(t => t.name),
            signatures: r.targets.map(t => t.signature),
            left: this.secondsLeft(),
            total: r.total,
            hints: this.allHints().slice(0, r.hints),
            hintsAllowed: this.hintsAllowed(),
            difficultyName: DIFFICULTY_NAMES[r.difficulty]
        };
    }

    /** Оставляет только функции, подходящие для игры (по настройкам). */
    private filterCandidates(all: FunctionRange[]): FunctionRange[] {
        const config = vscode.workspace.getConfiguration('codeRoulette');
        const skipMain = config.get<boolean>('skipMain', true);
        const minLines = config.get<number>('minLines', 2);
        return all.filter(f => !(skipMain && f.name === 'main') && f.bodyLines >= minLines);
    }

    // ======================= ход игры =======================

    /** Кнопка «Крутить»: выбираем функции и просим панель прокрутить колесо до них. */
    private async spin(minutes: number, difficulty: Difficulty): Promise<void> {
        if (!canTransition(this.state, 'spinning')) {
            return;
        }
        if (this.isLocked()) {
            this.post({ type: 'error', message: 'Сначала практик должен открыть результат раунда' });
            this.showLock();
            return;
        }
        if (this.uri === undefined) {
            this.post({ type: 'error', message: 'Открой C/C++ файл и нажми «Обновить»' });
            return;
        }
        // на экзамене время и сложность задаёт практик, а не кнопки на панели
        if (this.exam !== undefined) {
            minutes = this.exam.config.minutes;
            difficulty = this.exam.config.difficulty;
        }
        const doc = await vscode.workspace.openTextDocument(this.uri);
        this.candidates = this.filterCandidates(findFunctions(doc.getText()));
        const items = this.candidates.map(f => ({ name: f.name, lines: f.bodyLines }));
        const indexes = pickTargets(items, difficulty, this.getRecent());
        if (indexes.length === 0) {
            this.post({ type: 'error', message: 'В файле нет подходящих функций' });
            return;
        }
        this.state = 'spinning';
        this.pending = indexes.map(i => this.candidates[i]);
        this.pendingMinutes = minutes;
        this.pendingDifficulty = difficulty;
        this.post({ type: 'spin', indexes: indexes, functions: this.wheelItems() });
    }

    /** Колесо остановилось: стираем тела функций, сохраняем оригиналы, запускаем таймер. */
    private async startRound(): Promise<void> {
        if (this.state !== 'spinning' || this.pending.length === 0 || this.uri === undefined) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(this.uri);
        const text = doc.getText();
        // ищем функции заново: пока крутилось колесо, файл могли изменить
        const all = findFunctions(text);
        const fresh: FunctionRange[] = [];
        for (let i = 0; i < this.pending.length; i++) {
            const f = all.find(x => x.signature === this.pending[i].signature);
            if (f === undefined) {
                this.state = 'idle';
                this.post({ type: 'error', message: 'Функция изменилась, крутим заново' });
                this.sendInit();
                return;
            }
            fresh.push(f);
        }

        const targets: Target[] = [];
        const edit = new vscode.WorkspaceEdit();
        for (let i = 0; i < fresh.length; i++) {
            const f = fresh[i];
            const body = text.slice(f.open + 1, f.close);
            targets.push({ name: f.name, signature: f.signature, originalBody: body, restored: false });
            const range = new vscode.Range(doc.positionAt(f.open + 1), doc.positionAt(f.close));
            edit.replace(this.uri, range, placeholderBody(indentAt(text, f.headerStart)));
        }
        this.saveBackup(targets);
        await this.applyOwnEdit(edit);
        await doc.save();

        this.round = {
            uri: this.uri.toString(),
            targets: targets,
            total: this.pendingMinutes * 60,
            startedAt: Date.now(),
            difficulty: this.pendingDifficulty,
            cheats: 0,
            hints: 0,
            events: [],
            lastSeen: Date.now(),
            focusLostAt: 0
        };
        this.pending = [];
        this.state = 'solving';
        let recent = this.getRecent();
        for (let i = 0; i < targets.length; i++) {
            recent = pushRecent(recent, targets[i].name);
        }
        this.setRecent(recent);
        this.addEvent('start', 0, targets.map(t => t.name).join(', ') + ' · ' + DIFFICULTY_NAMES[this.round.difficulty]);

        await this.revealTarget(0);
        this.post({ type: 'solving', ...this.solvingInfo() });
        this.startTimer();
        if (this.exam !== undefined) {
            this.enterZen();
        }
    }

    /** Переводит курсор на строку с TODO в стёртой функции. */
    private async revealTarget(index: number): Promise<void> {
        if (this.round === undefined) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.round.uri));
        const f = this.findTarget(doc.getText(), this.round.targets[index]);
        if (f === undefined) {
            return;
        }
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const line = Math.min(doc.positionAt(f.open).line + 1, doc.lineCount - 1);
        const end = doc.lineAt(line).range.end;
        editor.selection = new vscode.Selection(end, end);
        editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
    }

    /** Ищет стёртую функцию в текущем тексте: по заголовку, а если его поменяли — по имени. */
    private findTarget(text: string, t: Target): FunctionRange | undefined {
        const all = findFunctions(text);
        let f = all.find(x => x.signature === t.signature);
        if (f === undefined) {
            f = all.find(x => x.name === t.name);
        }
        return f;
    }

    /** Сколько секунд осталось в текущем раунде. */
    private secondsLeft(): number {
        if (this.round === undefined) {
            return 0;
        }
        const passed = Math.floor((Date.now() - this.round.startedAt) / 1000);
        return Math.max(0, this.round.total - passed);
    }

    /** Секунд прошло с начала раунда. */
    private secondsPassed(): number {
        if (this.round === undefined) {
            return 0;
        }
        return Math.min(this.round.total, Math.floor((Date.now() - this.round.startedAt) / 1000));
    }

    private startTimer(): void {
        this.stopTimer();
        this.timer = setInterval(() => this.onTick(), 1000);
        this.onTick();
    }

    private stopTimer(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** Каждую секунду: таймер в панели и строке состояния, «пульс» на диск, конец времени. */
    private onTick(): void {
        if (this.round === undefined || this.state !== 'solving') {
            return;
        }
        const left = this.secondsLeft();
        this.post({ type: 'tick', left: left, total: this.round.total });
        const names = this.round.targets.map(t => t.name).join(' + ');
        this.statusBar.text = '🎰 ' + formatTime(left) + ' · ' + names;
        this.statusBar.tooltip = 'Code Roulette: напиши ' + this.round.targets.map(t => t.signature).join(' и ');
        this.statusBar.backgroundColor = left <= 60
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : new vscode.ThemeColor('statusBarItem.warningBackground');

        // раз в 5 секунд отмечаем «я жив» — по этой отметке узнаем, сколько VS Code был закрыт
        this.ticks++;
        this.round.lastSeen = Date.now();
        if (this.ticks % 5 === 0) {
            this.saveRound();
        }
        if (left <= 0) {
            this.finish(false, '⏰ Время вышло!\nНужно было успеть за ' + formatTime(this.round.total) + '.');
        }
    }

    /** Команда проверки: на экзамене — зафиксированная практиком, иначе — из настроек. */
    private checkCommand(): string {
        if (this.exam !== undefined) {
            return this.exam.config.checkCommand;
        }
        return vscode.workspace.getConfiguration('codeRoulette').get<string>('checkCommand', '').trim();
    }

    /** Кнопка «Готово»: сохраняем файл и запускаем проверку. */
    private async finishByDone(): Promise<void> {
        if (this.round === undefined || !canTransition(this.state, 'checking')) {
            return;
        }
        this.stopTimer();
        this.state = 'checking';
        const seconds = this.secondsPassed();
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.round.uri));
        await doc.save();
        const names = this.round.targets.map(t => t.name).join(' и ');

        const command = this.checkCommand();
        if (command === '') {
            this.finish(true, 'Написано за ' + formatTime(seconds) + ': ' + names +
                '.\nКоманда проверки не задана — засчитано по времени.', seconds);
            return;
        }
        this.post({ type: 'checking' });
        const cwd = this.projectFolder(vscode.Uri.parse(this.round.uri));
        const result = await runCommand(command, cwd);
        this.output.clear();
        this.output.appendLine('$ ' + command + '   (папка: ' + cwd + ')');
        this.output.appendLine(result.output);
        this.output.appendLine(result.ok ? '✔ Проверка пройдена' : '✘ Проверка не пройдена');
        if (result.ok) {
            this.finish(true, 'Написано за ' + formatTime(seconds) + ': ' + names + '.\nПроверка пройдена ✔', seconds);
        } else {
            this.output.show(true);
            this.finish(false, 'Проверка не пройдена ✘\nПодробности — в панели Output → Code Roulette.', seconds);
        }
    }

    /** Кнопка «Сдаться»: возвращаем оригинал и засчитываем поражение. */
    async giveUp(): Promise<void> {
        if (this.round === undefined || this.state !== 'solving') {
            return;
        }
        this.stopTimer();
        await this.restoreOriginal();
        this.finish(false, 'Ты сдался. Оригинал возвращён.', this.secondsPassed());
    }

    /**
     * Завершает раунд: статистика, журнал, достижения, экзамен и экран результата.
     */
    private finish(win: boolean, text: string, seconds = 0): void {
        if (this.round === undefined || !canTransition(this.state, 'finished')) {
            return;
        }
        this.stopTimer();
        this.state = 'finished';
        const r = this.round;
        const left = this.secondsLeft();
        this.addEvent('finish', 0, (win ? 'Победа. ' : 'Поражение. ') + text.split('\n')[0]);
        this.context.globalState.update(ROUND_KEY, undefined); // раунд закончен — не продолжать после перезапуска

        const stats = updateStats(this.getStats(), win, seconds);
        this.context.globalState.update(STATS_KEY, stats);
        this.resetStatusBar();
        if (r.cheats > 0) {
            text += '\n🚫 Штраф за попытки вернуть оригинал: −' + r.cheats * CHEAT_PENALTY + ' сек';
        }

        // экзамен: записываем раунд, а после последнего — отчёт
        let examResult = null;
        let examPassed = false;
        if (this.exam !== undefined) {
            this.exam.results.push({
                functions: r.targets.map(t => t.name), win: win, seconds: seconds,
                total: r.total, text: text, events: r.events
            });
            const done = examFinished(this.exam);
            examPassed = done && examAllWon(this.exam);
            examResult = {
                round: this.exam.results.length,
                rounds: this.exam.config.rounds,
                finished: done,
                wins: this.exam.results.filter(x => x.win).length
            };
        }

        // достижения
        const unlocked = this.getUnlocked();
        const fresh = newAchievements({
            win: win, seconds: seconds, secondsLeft: left, hints: r.hints, cheats: r.cheats,
            difficulty: r.difficulty, stats: stats, examPassed: examPassed
        }, unlocked);
        this.context.globalState.update(ACH_KEY, unlocked.concat(fresh.map(a => a.id)));

        const canRestore = r.targets.some(t => !t.restored);
        const result = {
            type: 'result', win: win, text: text, stats: stats, canRestore: canRestore,
            journal: suspiciousLines(summarize(r.events)),
            achievements: fresh,
            unlocked: this.getUnlocked(),
            exam: examResult
        };

        // экзамен: результат закрывается замком до PIN практика
        if (this.exam !== undefined) {
            this.exam.sealed = result;
            this.exam.wrongPins = 0;
            this.context.globalState.update(EXAM_KEY, this.exam);
            this.showLock();
            return;
        }
        this.post(result);
        if (this.panel === undefined) {
            vscode.window.showInformationMessage((win ? '🎉 Победа! ' : '💀 Поражение. ') + text.split('\n')[0]);
        }
    }

    // ======================= замок практика =======================

    /** Висит ли замок: раунд экзамена закончен, а практик ещё не ввёл PIN. */
    private isLocked(): boolean {
        return this.exam !== undefined && this.exam.sealed !== undefined;
    }

    /** Данные для экрана замка. */
    private lockInfo(): object {
        const e = this.exam!;
        return { round: e.results.length, rounds: e.config.rounds, student: e.config.student };
    }

    /** Показывает замок на панели и в строке состояния. */
    private showLock(): void {
        this.statusBar.text = '🔒 Позовите практика';
        this.statusBar.tooltip = 'Code Roulette: раунд экзамена завершён, результат откроет практик';
        this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        if (this.panel === undefined) {
            this.open();
        }
        this.post({ type: 'locked', ...this.lockInfo() });
        if (this.panel === undefined) {
            vscode.window.showWarningMessage('🔒 Code Roulette: раунд завершён. Позовите практика — результат откроется по PIN.');
        }
    }

    /**
     * Практик ввёл PIN на замке: открываем результат. После последнего раунда —
     * отчёт и выход из полноэкранного режима.
     */
    private unlock(pin: string): void {
        if (this.exam === undefined || this.exam.sealed === undefined) {
            return;
        }
        if (!checkPin(this.exam, pin)) {
            this.exam.wrongPins = (this.exam.wrongPins || 0) + 1;
            this.context.globalState.update(EXAM_KEY, this.exam);
            this.post({ type: 'lockWrong', count: this.exam.wrongPins });
            return;
        }
        const result = this.exam.sealed as { text: string; exam: { finished: boolean } | null };
        const last = this.exam.results[this.exam.results.length - 1];
        if (this.exam.wrongPins && this.exam.wrongPins > 0 && last !== undefined) {
            const note = '🔐 Неверный PIN на замке: ' + this.exam.wrongPins + ' раз';
            last.text += '\n' + note;
            result.text += '\n' + note;
        }
        this.exam.sealed = undefined;
        this.exam.wrongPins = 0;
        if (examFinished(this.exam)) {
            this.writeReport(false);
            this.exitZen();
        } else {
            this.context.globalState.update(EXAM_KEY, this.exam);
        }
        this.resetStatusBar();
        this.post(result);
    }

    /** Полноэкранный режим без отвлекающих панелей (Zen Mode) — на время экзамена. */
    private enterZen(): void {
        // toggleZenMode переключает режим, поэтому сначала гарантированно выходим
        vscode.commands.executeCommand('workbench.action.exitZenMode').then(
            () => vscode.commands.executeCommand('workbench.action.toggleZenMode'));
    }

    private exitZen(): void {
        vscode.commands.executeCommand('workbench.action.exitZenMode');
    }

    // ======================= журнал и защита =======================

    /** Добавляет событие в журнал раунда и сохраняет раунд на диск. */
    private addEvent(kind: EventKind, value: number, text: string): void {
        if (this.round === undefined) {
            return;
        }
        this.round.events.push(makeEvent(this.secondsPassed(), kind, value, text));
        this.saveRound();
    }

    /** Сохраняет текущий раунд, чтобы он пережил закрытие VS Code. */
    private saveRound(): void {
        if (this.round !== undefined && (this.state === 'solving' || this.state === 'checking')) {
            this.context.globalState.update(ROUND_KEY, this.round);
        }
    }

    /**
     * При запуске VS Code: если на диске есть незаконченный раунд — продолжаем его.
     * Время шло, пока VS Code был закрыт; в журнал пишется, на сколько его закрывали.
     */
    private resumeRound(): void {
        const saved = this.context.globalState.get<Round>(ROUND_KEY);
        if (saved === undefined) {
            return;
        }
        this.round = saved;
        this.uri = vscode.Uri.parse(saved.uri);
        this.state = 'solving';
        const closed = Math.floor((Date.now() - saved.lastSeen) / 1000);
        if (saved.focusLostAt > 0) {
            saved.focusLostAt = 0;
        }
        if (closed >= MIN_FOCUS_LOSS) {
            this.addEvent('closed', closed, '');
        }
        if (this.secondsLeft() <= 0) {
            this.finish(false, '⏰ Время вышло, пока VS Code был закрыт.');
            vscode.window.showWarningMessage('🎰 Code Roulette: время раунда вышло, пока VS Code был закрыт. Засчитано поражение.');
            return;
        }
        this.startTimer();
        vscode.window.showWarningMessage('🎰 Code Roulette: раунд продолжается! VS Code был закрыт ' +
            formatTime(closed) + ' — таймер всё это время шёл.');
        this.open();
    }

    /** Окно VS Code потеряло или получило фокус (ушёл в браузер, мессенджер и т.п.). */
    private watchFocus(focused: boolean): void {
        if (this.round === undefined || this.state !== 'solving') {
            return;
        }
        if (!focused) {
            this.round.focusLostAt = Date.now();
            this.saveRound();
            return;
        }
        if (this.round.focusLostAt > 0) {
            const away = Math.floor((Date.now() - this.round.focusLostAt) / 1000);
            this.round.focusLostAt = 0;
            if (away >= MIN_FOCUS_LOSS) {
                this.addEvent('focus', away, '');
                this.post({ type: 'notice', text: '🪟 Ты уходил из VS Code на ' + formatTime(away) + ' — это записано в журнал' });
            }
        }
    }

    /** Применяет правку плагина так, чтобы она не считалась читерством. */
    private async applyOwnEdit(edit: vscode.WorkspaceEdit): Promise<void> {
        this.ownEdit = true;
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            this.ownEdit = false;
        }
    }

    /**
     * Следит за правками в файле во время раунда:
     * - вернулся кусок оригинала (Ctrl+Z, вставка, откат файла) — чит: стираем снова и штрафуем;
     * - просто большая вставка — записываем в журнал.
     */
    private watchEdits(e: vscode.TextDocumentChangeEvent): void {
        if (this.ownEdit || this.state !== 'solving' || this.round === undefined) {
            return;
        }
        if (e.document.uri.toString() !== this.round.uri) {
            return;
        }
        for (let i = 0; i < e.contentChanges.length; i++) {
            const inserted = e.contentChanges[i].text;
            for (let k = 0; k < this.round.targets.length; k++) {
                if (looksLikeOriginal(inserted, this.round.targets[k].originalBody)) {
                    // править документ прямо внутри события нельзя — откладываем
                    setTimeout(() => this.punishCheat(k), 0);
                    return;
                }
            }
            if (isBigInsert(inserted)) {
                this.addEvent('paste', countChars(inserted), '');
            }
        }
    }

    /** Наказание за чит: снова стираем тело функции и забираем время. */
    private async punishCheat(index: number): Promise<void> {
        if (this.round === undefined || this.state !== 'solving') {
            return;
        }
        const t = this.round.targets[index];
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.round.uri));
        const text = doc.getText();
        const f = this.findTarget(text, t);
        if (f !== undefined) {
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.Range(doc.positionAt(f.open + 1), doc.positionAt(f.close));
            edit.replace(doc.uri, range, placeholderBody(indentAt(text, f.headerStart)));
            await this.applyOwnEdit(edit);
        }
        this.round.cheats++;
        this.round.startedAt -= CHEAT_PENALTY * 1000;
        this.addEvent('cheat', 0, t.name);
        this.post({ type: 'cheat', penalty: CHEAT_PENALTY, count: this.round.cheats });
        vscode.window.showWarningMessage('🚫 Code Roulette: вернуть оригинал через Ctrl+Z или вставку нельзя! −' +
            CHEAT_PENALTY + ' секунд.');
        this.onTick();
    }

    // ======================= подсказки =======================

    /** Разрешены ли подсказки: вне экзамена всегда, на экзамене — как решил практик. */
    private hintsAllowed(): boolean {
        return this.exam === undefined || this.exam.config.hintsAllowed;
    }

    /** Все строки-подсказки по порядку: сначала первой функции, потом второй. */
    private allHints(): string[] {
        if (this.round === undefined) {
            return [];
        }
        const res: string[] = [];
        for (let i = 0; i < this.round.targets.length; i++) {
            const t = this.round.targets[i];
            const lines = hintLines(t.originalBody);
            for (let k = 0; k < lines.length; k++) {
                res.push((this.round.targets.length > 1 ? t.name + ': ' : '') + lines[k]);
            }
        }
        return res;
    }

    /** Кнопка «Подсказка»: показывает следующую строку оригинала за −60 секунд. */
    private giveHint(): void {
        if (this.round === undefined || this.state !== 'solving') {
            return;
        }
        if (!this.hintsAllowed()) {
            this.post({ type: 'error', message: 'На этом экзамене подсказки запрещены' });
            return;
        }
        const all = this.allHints();
        if (this.round.hints >= all.length) {
            this.post({ type: 'error', message: 'Подсказки закончились — дальше сам!' });
            return;
        }
        const line = all[this.round.hints];
        this.round.hints++;
        this.round.startedAt -= HINT_PENALTY * 1000;
        this.addEvent('hint', this.round.hints, line);
        this.post({ type: 'hint', text: line, penalty: HINT_PENALTY });
        this.onTick();
    }

    // ======================= экзамен =======================

    /** Команда практика: настроить и начать экзамен. */
    async startExam(): Promise<void> {
        const blocker = this.examBlocker();
        if (blocker !== null) {
            vscode.window.showErrorMessage('Code Roulette: ' + blocker);
            return;
        }
        const student = await vscode.window.showInputBox({
            title: 'Экзамен · 1/6', prompt: 'ФИО и группа студента', placeHolder: 'Иванов Иван, M3118',
            ignoreFocusOut: true, validateInput: v => v.trim() === '' ? 'Введите ФИО' : undefined
        });
        if (student === undefined) {
            return;
        }
        const rounds = await vscode.window.showQuickPick(['1', '2', '3', '4', '5'], {
            title: 'Экзамен · 2/6', placeHolder: 'Сколько раундов?', ignoreFocusOut: true
        });
        if (rounds === undefined) {
            return;
        }
        const minutes = await vscode.window.showQuickPick(['3', '5', '10', '15'], {
            title: 'Экзамен · 3/6', placeHolder: 'Минут на раунд?', ignoreFocusOut: true
        });
        if (minutes === undefined) {
            return;
        }
        const levels: { label: string; value: Difficulty }[] = [
            { label: DIFFICULTY_NAMES.easy + ' — короткие функции', value: 'easy' },
            { label: DIFFICULTY_NAMES.medium + ' — любые функции', value: 'medium' },
            { label: DIFFICULTY_NAMES.hard + ' — длинные функции, две за раунд', value: 'hard' }
        ];
        const level = await vscode.window.showQuickPick(levels, {
            title: 'Экзамен · 4/6', placeHolder: 'Сложность', ignoreFocusOut: true
        });
        if (level === undefined) {
            return;
        }
        const hints = await vscode.window.showQuickPick(['Запретить подсказки', 'Разрешить подсказки (−60 сек)'], {
            title: 'Экзамен · 5/6', placeHolder: 'Подсказки', ignoreFocusOut: true
        });
        if (hints === undefined) {
            return;
        }
        const command = await vscode.window.showInputBox({
            title: 'Экзамен · 6/6', prompt: 'Команда проверки (пусто — победа по времени). Студент не сможет её поменять.',
            value: vscode.workspace.getConfiguration('codeRoulette').get<string>('checkCommand', ''),
            ignoreFocusOut: true
        });
        if (command === undefined) {
            return;
        }
        const pin = await vscode.window.showInputBox({
            title: 'PIN практика', prompt: 'Придумайте PIN (от 4 символов): он нужен, чтобы остановить экзамен',
            password: true, ignoreFocusOut: true,
            validateInput: v => v.length < 4 ? 'Минимум 4 символа' : undefined
        });
        if (pin === undefined) {
            return;
        }
        const pin2 = await vscode.window.showInputBox({
            title: 'PIN практика', prompt: 'Повторите PIN', password: true, ignoreFocusOut: true
        });
        if (pin2 !== pin) {
            vscode.window.showErrorMessage('Code Roulette: PIN не совпал, экзамен не начат');
            return;
        }
        this.beginExam({
            student: student.trim(), rounds: Number(rounds), minutes: Number(minutes),
            difficulty: level.value, hintsAllowed: hints.startsWith('Разрешить'),
            checkCommand: command.trim(), pin: pin
        });
        this.open();
    }

    /** Почему сейчас нельзя начать экзамен (или null, если можно). */
    private examBlocker(): string | null {
        if (this.state === 'solving' || this.state === 'checking' || this.state === 'spinning') {
            return 'Сначала закончи текущий раунд';
        }
        if (this.exam !== undefined) {
            return 'Экзамен уже идёт';
        }
        return null;
    }

    /** Форма «Режим экзамена» на панели: проверяем поля и начинаем экзамен. */
    private startExamFromPanel(msg: PanelMessage): void {
        const blocker = this.examBlocker();
        if (blocker !== null) {
            this.post({ type: 'examError', message: blocker });
            return;
        }
        const student = (msg.student || '').trim();
        const pin = msg.pin || '';
        const rounds = Math.min(5, Math.max(1, Math.floor(msg.rounds || 1)));
        const minutes = Math.min(60, Math.max(1, Math.floor(msg.minutes || 5)));
        const levels: Difficulty[] = ['easy', 'medium', 'hard'];
        const difficulty = msg.difficulty !== undefined && levels.indexOf(msg.difficulty) !== -1 ? msg.difficulty : 'medium';
        if (student === '') {
            this.post({ type: 'examError', message: 'Введите ФИО студента' });
            return;
        }
        if (pin.length < 4) {
            this.post({ type: 'examError', message: 'PIN — минимум 4 символа' });
            return;
        }
        this.beginExam({
            student: student, rounds: rounds, minutes: minutes, difficulty: difficulty,
            hintsAllowed: msg.hintsAllowed === true, checkCommand: (msg.checkCommand || '').trim(), pin: pin
        });
        this.post({ type: 'examStarted' });
    }

    /** Создаёт экзамен, сохраняет его и обновляет панель. */
    private beginExam(settings: {
        student: string; rounds: number; minutes: number; difficulty: Difficulty;
        hintsAllowed: boolean; checkCommand: string; pin: string;
    }): void {
        this.exam = createExam(settings);
        this.context.globalState.update(EXAM_KEY, this.exam);
        this.state = 'idle';
        this.resetStatusBar();
        this.sendInit();
        vscode.window.showInformationMessage('🎓 Экзамен начат: ' + settings.rounds + ' раунд(ов) по ' +
            settings.minutes + ' мин. Передайте компьютер студенту.');
    }

    /** Команда практика: досрочно остановить экзамен (нужен PIN). */
    async stopExam(): Promise<void> {
        if (this.exam === undefined) {
            vscode.window.showInformationMessage('Code Roulette: экзамен не идёт');
            return;
        }
        const pin = await vscode.window.showInputBox({
            title: 'Остановить экзамен', prompt: 'PIN практика', password: true, ignoreFocusOut: true
        });
        if (pin === undefined) {
            return;
        }
        if (!(await this.stopExamWithPin(pin))) {
            vscode.window.showErrorMessage('Code Roulette: неверный PIN');
        }
    }

    /**
     * Останавливает экзамен, если PIN верный: текущий раунд — поражение, отчёт сохраняется.
     * @returns false, если PIN неверный
     */
    private async stopExamWithPin(pin: string): Promise<boolean> {
        if (this.exam === undefined) {
            return true;
        }
        if (!checkPin(this.exam, pin)) {
            this.post({ type: 'pinWrong' });
            if (this.round !== undefined && this.state === 'solving') {
                this.addEvent('finish', 0, 'Попытка остановить экзамен с неверным PIN');
            }
            return false;
        }
        if (this.round !== undefined && (this.state === 'solving' || this.state === 'checking')) {
            this.stopTimer();
            await this.restoreOriginal();
            this.exam.results.push({
                functions: this.round.targets.map(t => t.name), win: false, seconds: this.secondsPassed(),
                total: this.round.total, text: 'Остановлен практиком', events: this.round.events
            });
            this.context.globalState.update(ROUND_KEY, undefined);
            this.resetStatusBar();
        }
        this.writeReport(true);
        this.exitZen();
        this.state = 'idle';
        this.resetStatusBar();
        this.post({ type: 'examStopped' });
        this.sendInit();
        return true;
    }

    /** Сохраняет отчёт экзамена в папку проекта, открывает его и заканчивает экзамен. */
    private writeReport(interrupted: boolean): void {
        if (this.exam === undefined) {
            return;
        }
        const uri = this.uri !== undefined ? this.uri : (this.round !== undefined ? vscode.Uri.parse(this.round.uri) : undefined);
        const folder = uri !== undefined ? this.projectFolder(uri) : this.context.globalStorageUri.fsPath;
        const d = new Date();
        const two = (n: number) => (n < 10 ? '0' : '') + n;
        const stamp = d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
        const file = path.join(folder, 'roulette-report-' + stamp + '.md');
        try {
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(file, buildReport(this.exam, uri !== undefined ? path.basename(uri.fsPath) : '—', interrupted), 'utf8');
            this.lastReport = file;
        } catch (e) {
            vscode.window.showErrorMessage('Code Roulette: не удалось сохранить отчёт: ' + String(e));
        }
        this.exam = undefined;
        this.context.globalState.update(EXAM_KEY, undefined);
        this.openReport();
    }

    /** Открывает последний отчёт экзамена в режиме просмотра Markdown. */
    private openReport(): void {
        if (this.lastReport === undefined) {
            return;
        }
        vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(this.lastReport));
    }

    // ======================= оригинал функции =======================

    /** Возвращает исходные тела стёртых функций в файл. */
    async restoreOriginal(): Promise<boolean> {
        if (this.round === undefined) {
            return false;
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.round.uri));
        const text = doc.getText();
        const edit = new vscode.WorkspaceEdit();
        let changed = false;
        for (let i = 0; i < this.round.targets.length; i++) {
            const t = this.round.targets[i];
            if (t.restored) {
                continue;
            }
            const f = this.findTarget(text, t);
            if (f === undefined) {
                vscode.window.showErrorMessage('Code Roulette: не нашёл функцию ' + t.name +
                    '. Оригинал сохранён в резервной копии: ' + this.backupPath());
                continue;
            }
            const range = new vscode.Range(doc.positionAt(f.open + 1), doc.positionAt(f.close));
            edit.replace(doc.uri, range, t.originalBody);
            t.restored = true;
            changed = true;
        }
        if (!changed) {
            return false;
        }
        await this.applyOwnEdit(edit);
        await doc.save();
        return true;
    }

    /** Открывает оригиналы функций в отдельной вкладке. */
    private async showOriginal(): Promise<void> {
        if (this.round === undefined) {
            return;
        }
        let content = '';
        for (let i = 0; i < this.round.targets.length; i++) {
            const t = this.round.targets[i];
            content += '// Оригинал функции ' + t.name + '\n' + t.signature + ' {' + t.originalBody + '}\n\n';
        }
        const doc = await vscode.workspace.openTextDocument({ language: 'cpp', content: content });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
    }

    /** Путь к файлу резервной копии. */
    private backupPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'last-function-backup.cpp');
    }

    /** Сохраняет оригиналы функций в файл, чтобы код не потерялся ни при каких обстоятельствах. */
    private saveBackup(targets: Target[]): void {
        try {
            fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
            let content = '// Code Roulette: резервная копия от ' + new Date().toLocaleString() +
                '\n// Файл: ' + (this.uri ? this.uri.fsPath : '') + '\n';
            for (let i = 0; i < targets.length; i++) {
                content += targets[i].signature + ' {' + targets[i].originalBody + '}\n\n';
            }
            fs.writeFileSync(this.backupPath(), content, 'utf8');
        } catch (e) {
            this.output.appendLine('Не удалось сохранить резервную копию: ' + String(e));
        }
    }

    // ======================= вспомогательное =======================

    /** Папка проекта для команды проверки: папка рабочей области или папка файла. */
    private projectFolder(uri: vscode.Uri): string {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder !== undefined ? folder.uri.fsPath : path.dirname(uri.fsPath);
    }

    private resetStatusBar(): void {
        this.statusBar.text = this.exam !== undefined ? '🎓 Экзамен' : '🎰 Рулетка';
        this.statusBar.tooltip = 'Code Roulette: открыть рулетку';
        this.statusBar.backgroundColor = undefined;
    }

    private getStats(): Stats {
        return this.context.globalState.get<Stats>(STATS_KEY, emptyStats());
    }

    private getUnlocked(): string[] {
        return this.context.globalState.get<string[]>(ACH_KEY, []);
    }

    private getRecent(): string[] {
        return this.context.globalState.get<string[]>(RECENT_KEY, []);
    }

    private setRecent(recent: string[]): void {
        this.context.globalState.update(RECENT_KEY, recent);
    }

    dispose(): void {
        if (this.round !== undefined) {
            this.round.lastSeen = Date.now();
            this.saveRound();
        }
        this.stopTimer();
    }
}

/**
 * Запускает команду в терминале (без окна) и ждёт результат.
 * @returns ok — код выхода 0; output — весь вывод команды
 */
function runCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
    return new Promise(resolve => {
        exec(command, { cwd: cwd, timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ ok: error === null, output: stdout + stderr + (error ? '\n' + error.message : '') });
        });
    });
}

/** Вызывается VS Code при активации плагина. */
export function activate(context: vscode.ExtensionContext): void {
    const controller = new RouletteController(context);
    context.subscriptions.push(
        vscode.commands.registerCommand('codeRoulette.open', () => controller.open()),
        vscode.commands.registerCommand('codeRoulette.giveUp', () => controller.giveUp()),
        vscode.commands.registerCommand('codeRoulette.startExam', () => controller.startExam()),
        vscode.commands.registerCommand('codeRoulette.stopExam', () => controller.stopExam()),
        { dispose: () => controller.dispose() }
    );
}

/** Вызывается при выключении плагина. */
export function deactivate(): void {}
