/**
 * Сложность, подсказки, достижения и режим экзамена.
 * Не зависит от VS Code (кроме модуля crypto из Node.js), поэтому проверяется тестами.
 */
import * as crypto from 'crypto';
import { formatTime, Stats } from './game';
import { JournalEvent, JournalSummary, summarize, suspiciousLines, describeEvent } from './journal';

// ======================= сложность =======================

/** Уровень сложности. */
export type Difficulty = 'easy' | 'medium' | 'hard';

/** Название уровня для экрана и отчёта. */
export const DIFFICULTY_NAMES: Record<Difficulty, string> = {
    easy: '🟢 Лёгкий',
    medium: '🟡 Средний',
    hard: '🔴 Адский'
};

/** Функция-кандидат: имя и длина тела. */
export interface Candidate {
    name: string;
    lines: number;
}

/**
 * Какие функции могут выпасть на этом уровне.
 * - лёгкий: короткие — не длиннее медианы по файлу;
 * - средний: все;
 * - адский: длинные — не короче медианы.
 * @returns индексы подходящих функций (если отбор пуст — все)
 */
export function allowedIndexes(funcs: Candidate[], level: Difficulty): number[] {
    const all: number[] = [];
    for (let i = 0; i < funcs.length; i++) {
        all.push(i);
    }
    if (level === 'medium' || funcs.length === 0) {
        return all;
    }
    // медиана длины тела
    const sorted = funcs.map(f => f.lines).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const res = all.filter(i => level === 'easy' ? funcs[i].lines <= median : funcs[i].lines >= median);
    return res.length > 0 ? res : all;
}

/** Сколько функций стирается за раунд: на адском — две (если в файле их хватает). */
export function targetsCount(level: Difficulty, available: number): number {
    return level === 'hard' && available >= 2 ? 2 : 1;
}

/**
 * Выбирает функции для раунда с учётом сложности и недавно выпавших.
 * @param funcs все кандидаты
 * @param level сложность
 * @param recent недавно выпавшие имена
 * @param random генератор случайных чисел
 * @returns индексы выбранных функций (одна или две, без повторов)
 */
export function pickTargets(funcs: Candidate[], level: Difficulty, recent: string[],
                            random: () => number = Math.random): number[] {
    const allowed = allowedIndexes(funcs, level);
    // сначала те, что недавно не выпадали
    let pool = allowed.filter(i => recent.indexOf(funcs[i].name) === -1);
    if (pool.length < targetsCount(level, allowed.length)) {
        pool = allowed.slice();
    }
    const count = Math.min(targetsCount(level, funcs.length), pool.length);
    const res: number[] = [];
    while (res.length < count) {
        const k = Math.min(Math.floor(random() * pool.length), pool.length - 1);
        res.push(pool[k]);
        pool.splice(k, 1);
    }
    return res;
}

// ======================= подсказки =======================

/** Штраф за подсказку (секунды). */
export const HINT_PENALTY = 60;

/**
 * Непустые строки оригинала, которые можно показывать как подсказки (без одиночных скобок).
 */
export function hintLines(originalBody: string): string[] {
    const res: string[] = [];
    const lines = originalBody.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t !== '' && t !== '{' && t !== '}') {
            res.push(t);
        }
    }
    return res;
}

// ======================= достижения =======================

/** Описание достижения. */
export interface Achievement {
    id: string;
    icon: string;
    title: string;
    description: string;
}

