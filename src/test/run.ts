/**
 * Тесты поиска функций и игровой логики без VS Code: запуск `npm test`.
 */
import * as assert from 'assert';
import { findFunctions, indentAt } from '../parser';
import { makeEvent, summarize, suspiciousLines, isBigInsert, describeEvent } from '../journal';
import { allowedIndexes, pickTargets, hintLines, newAchievements, createExam, checkPin, examFinished, examAllWon, buildReport } from '../modes';
import { canTransition, pickIndex, pushRecent, formatTime, emptyStats, updateStats, placeholderBody, looksLikeOriginal } from '../game';

let passed = 0;

/** Запускает один тест и печатает результат. */
function test(title: string, body: () => void): void {
    body();
    passed++;
    console.log('OK  ' + title);
}

const sample = `#include <iostream>
// int fake(int x) { return x; }
int sum(int* a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) {
        s += a[i];
    }
    return s;
}

class Stack {
public:
    void push(int x) {
        data[size++] = x;
    }
    int top() const { return data[size - 1]; }
private:
    int data[100];
    int size = 0;
};

const char* hello() {
    return "{ not a brace }";
}

int main() {
    std::cout << sum(nullptr, 0);
    return 0;
}
`;

test('находит все функции, включая методы класса', () => {
    const names = findFunctions(sample).map(f => f.name);
    assert.deepStrictEqual(names, ['sum', 'push', 'top', 'hello', 'main']);
});

test('функция в комментарии не находится', () => {
    const names = findFunctions(sample).map(f => f.name);
    assert.ok(names.indexOf('fake') === -1);
});

test('границы тела: между { и } ровно тело функции', () => {
    const f = findFunctions(sample)[0];
    const body = sample.slice(f.open + 1, f.close);
    assert.ok(body.indexOf('int s = 0;') !== -1);
    assert.ok(body.indexOf('return s;') !== -1);
    assert.strictEqual(sample[f.open], '{');
    assert.strictEqual(sample[f.close], '}');
});

test('сигнатура в одну строку, без public:', () => {
    const fs = findFunctions(sample);
    assert.strictEqual(fs[0].signature, 'int sum(int* a, int n)');
    assert.strictEqual(fs[1].signature, 'void push(int x)');
    assert.strictEqual(fs[2].signature, 'int top() const');
});

test('скобки внутри строки не мешают', () => {
    const f = findFunctions(sample).find(x => x.name === 'hello');
    assert.ok(f);
    assert.ok(sample.slice(f.open, f.close + 1).indexOf('return') !== -1);
});

test('число строк тела', () => {
    const fs = findFunctions(sample);
    assert.strictEqual(fs[0].bodyLines, 5);
    assert.strictEqual(fs[2].bodyLines, 1);
});

test('отступ метода внутри класса', () => {
    const f = findFunctions(sample)[1];
    assert.strictEqual(indentAt(sample, f.headerStart), '    ');
});

test('конструктор со списком инициализации', () => {
    const fs = findFunctions('Vec::Vec(int n) : size_(n) {\n    data_ = new int[n];\n}\n');
    assert.strictEqual(fs.length, 1);
    assert.strictEqual(fs[0].name, 'Vec::Vec');
});

test('if и for внутри функции не считаются функциями', () => {
    const fs = findFunctions('void f(int n) {\n    if (n) { for (;;) { } }\n}\n');
    assert.deepStrictEqual(fs.map(x => x.name), ['f']);
});

test('переходы автомата', () => {
    assert.ok(canTransition('idle', 'spinning'));
    assert.ok(canTransition('solving', 'checking'));
    assert.ok(canTransition('solving', 'finished'));
    assert.ok(!canTransition('idle', 'solving'));
    assert.ok(!canTransition('checking', 'spinning'));
});

test('выбор функции не повторяет недавние', () => {
    const names = ['a', 'b', 'c', 'd'];
    for (let k = 0; k < 50; k++) {
        const i = pickIndex(names, ['a', 'b', 'c'], Math.random);
        assert.strictEqual(names[i], 'd');
    }
});

test('если все недавние — выбор из всех', () => {
    const i = pickIndex(['a', 'b'], ['a', 'b'], () => 0.99);
    assert.strictEqual(i, 1);
    assert.strictEqual(pickIndex([], [], Math.random), -1);
});

