import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorLocation, errorNotes, errorHeadline } from '../js/error-report.js';

/**
 * These fixtures are the real values Pyodide reported for real mistakes, captured
 * by asking `sys.last_exc` in the worker. They are the contract with Python, so
 * they are worth pinning exactly.
 */

const SYNTAX = {
    type: 'SyntaxError',
    message: 'unterminated string literal (detected at line 3)',
    line: 3,
    column: 27,
    endColumn: 27,
    source: "    print f`Hi {name}! You're invited!`",
    notes: [],
};

const INDENT = {
    type: 'IndentationError',
    message: "expected an indented block after 'if' statement on line 1",
    line: 2,
    column: 1,
    endColumn: 6,
    source: 'print(1)\n',
    notes: [],
};

test('uses the offsets Python reports', () => {
    const location = errorLocation({ structured: SYNTAX });
    assert.deepEqual(location, { line: 3, column: 26, length: 1 });
});

test('handles a multi-character span from end_offset', () => {
    const location = errorLocation({ structured: INDENT });
    assert.deepEqual(location, { line: 2, column: 0, length: 6 });
});

test('treats a missing end_offset as one character', () => {
    const location = errorLocation({
        structured: { line: 4, column: 10, endColumn: null },
    });
    assert.deepEqual(location, { line: 4, column: 9, length: 1 });
});

test('treats a zero column as no column at all', () => {
    // CPython columns are 1-based, so 0 is not a real position. It used to be
    // clamped to the start of the line, which marked the wrong character.
    assert.equal(
        errorLocation({ structured: { line: 1, column: 0, endColumn: 1 }, detail: '' }),
        null,
    );
});

test('column 1 is the first character', () => {
    const location = errorLocation({ structured: { line: 1, column: 1, endColumn: 2 } });
    assert.deepEqual(location, { line: 1, column: 0, length: 2 });
});

test('falls back to the marker line when there is no structured detail', () => {
    const detail = [
        '  File "<exec>", line 6',
        '    print f`Hi {name}! You\'re invited!`',
        '                          ^',
        'SyntaxError: unterminated string literal (detected at line 6)',
    ].join('\n');
    const location = errorLocation({ structured: null, detail });
    assert.ok(location);
    assert.equal(location.line, 6);
    assert.equal(location.length, 1);
});

test('has no location for a runtime error', () => {
    assert.equal(
        errorLocation({ structured: { type: 'NameError', line: null }, detail: 'NameError: x' }),
        null,
    );
    assert.equal(errorLocation({}), null);
});

test('shows notes Python attached, in its own words', () => {
    const notes = errorNotes({
        structured: {
            notes: ['The module numpy is not available.', '  '],
        },
    });
    assert.deepEqual(notes, ['The module numpy is not available.']);
    assert.deepEqual(errorNotes({}), []);
});

test('keeps Python’s own suggestion, which is in the traceback line', () => {
    assert.equal(
        errorHeadline({ summary: "NameError: name 'totl' is not defined. Did you mean: 'total'?" }),
        "NameError: name 'totl' is not defined. Did you mean: 'total'?",
    );
});

test('builds a headline from structured data when no summary is given', () => {
    assert.equal(
        errorHeadline({ structured: { type: 'NameError', message: "name 'x' is not defined" } }),
        "NameError: name 'x' is not defined",
    );
});

test('has a last resort', () => {
    assert.equal(errorHeadline({}), 'Python stopped on an error.');
});