/** Все достижения. */
export const ACHIEVEMENTS: Achievement[] = [
    { id: 'first_win', icon: '🩸', title: 'Первая кровь', description: 'Первая победа' },
    { id: 'lightning', icon: '⚡', title: 'Молния', description: 'Победа меньше чем за минуту' },
    { id: 'last_second', icon: '⏱', title: 'На последней секунде', description: 'Победа, когда оставалось ≤ 10 секунд' },
    { id: 'brain', icon: '🧠', title: 'Сам с усами', description: 'Победа без подсказок на среднем или адском уровне' },
    { id: 'hell', icon: '😈', title: 'Из ада', description: 'Победа на адском уровне' },
    { id: 'streak5', icon: '🔥', title: 'В ударе', description: '5 побед подряд' },
    { id: 'marathon', icon: '🏃', title: 'Марафонец', description: '10 побед всего' },
    { id: 'busted', icon: '🚨', title: 'Пойман', description: 'Попался на Ctrl+Z' },
    { id: 'exam', icon: '🎓', title: 'Экзамен сдан', description: 'Все раунды экзамена выиграны' }
];

/** Всё, что нужно знать о раунде, чтобы выдать достижения. */
export interface RoundOutcome {
    win: boolean;
    seconds: number;
    secondsLeft: number;
    hints: number;
    cheats: number;
    difficulty: Difficulty;
    /** Статистика уже после этого раунда. */
    stats: Stats;
    /** Это последний раунд экзамена и все раунды выиграны. */
    examPassed: boolean;
}

/**
 * Какие достижения открылись в этом раунде.
 * @param o итоги раунда
 * @param unlocked уже открытые достижения (id)
 * @returns новые достижения
 */
export function newAchievements(o: RoundOutcome, unlocked: string[]): Achievement[] {
    const earned: string[] = [];
    if (o.win) {
        earned.push('first_win');
        if (o.seconds < 60) {
            earned.push('lightning');
        }
        if (o.secondsLeft <= 10) {
            earned.push('last_second');
        }
        if (o.hints === 0 && o.difficulty !== 'easy') {
            earned.push('brain');
        }
        if (o.difficulty === 'hard') {
            earned.push('hell');
        }
    }
    if (o.stats.streak >= 5) {
        earned.push('streak5');
    }
    if (o.stats.wins >= 10) {
        earned.push('marathon');
    }
    if (o.cheats > 0) {
        earned.push('busted');
    }
    if (o.examPassed) {
        earned.push('exam');
    }
    return ACHIEVEMENTS.filter(a => earned.indexOf(a.id) !== -1 && unlocked.indexOf(a.id) === -1);
}

// ======================= экзамен =======================

/** Настройки экзамена, которые задаёт практик. */
export interface ExamConfig {
    student: string;
    rounds: number;
    minutes: number;
    difficulty: Difficulty;
    hintsAllowed: boolean;
    /** Команда проверки, зафиксированная на момент старта (студент не может её подменить). */
    checkCommand: string;
    /** Соль и хеш PIN-кода практика: сам PIN нигде не хранится. */
    salt: string;
    pinHash: string;
    startedAt: number;
}

/** Результат одного раунда экзамена. */
export interface RoundResult {
    functions: string[];
    win: boolean;
    seconds: number;
    total: number;
    text: string;
    events: JournalEvent[];
}

/** Экзамен целиком: настройки и результаты сыгранных раундов. */
export interface Exam {
    config: ExamConfig;
    results: RoundResult[];
    /**
     * Результат последнего раунда, закрытый замком: студент его не видит,
     * пока практик не введёт PIN. undefined — замка нет.
     */
    sealed?: object;
    /** Сколько раз на замке ввели неверный PIN. */
    wrongPins?: number;
}

/** Хеш PIN-кода с солью (SHA-256). */
export function hashPin(pin: string, salt: string): string {
    return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}

/** Создаёт новый экзамен; PIN превращается в хеш. */
export function createExam(settings: {
    student: string; rounds: number; minutes: number; difficulty: Difficulty;
    hintsAllowed: boolean; checkCommand: string; pin: string;
}, now: number = Date.now()): Exam {
    const salt = crypto.randomBytes(8).toString('hex');
    return {
        config: {
            student: settings.student,
            rounds: settings.rounds,
            minutes: settings.minutes,
            difficulty: settings.difficulty,
            hintsAllowed: settings.hintsAllowed,
            checkCommand: settings.checkCommand,
            salt: salt,
            pinHash: hashPin(settings.pin, salt),
            startedAt: now
        },
        results: []
    };
}