test('очередь недавних ограничена', () => {
    let r: string[] = [];
    r = pushRecent(r, 'a');
    r = pushRecent(r, 'b');
    r = pushRecent(r, 'c');
    r = pushRecent(r, 'd');
    assert.deepStrictEqual(r, ['b', 'c', 'd']);
    r = pushRecent(r, 'b');
    assert.deepStrictEqual(r, ['c', 'd', 'b']);
});

test('формат времени', () => {
    assert.strictEqual(formatTime(299), '04:59');
    assert.strictEqual(formatTime(600), '10:00');
    assert.strictEqual(formatTime(5), '00:05');
    assert.strictEqual(formatTime(-3), '00:00');
});

test('статистика: серия и лучшее время', () => {
    let s = emptyStats();
    s = updateStats(s, true, 200);
    s = updateStats(s, true, 150);
    s = updateStats(s, false, 0);
    s = updateStats(s, true, 180);
    assert.deepStrictEqual(s, { wins: 3, losses: 1, streak: 1, bestStreak: 2, bestSeconds: 150 });
});

test('заглушка вместо тела', () => {
    assert.strictEqual(placeholderBody('    '), '\n        // 🎰 TODO: напиши эту функцию заново!\n    ');
});

const original = `
    int s = 0;
    for (int i = 0; i < n; i++) {
        s += a[i];
    }
    return s;
`;

test('Ctrl+Z / вставка оригинала распознаётся как чит', () => {
    assert.ok(looksLikeOriginal(original, original));
    // другое форматирование тоже ловится
    assert.ok(looksLikeOriginal('int s=0; for(int i=0;i<n;i++){ s+=a[i]; }', original));
});

test('откат всего файла (оригинал внутри большой вставки) — чит', () => {
    const wholeFile = '#include <iostream>\nint sum(int* a, int n) {' + original + '}\nint main() { return 0; }\n';
    assert.ok(looksLikeOriginal(wholeFile, original));
});

test('обычный набор кода — не чит', () => {
    assert.ok(!looksLikeOriginal('s', original));
    assert.ok(!looksLikeOriginal('s += a[i];', original));
    assert.ok(!looksLikeOriginal('    // 🎰 TODO: напиши эту функцию заново!', original));
});

test('большая вставка своего (другого) кода — не чит', () => {
    assert.ok(!looksLikeOriginal('int total = 0;\nfor (int k = 0; k < n; ++k) total += a[k];\nreturn total;', original));
});

// ---------- журнал ----------

test('журнал: итоги и подозрительные моменты', () => {
    const events = [
        makeEvent(0, 'start', 0, 'sum'),
        makeEvent(30, 'focus', 45, ''),
        makeEvent(80, 'focus', 15, ''),
        makeEvent(90, 'paste', 120, ''),
        makeEvent(100, 'cheat', 0, 'sum'),
        makeEvent(150, 'closed', 200, ''),
        makeEvent(160, 'hint', 1, 'int s = 0;')
    ];
    const s = summarize(events);
    assert.deepStrictEqual(s, {
        focusLosses: 2, focusSeconds: 60, pastes: 1, pasteChars: 120,
        cheats: 1, restarts: 1, closedSeconds: 200, hints: 1
    });
    const lines = suspiciousLines(s);
    assert.strictEqual(lines.length, 5);
    assert.ok(lines[0].indexOf('2 раз') !== -1 && lines[0].indexOf('01:00') !== -1);
});

test('журнал: чистый раунд без подозрений', () => {
    assert.deepStrictEqual(suspiciousLines(summarize([makeEvent(0, 'start', 0, 'sum')])), []);
});

test('журнал: большая вставка и описание события', () => {
    assert.ok(!isBigInsert('s += a[i];'));
    assert.ok(isBigInsert('for (int i = 0; i < n; i++) { s += a[i] * a[i]; }'));
    assert.strictEqual(describeEvent(makeEvent(135, 'paste', 120, '')), '[02:15] 📋 Вставка 120 символов');
});

// ---------- сложность ----------

const funcsByLength = [
    { name: 'a', lines: 2 }, { name: 'b', lines: 4 }, { name: 'c', lines: 6 },
    { name: 'd', lines: 10 }, { name: 'e', lines: 20 }
];

