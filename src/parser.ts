/**
 * Поиск функций в тексте C/C++ и их границ.
 * Не зависит от VS Code: работает с обычной строкой.
 */

/** Найденная функция и её положение в тексте. */
export interface FunctionRange {
    /** Имя функции (например, `partition` или `Graph::dfs`). */
    name: string;
    /** Заголовок функции одной строкой: `int partition(int* a, int l, int r)`. */
    signature: string;
    /** Позиция начала заголовка. */
    headerStart: number;
    /** Позиция открывающей `{` тела. */
    open: number;
    /** Позиция закрывающей `}` тела. */
    close: number;
    /** Сколько непустых строк в теле. */
    bodyLines: number;
}

/** Слова, которые выглядят как `name(...)`, но функцией не являются. */
const KEYWORDS = ['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof'];

/** Заголовок функции в конце текста перед `{`: тип, имя, параметры, `const` и т.п. */
const FUNC_HEADER = /([A-Za-z_~][\w:~]*)\s*\([^()]*\)\s*(?:const|noexcept|override|final|\s)*(?:->[^;{}]*)?$/;

/**
 * Заменяет комментарии, строки, символьные литералы и директивы препроцессора пробелами.
 * Длина текста и переводы строк сохраняются, поэтому позиции совпадают с исходником.
 * @param text исходный текст
 * @returns очищенный текст той же длины
 */
export function cleanCode(text: string): string {
    const res: string[] = [];
    // состояния автомата: код, // комментарий, /* комментарий */, строка, символ, #директива
    let state = 'code';
    let lineStart = true;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = i + 1 < text.length ? text[i + 1] : '';

        if (c === '\n') {
            res.push('\n');
            if (state === 'line' || state === 'prep') {
                state = 'code';
            }
            lineStart = true;
            continue;
        }

        if (state === 'code') {
            if (c === '/' && next === '/') {
                state = 'line';
                res.push(' ');
            } else if (c === '/' && next === '*') {
                state = 'block';
                res.push(' ', ' ');
                i++;
            } else if (c === '"') {
                state = 'string';
                res.push(' ');
            } else if (c === "'") {
                state = 'char';
                res.push(' ');
            } else if (c === '#' && lineStart) {
                state = 'prep';
                res.push(' ');
            } else {
                res.push(c);
            }
        } else if (state === 'block') {
            if (c === '*' && next === '/') {
                state = 'code';
                res.push(' ', ' ');
                i++;
            } else {
                res.push(' ');
            }
        } else if (state === 'string' || state === 'char') {
            const quote = state === 'string' ? '"' : "'";
            if (c === '\\') {
                res.push(' ');
                if (next !== '\n' && next !== '') {
                    res.push(' ');
                    i++;
                }
            } else {
                if (c === quote) {
                    state = 'code';
                }
                res.push(' ');
            }
        } else {
            res.push(' ');
        }

        if (c !== ' ' && c !== '\t' && c !== '\r') {
            lineStart = false;
        }
    }
    return res.join('');
}

/**
 * Проверяет, является ли текст перед `{` заголовком функции.
 * @param header текст от предыдущей `;`, `{` или `}` до `{`
 * @returns имя функции и позиция начала заголовка внутри header, или null
 */
export function parseHeader(header: string): { name: string; start: number } | null {
    let h = header;
    // у конструктора после `)` может идти список инициализации: `A(int x) : x_(x) {`
    const init = /\)\s*:(?!:)/.exec(h);
    if (init !== null) {
        h = h.slice(0, init.index + 1);
    }
    const m = FUNC_HEADER.exec(h);
    if (m === null || KEYWORDS.indexOf(m[1]) !== -1) {
        return null;
    }
    // заголовок начинается после пробелов и меток `public:` / `private:` / `protected:`
    const skip = /^\s*(?:(?:public|private|protected)\s*:(?!:)\s*)*/.exec(header);
    const start = skip === null ? 0 : skip[0].length;
    return { name: m[1], start: start };
}

/** Считает непустые строки в тексте. */
function countLines(text: string): number {
    const lines = text.split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '') {
            count++;
        }
    }
    return count;
}

/**
 * Находит все функции в тексте (включая методы внутри классов), но не вложенные в функции.
 *
 * Идея: идём по очищенному тексту и храним стек открытых `{`. Для каждой `{` смотрим
 * на текст перед ней: если он похож на заголовок функции и мы не внутри другой функции —
 * это начало функции. Когда со стека снимается `{` функции, найден её конец.
 *
 * @param text исходный текст файла
 * @returns функции в порядке появления
 */
export function findFunctions(text: string): FunctionRange[] {
    const code = cleanCode(text);
    const result: FunctionRange[] = [];
    // стек открытых скобок: true — это `{` функции, false — обычный блок
    const stack: boolean[] = [];
    let insideFunction = false;
    let lastBoundary = 0; // позиция после последней `;`, `{` или `}`
    let pending: FunctionRange | null = null;

    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === '{') {
            let isFunc = false;
            if (!insideFunction) {
                const header = code.slice(lastBoundary, i);
                const parsed = parseHeader(header);
                if (parsed !== null) {
                    const headerStart = lastBoundary + parsed.start;
                    pending = {
                        name: parsed.name,
                        signature: text.slice(headerStart, i).replace(/\s+/g, ' ').trim(),
                        headerStart: headerStart,
                        open: i,
                        close: -1,
                        bodyLines: 0
                    };
                    isFunc = true;
                    insideFunction = true;
                }
            }
            stack.push(isFunc);
            lastBoundary = i + 1;
        } else if (c === '}') {
            const wasFunc = stack.pop();
            if (wasFunc === true && pending !== null) {
                pending.close = i;
                pending.bodyLines = countLines(code.slice(pending.open + 1, i));
                result.push(pending);
                pending = null;
                insideFunction = false;
            }
            lastBoundary = i + 1;
        } else if (c === ';') {
            lastBoundary = i + 1;
        }
    }
    return result;
}

/**
 * Возвращает отступ строки, в которой находится позиция pos (пробелы и табы в начале строки).
 */
export function indentAt(text: string, pos: number): string {
    let lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    let res = '';
    while (lineStart < text.length && (text[lineStart] === ' ' || text[lineStart] === '\t')) {
        res += text[lineStart];
        lineStart++;
    }
    return res;
}