/** Верный ли PIN. */
export function checkPin(exam: Exam, pin: string): boolean {
    return hashPin(pin, exam.config.salt) === exam.config.pinHash;
}

/** Закончен ли экзамен (сыграны все раунды). */
export function examFinished(exam: Exam): boolean {
    return exam.results.length >= exam.config.rounds;
}

/** Все ли раунды выиграны. */
export function examAllWon(exam: Exam): boolean {
    return examFinished(exam) && exam.results.every(r => r.win);
}

/** Дата и время в виде `19.10.2026 14:05`. */
function formatDate(ms: number): string {
    const d = new Date(ms);
    const two = (n: number) => (n < 10 ? '0' : '') + n;
    return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' +
        two(d.getHours()) + ':' + two(d.getMinutes());
}

/**
 * Собирает отчёт экзамена в формате Markdown.
 * @param exam экзамен с результатами
 * @param fileName файл, с которым шла игра
 * @param interrupted экзамен остановлен практиком досрочно
 * @param now время окончания
 */
export function buildReport(exam: Exam, fileName: string, interrupted: boolean, now: number = Date.now()): string {
    const c = exam.config;
    const wins = exam.results.filter(r => r.win).length;
    const lines: string[] = [];
    lines.push('# 🎰 Отчёт Code Roulette');
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    lines.push('| **Студент** | ' + c.student + ' |');
    lines.push('| **Файл** | `' + fileName + '` |');
    lines.push('| **Начало** | ' + formatDate(c.startedAt) + ' |');
    lines.push('| **Конец** | ' + formatDate(now) + (interrupted ? ' (остановлен практиком)' : '') + ' |');
    lines.push('| **Сложность** | ' + DIFFICULTY_NAMES[c.difficulty] + ' |');
    lines.push('| **Время на раунд** | ' + c.minutes + ' мин |');
    lines.push('| **Подсказки** | ' + (c.hintsAllowed ? 'разрешены' : 'запрещены') + ' |');
    lines.push('| **Проверка** | ' + (c.checkCommand === '' ? 'по времени' : '`' + c.checkCommand + '`') + ' |');
    lines.push('| **Итог** | **' + wins + ' из ' + c.rounds + '** раундов выиграно |');
    lines.push('');
    lines.push('## Раунды');
    lines.push('');
    lines.push('| № | Функции | Результат | Время | Подозрительное |');
    lines.push('|---|---|---|---|---|');
    for (let i = 0; i < exam.results.length; i++) {
        const r = exam.results[i];
        const sus = suspiciousLines(summarize(r.events));
        lines.push('| ' + (i + 1) + ' | `' + r.functions.join('`, `') + '` | ' + (r.win ? '✅ победа' : '❌ поражение') +
            ' | ' + formatTime(r.seconds) + ' / ' + formatTime(r.total) + ' | ' + (sus.length === 0 ? '—' : sus.join('<br>')) + ' |');
    }
    lines.push('');
    lines.push('## Журнал событий');
    for (let i = 0; i < exam.results.length; i++) {
        lines.push('');
        lines.push('### Раунд ' + (i + 1));
        lines.push('');
        lines.push('```');
        const events = exam.results[i].events;
        for (let k = 0; k < events.length; k++) {
            lines.push(describeEvent(events[k]));
        }
        lines.push('```');
    }
    lines.push('');
    lines.push('> Журнал фиксирует уходы из VS Code, большие вставки, попытки Ctrl+Z и закрытие VS Code.');
    lines.push('> Он показывает подозрительные моменты, но не является доказательством: надёжнее всего —');
    lines.push('> проводить экзамен вживую.');
    return lines.join('\n') + '\n';
}

/** Итоги журнала одного раунда (реэкспорт для удобства). */
export function roundSummary(events: JournalEvent[]): JournalSummary {
    return summarize(events);
}
