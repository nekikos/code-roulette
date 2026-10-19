/**
 * Создание HTML для панели рулетки (webview).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Случайная строка для Content-Security-Policy: разрешает только наш скрипт. */
function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let res = '';
    for (let i = 0; i < 32; i++) {
        res += chars[Math.floor(Math.random() * chars.length)];
    }
    return res;
}

/**
 * Читает media/roulette.html и подставляет в него адреса стилей и скрипта.
 * Webview не может открыть файл с диска напрямую — нужен специальный адрес asWebviewUri.
 * @param webview webview панели
 * @param extensionUri папка плагина
 */
export function getPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    const htmlPath = path.join(media.fsPath, 'roulette.html');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'roulette.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'roulette.js'));
    const nonce = makeNonce();

    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.split('{{cspSource}}').join(webview.cspSource);
    html = html.split('{{nonce}}').join(nonce);
    html = html.split('{{styleUri}}').join(styleUri.toString());
    html = html.split('{{scriptUri}}').join(scriptUri.toString());
    return html;
}
