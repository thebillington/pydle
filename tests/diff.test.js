import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, diffStats } from '../js/diff.js';

const kinds = (lines) => lines.map((line) => line.type[0]).join('');

test('identical files produce no changes', () => {
    const lines = diffLines('a\nb\n', 'a\nb\n');
    assert.equal(kinds(lines), 'cc');
    assert.deepEqual(diffStats(lines), { added: 0, removed: 0 });
});

test('an added line is marked added', () => {
    const lines = diffLines('a\nc\n', 'a\nb\nc\n');
    assert.equal(kinds(lines), 'cac');
    assert.deepEqual(diffStats(lines), { added: 1, removed: 0 });
    assert.equal(lines[1].text, 'b');
    assert.equal(lines[1].after, 2);
    assert.equal(lines[1].before, null);
});

test('a removed line is marked removed', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nc\n');
    assert.equal(kinds(lines), 'crc');
    assert.deepEqual(diffStats(lines), { added: 0, removed: 1 });
    assert.equal(lines[1].text, 'b');
    assert.equal(lines[1].before, 2);
});

test('a changed line shows as one removal and one addition', () => {
    const lines = diffLines('print(1)\n', 'print(2)\n');
    assert.equal(kinds(lines), 'ra');
    assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
});

test('a new file is entirely additions', () => {
    const lines = diffLines(null, 'one\ntwo\n');
    assert.equal(kinds(lines), 'aa');
    assert.deepEqual(diffStats(lines), { added: 2, removed: 0 });
});

test('a deleted file is entirely removals', () => {
    const lines = diffLines('one\ntwo\n', null);
    assert.equal(kinds(lines), 'rr');
    assert.deepEqual(diffStats(lines), { added: 0, removed: 2 });
});

test('line numbers are 1-based on the side that has the line', () => {
    const lines = diffLines('a\nb\n', 'a\nx\nb\n');
    const added = lines.find((line) => line.type === 'added');
    assert.ok(added);
    assert.equal(added.after, 2);
    assert.equal(added.before, null);
});

test('a trailing newline does not invent an empty line', () => {
    assert.equal(diffLines('a\n', 'a\n').length, 1);
    assert.equal(diffLines('a', 'a\n').length, 1);
});

test('CRLF and LF compare equal', () => {
    assert.equal(kinds(diffLines('a\r\nb\r\n', 'a\nb\n')), 'cc');
});

test('an unchanged file with many lines stays cheap', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const start = Date.now();
    const lines = diffLines(text, text);
    assert.equal(lines.length, 500);
    assert.ok(Date.now() - start < 2000, 'diff should be quick');
});

test('a very large file falls back without throwing', () => {
    const big = Array.from({ length: 2100 }, (_, i) => `l${i}`).join('\n');
    const lines = diffLines(big, `${big}\nextra`);
    // Everything is shown as removed then re-added: unreadable, but honest, and it
    // does not allocate a 4.4 million cell table.
    assert.equal(lines.length, 4201);
    assert.deepEqual(diffStats(lines), { added: 2101, removed: 2100 });
});