test('сложность: лёгкий — короткие, адский — длинные', () => {
    assert.deepStrictEqual(allowedIndexes(funcsByLength, 'easy'), [0, 1, 2]);
    assert.deepStrictEqual(allowedIndexes(funcsByLength, 'medium'), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(allowedIndexes(funcsByLength, 'hard'), [2, 3, 4]);
});

test('сложность: на адском две разные функции', () => {
    for (let k = 0; k < 30; k++) {
        const t = pickTargets(funcsByLength, 'hard', []);
        assert.strictEqual(t.length, 2);
        assert.notStrictEqual(t[0], t[1]);
        assert.ok(funcsByLength[t[0]].lines >= 6 && funcsByLength[t[1]].lines >= 6);
    }
    assert.strictEqual(pickTargets([{ name: 'x', lines: 5 }], 'hard', []).length, 1);
    assert.strictEqual(pickTargets(funcsByLength, 'medium', []).length, 1);
    assert.deepStrictEqual(pickTargets([], 'medium', []), []);
});

test('сложность: недавние не выпадают', () => {
    for (let k = 0; k < 30; k++) {
        const t = pickTargets(funcsByLength, 'easy', ['a', 'b']);
        assert.deepStrictEqual(t, [2]);
    }
});

// ---------- подсказки ----------

test('подсказки: строки оригинала без пустых и одиночных скобок', () => {
    assert.deepStrictEqual(hintLines(original), ['int s = 0;', 'for (int i = 0; i < n; i++) {', 's += a[i];', 'return s;']);
});

// ---------- достижения ----------

test('достижения: быстрая победа без подсказок на адском', () => {
    const stats = { wins: 1, losses: 0, streak: 1, bestStreak: 1, bestSeconds: 40 };
    const got = newAchievements({
        win: true, seconds: 40, secondsLeft: 260, hints: 0, cheats: 0,
        difficulty: 'hard', stats: stats, examPassed: false
    }, []).map(a => a.id);
    assert.deepStrictEqual(got, ['first_win', 'lightning', 'brain', 'hell']);
});

test('достижения: уже открытые не повторяются, чит даёт «Пойман»', () => {
    const stats = { wins: 10, losses: 3, streak: 0, bestStreak: 4, bestSeconds: 40 };
    const got = newAchievements({
        win: false, seconds: 300, secondsLeft: 0, hints: 2, cheats: 1,
        difficulty: 'easy', stats: stats, examPassed: false
    }, ['marathon']).map(a => a.id);
    assert.deepStrictEqual(got, ['busted']);
});

// ---------- экзамен ----------

test('экзамен: PIN хранится только хешем', () => {
    const exam = createExam({
        student: 'Иванов Иван, M3118', rounds: 2, minutes: 5, difficulty: 'medium',
        hintsAllowed: false, checkCommand: 'ctest', pin: '4821'
    });
    assert.ok(JSON.stringify(exam).indexOf('4821') === -1);
    assert.ok(checkPin(exam, '4821'));
    assert.ok(!checkPin(exam, '0000'));
});

test('экзамен: конец, итог и отчёт', () => {
    const exam = createExam({
        student: 'Иванов Иван, M3118', rounds: 2, minutes: 5, difficulty: 'hard',
        hintsAllowed: true, checkCommand: '', pin: '4821'
    }, new Date(2026, 9, 19, 14, 0).getTime());
    exam.results.push({ functions: ['sum'], win: true, seconds: 95, total: 300, text: '', events: [makeEvent(0, 'start', 0, 'sum')] });
    assert.ok(!examFinished(exam));
    exam.results.push({ functions: ['merge', 'sort'], win: false, seconds: 300, total: 300, text: '',
        events: [makeEvent(10, 'focus', 40, ''), makeEvent(20, 'paste', 200, '')] });
    assert.ok(examFinished(exam));
    assert.ok(!examAllWon(exam));
    const report = buildReport(exam, 'algorithms.cpp', false, new Date(2026, 9, 19, 14, 20).getTime());
    assert.ok(report.indexOf('Иванов Иван, M3118') !== -1);
    assert.ok(report.indexOf('**1 из 2**') !== -1);
    assert.ok(report.indexOf('19.10.2026 14:00') !== -1);
    assert.ok(report.indexOf('Уходил из VS Code: 1 раз') !== -1);
    assert.ok(report.indexOf('[00:20] 📋 Вставка 200 символов') !== -1);
});

console.log('\nВсе тесты пройдены: ' + passed);
