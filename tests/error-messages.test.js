import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syntaxErrorSpan } from '../js/error-span.js';
import { hintFor } from '../js/error-hints.js';

/** The traceback from a real student mistake, copied verbatim. */
const SYNTAX = [
    'Traceback (most recent call last):',
    '  File "/lib/python312.zip/_pyodide/_base.py", line 597, in eval_code_async',
    '    await CodeRunner(',
    '  File "<exec>", line 6',
    '    print f`Hi {name}! You\'re invited to my birthday party!`',
    '                          ^',
    'SyntaxError: unterminated string literal (detected at line 6)',
].join('\n');

test('finds the caret position of a syntax error', () => {
    const span = syntaxErrorSpan(SYNTAX);
    assert.ok(span, 'expected a span');
    assert.equal(span.line, 6);
    assert.equal(span.length, 1);
    // The caret sits under the apostrophe in "You're": the backtick is not a
    // quote to Python, so it sees a string starting at that apostrophe and never
    // ending. Worth pinning, because it is where Python actually stopped.
    assert.equal(span.sourceLine, 'print f`Hi {name}! You\'re invited to my birthday party!`');
    assert.equal(span.sourceLine[span.column], "'");
    assert.equal(span.sourceLine.slice(span.column, span.column + 6), "'re in");
});

test('handles a multi-character span', () => {
    const text = [
        '  File "<exec>", line 3',
        '    x = (1 +',
        '         ^^^',
        'SyntaxError: something',
    ].join('\n');
    const span = syntaxErrorSpan(text);
    assert.ok(span);
    assert.equal(span.line, 3);
    assert.equal(span.column, 5);
    assert.equal(span.length, 3);
});

test('returns null for a runtime error with no caret', () => {
    const text = [
        'Traceback (most recent call last):',
        '  File "<exec>", line 2, in <module>',
        'NameError: name "x" is not defined',
    ].join('\n');
    assert.equal(syntaxErrorSpan(text), null);
});

test('returns null when the caret has no source line above it', () => {
    assert.equal(syntaxErrorSpan('    ^\nSyntaxError: whatever'), null);
});

test('returns null for junk', () => {
    assert.equal(syntaxErrorSpan(''), null);
    assert.equal(syntaxErrorSpan(null), null);
    assert.equal(syntaxErrorSpan('not a traceback at all'), null);
});

test('ignores a caret that is part of prose rather than a marker', () => {
    const text = ['  File "<exec>", line 1', '  2 ^ 3 is bitwise xor', 'ValueError: nope'].join('\n');
    assert.equal(syntaxErrorSpan(text), null);
});

test('explains an unterminated string and points at the caret', () => {
    const result = hintFor('SyntaxError: unterminated string literal (detected at line 6)');
    assert.ok(result);
    assert.match(result.hint, /quotation mark is never closed/i);
});

test('names the missing variable', () => {
    const result = hintFor('NameError: name \'total\' is not defined');
    assert.ok(result);
    assert.equal(result.name, 'total');
    assert.match(result.hint, /"total" has not been given a value/);
});

test('explains a missing module without pretending it can be installed', () => {
    const result = hintFor('ModuleNotFoundError: No module named \'numpy\'');
    assert.ok(result);
    assert.match(result.hint, /"numpy" is not included in pydle/);
});

test('covers the common beginner errors', () => {
    for (const [summary, expected] of [
        ['ZeroDivisionError: division by zero', /divide by zero/],
        ['IndentationError: expected an indented block', /indentation/i],
        ['TypeError: can only concatenate str (not "int") to str', /wrong type/i],
        ['IndexError: list index out of range', /past the end/],
        ['KeyError: \'colour\'', /colour/],
        ['SyntaxError: expected \':\'', /colon/],
    ]) {
        const result = hintFor(summary);
        assert.ok(result, `no hint for ${summary}`);
        assert.match(result.hint, expected);
    }
});

test('stays quiet when it does not recognise the error', () => {
    assert.equal(hintFor('KeyboardInterrupt'), null);
    assert.equal(hintFor(''), null);
    assert.equal(hintFor(null), null);
});
