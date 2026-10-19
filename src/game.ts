/**
 * Игровая логика рулетки: состояния игры, выбор функции, таймер, статистика.
 * Не зависит от VS Code, поэтому проверяется обычными тестами.
 */

/** Состояние игры. */
export type GameState = 'idle' | 'spinning' | 'solving' | 'checking' | 'finished';

/**
 * Таблица допустимых переходов конечного автомата.
 * Например, из `solving` можно перейти в `checking` (нажал «Готово»)
 * или сразу в `finished` (время вышло или сдался).
 */
const TRANSITIONS = new Map<GameState, GameState[]>([
    ['idle', ['spinning']],
    ['spinning', ['solving', 'idle']],
    ['solving', ['checking', 'finished']],
    ['checking', ['finished']],
    ['finished', ['idle', 'spinning']]
]);

/** Проверяет, можно ли перейти из состояния from в состояние to. */
export function canTransition(from: GameState, to: GameState): boolean {
    const allowed = TRANSITIONS.get(from);
    return allowed !== undefined && allowed.indexOf(to) !== -1;
}

/** Сколько последних выпавших функций не должны выпадать снова. */
export const RECENT_LIMIT = 3;

/**
 * Выбирает случайную функцию, стараясь не повторять недавно выпавшие.
 * @param names имена функций-кандидатов
 * @param recent очередь недавно выпавших имён (самое старое — первое)
 * @param random генератор случайного числа от 0 до 1 (для тестов можно подставить свой)
 * @returns индекс выбранной функции в names или -1, если список пуст
 */
export function pickIndex(names: string[], recent: string[], random: () => number = Math.random): number {
    if (names.length === 0) {
        return -1;
    }
    const candidates: number[] = [];
    for (let i = 0; i < names.length; i++) {
        if (recent.indexOf(names[i]) === -1) {
            candidates.push(i);
        }
    }
    // если все функции недавно выпадали — выбираем из всех
    if (candidates.length === 0) {
        for (let i = 0; i < names.length; i++) {
            candidates.push(i);
        }
    }
    const k = Math.floor(random() * candidates.length);
    return candidates[Math.min(k, candidates.length - 1)];
}

/**
 * Добавляет имя в очередь недавних; если очередь длиннее RECENT_LIMIT — удаляет самое старое.
 * @returns новая очередь
 */
export function pushRecent(recent: string[], name: string): string[] {
    const res = recent.filter(x => x !== name);
    res.push(name);
    while (res.length > RECENT_LIMIT) {
        res.shift();
    }
    return res;
}

/** Переводит секунды в строку `ММ:СС`: 299 → `04:59`. */
export function formatTime(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (rest < 10 ? '0' : '') + rest;
}

/** Статистика игрока. */
export interface Stats {
    wins: number;
    losses: number;
    /** Сколько побед подряд сейчас. */
    streak: number;
    /** Лучшая серия побед подряд. */
    bestStreak: number;
    /** Лучшее время победы в секундах (0 — побед ещё не было). */
    bestSeconds: number;
}

/** Пустая статистика для нового игрока. */
export function emptyStats(): Stats {
    return { wins: 0, losses: 0, streak: 0, bestStreak: 0, bestSeconds: 0 };
}

/**
 * Обновляет статистику после игры.
 * @param stats старая статистика (не изменяется)
 * @param win победа или поражение
 * @param seconds за сколько секунд решено (важно только для победы)
 * @returns новая статистика
 */
export function updateStats(stats: Stats, win: boolean, seconds: number): Stats {
    const res: Stats = {
        wins: stats.wins,
        losses: stats.losses,
        streak: stats.streak,
        bestStreak: stats.bestStreak,
        bestSeconds: stats.bestSeconds
    };
    if (win) {
        res.wins++;
        res.streak++;
        if (res.streak > res.bestStreak) {
            res.bestStreak = res.streak;
        }
        if (res.bestSeconds === 0 || seconds < res.bestSeconds) {
            res.bestSeconds = seconds;
        }
    } else {
        res.losses++;
        res.streak = 0;
    }
    return res;
}

/** Штраф за попытку вернуть оригинал (секунды). */
export const CHEAT_PENALTY = 30;

/** Минимальная длина вставки (без пробелов), которую считаем подозрительной. */
const CHEAT_MIN_CHARS = 30;

/** Убирает все пробелы и переводы строк: так сравнение не зависит от форматирования. */
function compact(text: string): string {
    return text.replace(/\s+/g, '');
}

/**
 * Похожа ли одна правка на возврат стёртого оригинала.
 * Человек печатает по несколько символов, а Ctrl+Z, вставка из буфера или откат файла
 * вставляют сразу большой кусок. Если вставлено много (≥ 30 символов без пробелов)
 * и этот кусок целиком есть в оригинальном теле функции (или наоборот, оригинал целиком
 * лежит внутри вставки) — это читерство.
 * @param inserted текст, вставленный одной правкой
 * @param originalBody исходное тело функции
 */
export function looksLikeOriginal(inserted: string, originalBody: string): boolean {
    const part = compact(inserted);
    const orig = compact(originalBody);
    if (part.length < CHEAT_MIN_CHARS || orig.length === 0) {
        return false;
    }
    // кусок оригинала (Ctrl+Z, вставка части) или вставка, внутри которой весь оригинал
    // (откат всего файла, вставка целого файла из резервной копии)
    return orig.indexOf(part) !== -1 || part.indexOf(orig) !== -1;
}

/**
 * Текст, который ставится вместо стёртого тела функции.
 * @param indent отступ строки с заголовком функции
 */
export function placeholderBody(indent: string): string {
    return '\n' + indent + '    // 🎰 TODO: напиши эту функцию заново!\n' + indent;
}
