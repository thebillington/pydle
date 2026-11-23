import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitAround, normaliseSource } from '../js/error-block.js';
import { errorLocation } from '../js/error-report.js';

const LINE = "print f`Hi {name}! You're invited to my birthday party!`";

test('marks exactly the character Python pointed at', () => {
    // The real pipeline: Python reports a 1-based offset against the indented
    // line, errorLocation turns that into a 0-based column, and normaliseSource
    // moves it again when the indent is trimmed for display.
    const structured = { line: 3, column: 27, endColumn: 27, source: '    ' + LINE };
    const located = errorLocation({ structured });
    const { sourceLine, location } = normaliseSource(structured.source, located);

    assert.equal(sourceLine, LINE);
    assert.equal(location.column, LINE.indexOf("'"));
    const parts = splitAround(sourceLine, location);
    assert.equal(parts.marked, "'");
});

test('marks a multi-character span', () => {
    const parts = splitAround('print(1)', { line: 2, column: 0, length: 6 });
    assert.equal(parts.marked, 'print(');
    assert.equal(parts.after, '1)');
});

test('clamps a span that runs past the end of the line', () => {
    const parts = splitAround('abc', { line: 1, column: 1, length: 99 });
    assert.equal(parts.marked, 'bc');
    assert.equal(parts.after, '');
});

test('handles a negative or nonsense column', () => {
    const parts = splitAround('abc', { line: 1, column: -5, length: 1 });
    assert.equal(parts.marked, 'a');
    assert.equal(parts.before, '');
});

test('returns the whole line unmarked when there is no location', () => {
    assert.deepEqual(splitAround('abc', null), { before: 'abc', marked: '', after: '' });
});

test('copes with a missing line', () => {
    assert.deepEqual(splitAround('', { line: 1, column: 0, length: 1 }), {
        before: '',
        marked: '',
        after: '',
    });
});

test('keeps the highlight on the fault after trimming the indent', () => {
    const raw = "    print f`Hi {name}! You're invited!`";
    const { sourceLine, location } = normaliseSource(raw, { line: 3, column: 26, length: 1 });
    assert.equal(sourceLine.indexOf("'"), 22);
    assert.equal(location.column, 22);
    assert.equal(splitAround(sourceLine, location).marked, "'");
});

test('a line with no indentation is unchanged', () => {
    const located = errorLocation({ structured: { line: 2, column: 1, endColumn: 6 } });
    const { sourceLine, location } = normaliseSource('print(1)\n', located);
    assert.equal(sourceLine, 'print(1)');
    assert.equal(location.column, 0);
    assert.equal(location.length, 6);
});
