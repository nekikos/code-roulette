/**
 * Точка входа плагина Code Roulette.
 * Класс RouletteController управляет игрой: панелью, редактором, таймером и проверкой.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { findFunctions, indentAt, FunctionRange } from './parser';
import { getPanelHtml } from './panel';
import {
    GameState, canTransition, pickIndex, pushRecent, formatTime,
    Stats, emptyStats, updateStats, placeholderBody, looksLikeOriginal, CHEAT_PENALTY
} from './game';

/** Ключи для хранения данных между запусками VS Code. */
const STATS_KEY = 'codeRoulette.stats';
const RECENT_KEY = 'codeRoulette.recent';

/** Текущая игра: какую функцию стёрли и что нужно, чтобы её вернуть. */
interface Round {
    uri: vscode.Uri;
    name: string;
    signature: string;
    /** Исходное тело функции (между `{` и `}`). */
    originalBody: string;
    /** Сколько секунд дано. */
    total: number;
    /** Время старта (мс). */
    startedAt: number;
    /** Восстановлен ли уже оригинал. */
    restored: boolean;
    /** Сколько раз пытался вернуть оригинал (Ctrl+Z, вставка). */
    cheats: number;
}

class RouletteController {
    private panel: vscode.WebviewPanel | undefined;
    private state: GameState = 'idle';
    private uri: vscode.Uri | undefined;          // файл, с которым играем
    private candidates: FunctionRange[] = [];      // функции на колесе
    private pending: FunctionRange | undefined;    // выпавшая, но ещё не стёртая
    private pendingMinutes = 5;
    private round: Round | undefined;
    private timer: NodeJS.Timeout | undefined;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly output: vscode.OutputChannel;
    /** Плагин сам правит файл — такие правки не проверяем на читерство. */
    private ownEdit = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = 'codeRoulette.open';
        this.output = vscode.window.createOutputChannel('Code Roulette');
        this.resetStatusBar();
        this.statusBar.show();
        context.subscriptions.push(this.statusBar, this.output);
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => this.watchForCheats(e)));
    }

    // ---------- панель ----------

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
    private async onMessage(msg: { type: string; minutes?: number }): Promise<void> {
        switch (msg.type) {
            case 'ready':
            case 'refresh':
                this.rememberActiveFile();
                this.sendInit();
                break;
            case 'spin':
                await this.spin(msg.minutes || 5);
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
            case 'showOriginal':
                await this.showOriginal();
                break;
            case 'restore':
                if (await this.restoreOriginal()) {
                    this.post({ type: 'restored' });
                }
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

    /** Отправляет в панель список функций, статистику и текущую игру (если идёт). */
    private async sendInit(): Promise<void> {
        let fileName = '';
        this.candidates = [];
        if (this.uri !== undefined) {
            const doc = await vscode.workspace.openTextDocument(this.uri);
            fileName = path.basename(this.uri.fsPath);
            this.candidates = this.filterCandidates(findFunctions(doc.getText()));
        }
        let game = undefined;
        if (this.state === 'solving' && this.round !== undefined) {
            game = {
                name: this.round.name, signature: this.round.signature,
                left: this.secondsLeft(), total: this.round.total
            };
        }
        this.post({
            type: 'init',
            file: fileName,
            functions: this.candidates.map(f => ({ name: f.name, signature: f.signature, lines: f.bodyLines })),
            stats: this.getStats(),
            game: game
        });
    }

    /** Оставляет только функции, подходящие для игры (по настройкам). */
    private filterCandidates(all: FunctionRange[]): FunctionRange[] {
        const config = vscode.workspace.getConfiguration('codeRoulette');
        const skipMain = config.get<boolean>('skipMain', true);
        const minLines = config.get<number>('minLines', 2);
        return all.filter(f => !(skipMain && f.name === 'main') && f.bodyLines >= minLines);
    }

    // ---------- ход игры ----------

    /** Кнопка «Крутить»: выбираем функцию и просим панель прокрутить колесо до неё. */
    private async spin(minutes: number): Promise<void> {
        if (!canTransition(this.state, 'spinning')) {
            return;
        }
        if (this.uri === undefined) {
            this.post({ type: 'error', message: 'Открой C/C++ файл и нажми «Обновить»' });
            return;
        }
        const doc = await vscode.workspace.openTextDocument(this.uri);
        this.candidates = this.filterCandidates(findFunctions(doc.getText()));
        const names = this.candidates.map(f => f.name);
        const index = pickIndex(names, this.getRecent());
        if (index === -1) {
            this.post({ type: 'error', message: 'В файле нет подходящих функций' });
            return;
        }
        this.state = 'spinning';
        this.pending = this.candidates[index];
        this.pendingMinutes = minutes;
        this.post({
            type: 'spin',
            index: index,
            functions: this.candidates.map(f => ({ name: f.name, signature: f.signature, lines: f.bodyLines }))
        });
    }

    /** Колесо остановилось: стираем тело функции, сохраняем оригинал, запускаем таймер. */
    private async startRound(): Promise<void> {
        if (this.state !== 'spinning' || this.pending === undefined || this.uri === undefined) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(this.uri);
        const text = doc.getText();
        // ищем функцию заново: пока крутилось колесо, файл могли изменить
        const fresh = findFunctions(text).find(f => f.signature === this.pending!.signature);
        if (fresh === undefined) {
            this.state = 'idle';
            this.post({ type: 'error', message: 'Функция изменилась, крутим заново' });
            this.sendInit();
            return;
        }
        const originalBody = text.slice(fresh.open + 1, fresh.close);
        this.saveBackup(fresh.signature, originalBody);

        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(doc.positionAt(fresh.open + 1), doc.positionAt(fresh.close));
        edit.replace(this.uri, range, placeholderBody(indentAt(text, fresh.headerStart)));
        await this.applyOwnEdit(edit);
        await doc.save();

        // переводим курсор на строку с TODO
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const todoLine = doc.positionAt(fresh.open).line + 1;
        const end = doc.lineAt(todoLine).range.end;
        editor.selection = new vscode.Selection(end, end);
        editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);

        this.round = {
            uri: this.uri,
            name: fresh.name,
            signature: fresh.signature,
            originalBody: originalBody,
            total: this.pendingMinutes * 60,
            startedAt: Date.now(),
            restored: false,
            cheats: 0
        };
        this.pending = undefined;
        this.state = 'solving';
        this.setRecent(pushRecent(this.getRecent(), fresh.name));
        this.post({ type: 'solving', name: fresh.name, signature: fresh.signature, left: this.round.total, total: this.round.total });
        this.startTimer();
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

    /** Каждую секунду: обновляем таймер в панели и строке состояния, проверяем конец времени. */
    private onTick(): void {
        if (this.round === undefined) {
            return;
        }
        const left = this.secondsLeft();
        this.post({ type: 'tick', left: left, total: this.round.total });
        this.statusBar.text = '🎰 ' + formatTime(left) + ' · ' + this.round.name;
        this.statusBar.tooltip = 'Code Roulette: напиши функцию ' + this.round.signature;
        this.statusBar.backgroundColor = left <= 60
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : new vscode.ThemeColor('statusBarItem.warningBackground');
        if (left <= 0) {
            this.finish(false, '⏰ Время вышло!\nФункцию ' + this.round.name + ' нужно было написать за ' +
                formatTime(this.round.total) + '.');
        }
    }

    /** Кнопка «Готово»: сохраняем файл и запускаем проверку. */
    private async finishByDone(): Promise<void> {
        if (this.round === undefined || !canTransition(this.state, 'checking')) {
            return;
        }
        this.stopTimer();
        this.state = 'checking';
        const seconds = this.secondsPassed();
        const doc = await vscode.workspace.openTextDocument(this.round.uri);
        await doc.save();

        const command = vscode.workspace.getConfiguration('codeRoulette').get<string>('checkCommand', '').trim();
        if (command === '') {
            this.finish(true, 'Функция ' + this.round.name + ' написана за ' + formatTime(seconds) +
                '.\nКоманда проверки не задана — засчитано по времени.', seconds);
            return;
        }
        this.post({ type: 'checking' });
        const cwd = this.projectFolder(this.round.uri);
        const result = await runCommand(command, cwd);
        this.output.clear();
        this.output.appendLine('$ ' + command + '   (папка: ' + cwd + ')');
        this.output.appendLine(result.output);
        this.output.appendLine(result.ok ? '✔ Проверка пройдена' : '✘ Проверка не пройдена');
        if (result.ok) {
            this.finish(true, 'Функция ' + this.round.name + ' написана за ' + formatTime(seconds) +
                '.\nПроверка пройдена ✔', seconds);
        } else {
            this.output.show(true);
            this.finish(false, 'Проверка не пройдена ✘\nПодробности — в панели Output → Code Roulette.');
        }
    }

    /** Кнопка «Сдаться»: возвращаем оригинал и засчитываем поражение. */
    async giveUp(): Promise<void> {
        if (this.round === undefined || this.state !== 'solving') {
            return;
        }
        this.stopTimer();
        await this.restoreOriginal();
        this.finish(false, 'Ты сдался. Оригинал функции ' + this.round.name + ' возвращён.');
    }

    /** Завершает раунд: обновляет статистику и показывает результат. */
    private finish(win: boolean, text: string, seconds = 0): void {
        if (!canTransition(this.state, 'finished')) {
            return;
        }
        this.stopTimer();
        this.state = 'finished';
        const stats = updateStats(this.getStats(), win, seconds);
        this.context.globalState.update(STATS_KEY, stats);
        this.resetStatusBar();
        if (this.round !== undefined && this.round.cheats > 0) {
            text += '\n🚫 Попыток вернуть оригинал: ' + this.round.cheats + ' (−' +
                this.round.cheats * CHEAT_PENALTY + ' сек)';
        }
        const canRestore = this.round !== undefined && !this.round.restored;
        this.post({ type: 'result', win: win, text: text, stats: stats, canRestore: canRestore });
        if (this.panel === undefined) {
            // панель закрыта — сообщаем всплывающим уведомлением
            vscode.window.showInformationMessage((win ? '🎉 Победа! ' : '💀 Поражение. ') + text.split('\n')[0]);
        }
    }

    // ---------- защита от читерства ----------

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
     * Следит за правками в файле во время раунда. Если одной правкой вернулся большой
     * кусок оригинала (Ctrl+Z, вставка из буфера, откат файла) — стираем тело снова
     * и вычитаем CHEAT_PENALTY секунд.
     */
    private watchForCheats(e: vscode.TextDocumentChangeEvent): void {
        if (this.ownEdit || this.state !== 'solving' || this.round === undefined) {
            return;
        }
        if (e.document.uri.toString() !== this.round.uri.toString()) {
            return;
        }
        for (let i = 0; i < e.contentChanges.length; i++) {
            if (looksLikeOriginal(e.contentChanges[i].text, this.round.originalBody)) {
                // править документ прямо внутри события нельзя — откладываем
                setTimeout(() => this.punishCheat(), 0);
                return;
            }
        }
    }

    /** Наказание за чит: снова стираем тело функции и забираем время. */
    private async punishCheat(): Promise<void> {
        if (this.round === undefined || this.state !== 'solving') {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(this.round.uri);
        const text = doc.getText();
        const all = findFunctions(text);
        let target = all.find(f => f.signature === this.round!.signature);
        if (target === undefined) {
            target = all.find(f => f.name === this.round!.name);
        }
        if (target !== undefined) {
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.Range(doc.positionAt(target.open + 1), doc.positionAt(target.close));
            edit.replace(this.round.uri, range, placeholderBody(indentAt(text, target.headerStart)));
            await this.applyOwnEdit(edit);
        }
        this.round.cheats++;
        this.round.startedAt -= CHEAT_PENALTY * 1000;
        this.post({ type: 'cheat', penalty: CHEAT_PENALTY, count: this.round.cheats });
        vscode.window.showWarningMessage('🚫 Code Roulette: вернуть оригинал через Ctrl+Z или вставку нельзя! −' +
            CHEAT_PENALTY + ' секунд.');
        this.onTick();
    }

    // ---------- оригинал функции ----------

    /** Возвращает исходное тело функции в файл. */
    async restoreOriginal(): Promise<boolean> {
        if (this.round === undefined || this.round.restored) {
            return false;
        }
        const doc = await vscode.workspace.openTextDocument(this.round.uri);
        const text = doc.getText();
        const all = findFunctions(text);
        let target = all.find(f => f.signature === this.round!.signature);
        if (target === undefined) {
            target = all.find(f => f.name === this.round!.name);
        }
        if (target === undefined) {
            vscode.window.showErrorMessage('Code Roulette: не нашёл функцию ' + this.round.name +
                '. Оригинал сохранён в резервной копии: ' + this.backupPath());
            return false;
        }
        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(doc.positionAt(target.open + 1), doc.positionAt(target.close));
        edit.replace(this.round.uri, range, this.round.originalBody);
        await this.applyOwnEdit(edit);
        await doc.save();
        this.round.restored = true;
        return true;
    }

    /** Открывает оригинал функции в отдельной вкладке. */
    private async showOriginal(): Promise<void> {
        if (this.round === undefined) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument({
            language: 'cpp',
            content: '// Оригинал функции ' + this.round.name + '\n' +
                this.round.signature + ' {' + this.round.originalBody + '}\n'
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
    }

    /** Путь к файлу резервной копии. */
    private backupPath(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'last-function-backup.cpp');
    }

    /** Сохраняет оригинал функции в файл, чтобы код не потерялся даже при закрытии VS Code. */
    private saveBackup(signature: string, body: string): void {
        try {
            fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
            const header = '// Code Roulette: резервная копия от ' + new Date().toLocaleString() +
                '\n// Файл: ' + (this.uri ? this.uri.fsPath : '') + '\n';
            fs.writeFileSync(this.backupPath(), header + signature + ' {' + body + '}\n', 'utf8');
        } catch (e) {
            this.output.appendLine('Не удалось сохранить резервную копию: ' + String(e));
        }
    }

    // ---------- вспомогательное ----------

    /** Папка проекта для команды проверки: папка рабочей области или папка файла. */
    private projectFolder(uri: vscode.Uri): string {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder !== undefined ? folder.uri.fsPath : path.dirname(uri.fsPath);
    }

    private resetStatusBar(): void {
        this.statusBar.text = '🎰 Рулетка';
        this.statusBar.tooltip = 'Code Roulette: открыть рулетку';
        this.statusBar.backgroundColor = undefined;
    }

    private getStats(): Stats {
        return this.context.globalState.get<Stats>(STATS_KEY, emptyStats());
    }

    private getRecent(): string[] {
        return this.context.globalState.get<string[]>(RECENT_KEY, []);
    }

    private setRecent(recent: string[]): void {
        this.context.globalState.update(RECENT_KEY, recent);
    }

    dispose(): void {
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
        { dispose: () => controller.dispose() }
    );
}

/** Вызывается при выключении плагина. */
export function deactivate(): void {}
