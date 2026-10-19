/**
 * Журнал раунда: что происходило, пока студент писал функцию.
 * Не зависит от VS Code, поэтому проверяется обычными тестами.
 */
import { formatTime } from './game';

/** Вид события в журнале. */
export type EventKind = 'start' | 'focus' | 'paste' | 'cheat' | 'closed' | 'hint' | 'finish';

/** Одно событие журнала. */
export interface JournalEvent {
    /** Секунда от начала раунда. */
    at: number;
    kind: EventKind;
    /** Число: секунды (уход, закрытие), символы (вставка), номер подсказки. */
    value: number;
    /** Пояснение: имена функций, результат и т.п. */
    text: string;
}

/** Итоги журнала одним объектом — для отчёта и экрана результата. */
export interface JournalSummary {
    focusLosses: number;
    focusSeconds: number;
    pastes: number;
    pasteChars: number;
    cheats: number;
    restarts: number;
    closedSeconds: number;
    hints: number;
}

/** Минимальный размер вставки (символов без пробелов), которую записываем в журнал. */
export const BIG_INSERT = 30;

/** Уход из VS Code короче этого (секунд) не записываем — это случайный клик. */
export const MIN_FOCUS_LOSS = 3;

/** Сколько непробельных символов в тексте. */
export function countChars(text: string): number {
    return text.replace(/\s+/g, '').length;
}

/** Большая ли вставка: человек так быстро не печатает. */
export function isBigInsert(text: string): boolean {
    return countChars(text) >= BIG_INSERT;
}

/** Создаёт событие. */
export function makeEvent(at: number, kind: EventKind, value: number, text: string): JournalEvent {
    return { at: Math.max(0, Math.floor(at)), kind: kind, value: value, text: text };
}

/**
 * Считает итоги по списку событий.
 * @param events события раунда
 */
export function summarize(events: JournalEvent[]): JournalSummary {
    const s: JournalSummary = {
        focusLosses: 0, focusSeconds: 0, pastes: 0, pasteChars: 0,
        cheats: 0, restarts: 0, closedSeconds: 0, hints: 0
    };
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.kind === 'focus') {
            s.focusLosses++;
            s.focusSeconds += e.value;
        } else if (e.kind === 'paste') {
            s.pastes++;
            s.pasteChars += e.value;
        } else if (e.kind === 'cheat') {
            s.cheats++;
        } else if (e.kind === 'closed') {
            s.restarts++;
            s.closedSeconds += e.value;
        } else if (e.kind === 'hint') {
            s.hints++;
        }
    }
    return s;
}

/**
 * Список подозрительных моментов человеческим языком (пустой — всё чисто).
 * @param s итоги журнала
 */
export function suspiciousLines(s: JournalSummary): string[] {
    const res: string[] = [];
    if (s.focusLosses > 0) {
        res.push('🪟 Уходил из VS Code: ' + s.focusLosses + ' раз, всего ' + formatTime(s.focusSeconds));
    }
    if (s.pastes > 0) {
        res.push('📋 Большие вставки: ' + s.pastes + ' шт., ' + s.pasteChars + ' символов');
    }
    if (s.cheats > 0) {
        res.push('🚫 Пытался вернуть оригинал (Ctrl+Z / вставка): ' + s.cheats + ' раз');
    }
    if (s.restarts > 0) {
        res.push('🔌 Закрывал VS Code: ' + s.restarts + ' раз, всего ' + formatTime(s.closedSeconds));
    }
    if (s.hints > 0) {
        res.push('💡 Подсказок взято: ' + s.hints);
    }
    return res;
}

/** Описание одного события одной строкой: `[02:15] 📋 Вставка 120 символов`. */
export function describeEvent(e: JournalEvent): string {
    let what = '';
    switch (e.kind) {
        case 'start': what = '🎰 Старт: ' + e.text; break;
        case 'focus': what = '🪟 Ушёл из VS Code на ' + formatTime(e.value); break;
        case 'paste': what = '📋 Вставка ' + e.value + ' символов'; break;
        case 'cheat': what = '🚫 Попытка вернуть оригинал'; break;
        case 'closed': what = '🔌 VS Code был закрыт ' + formatTime(e.value); break;
        case 'hint': what = '💡 Подсказка №' + e.value + ': ' + e.text; break;
        case 'finish': what = '🏁 ' + e.text; break;
    }
    return '[' + formatTime(e.at) + '] ' + what;
}
