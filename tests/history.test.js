import test from 'node:test';
import assert from 'node:assert/strict';

import {
    fileStatusLabel,
    formatCommitDate,
    patchLines,
    shortSha,
    summaryLine,
} from '../js/ui/history.js';

test('shortSha keeps seven characters and tolerates junk', () => {
    assert.equal(shortSha('0123456789abcdef'), '0123456');
    assert.equal(shortSha('abc'), 'abc');
    assert.equal(shortSha(null), '');
    assert.equal(shortSha(42), '');
});

test('summaryLine shows the first line, or a fallback', () => {
    assert.equal(summaryLine('Save spiral\n\nLonger body'), 'Save spiral');
    assert.equal(summaryLine('  padded  '), 'padded');
    assert.equal(summaryLine('\nbody only'), 'Untitled commit');
    assert.equal(summaryLine(''), 'Untitled commit');
    assert.equal(summaryLine(undefined), '');
});

test('formatCommitDate is empty when it cannot be read', () => {
    assert.equal(formatCommitDate(''), '');
    assert.equal(formatCommitDate(null), '');
    assert.equal(formatCommitDate('not a date'), '');
    assert.notEqual(formatCommitDate('2024-01-02T03:04:05Z'), '');
});

test('fileStatusLabel speaks in plain words', () => {
    assert.equal(fileStatusLabel('added'), 'Added');
    assert.equal(fileStatusLabel('removed'), 'Deleted');
    assert.equal(fileStatusLabel('modified'), 'Changed');
    assert.equal(fileStatusLabel('renamed'), 'Renamed');
    assert.equal(fileStatusLabel('copied'), 'Copied');
    assert.equal(fileStatusLabel(undefined), 'Changed');
});

test('patchLines labels headers, hunks and changed lines', () => {
    const patch = [
        '--- a/work/spiral/main.py',
        '+++ b/work/spiral/main.py',
        '@@ -1,3 +1,3 @@',
        ' print("hi")',
        '-print("bye")',
        '+print("hello")',
        '\\ No newline at end of file',
    ].join('\n');

    assert.deepEqual(
        patchLines(patch).map((line) => line.kind),
        ['meta', 'meta', 'hunk', 'context', 'del', 'add', 'meta'],
    );
});

test('patchLines keeps blank lines and rejects an empty patch', () => {
    assert.deepEqual(patchLines(''), []);
    assert.deepEqual(patchLines(null), []);

    const lines = patchLines('+one\n\n-two');
    assert.deepEqual(
        lines.map((line) => [line.kind, line.text]),
        [
            ['add', '+one'],
            ['context', ''],
            ['del', '-two'],
        ],
    );
});
