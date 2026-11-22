import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lineFromTraceback } from '../js/traceback.js';

test('lineFromTraceback reads a single user frame', () => {
    const text = [
        'Traceback (most recent call last):',
        '  File "<exec>", line 4, in <module>',
        'ZeroDivisionError: division by zero',
    ].join('\n');

    assert.equal(lineFromTraceback(text), 4);
});

test('lineFromTraceback reads a synthetic main.py frame', () => {
    const text = [
        'Traceback (most recent call last):',
        '  File "/home/pyodide/main.py", line 12, in greet',
        '    return 1 / 0',
        'ZeroDivisionError: division by zero',
    ].join('\n');

    assert.equal(lineFromTraceback(text), 12);
});

test('lineFromTraceback picks the last user frame in a multi-frame traceback', () => {
    const text = [
        'Traceback (most recent call last):',
        '  File "<exec>", line 4, in <module>',
        '  File "<exec>", line 12, in greet',
        '  File "/lib/python3.11/json/__init__.py", line 346, in loads',
        '  File "/lib/python3.11/json/decoder.py", line 337, in decode',
        'ValueError: Expecting value: line 1 column 1 (char 0)',
    ].join('\n');

    assert.equal(lineFromTraceback(text), 12);
});

test('lineFromTraceback ignores stdlib-only frames', () => {
    const text = [
        'Traceback (most recent call last):',
        '  File "/lib/python3.11/site-packages/pkg/core.py", line 8, in run',
        '  File "/usr/lib/python3.11/json/__init__.py", line 12, in dumps',
        '  File "<frozen importlib._bootstrap>", line 1075, in _find_and_load',
        'ImportError: no module named pkg',
    ].join('\n');

    assert.equal(lineFromTraceback(text), null);
});

test('lineFromTraceback handles SyntaxError frames without an in-clause', () => {
    const text = [
        'Traceback (most recent call last):',
        '  File "<exec>", line 7',
        '    if True',
        '        print("x")',
        'IndentationError: unexpected indent',
    ].join('\n');

    assert.equal(lineFromTraceback(text), 7);
});

test('lineFromTraceback returns null when no line number is present', () => {
    const text = [
        'Traceback (most recent call last):',
        '  File "<exec>", in <module>',
        'NameError: name "x" is not defined',
    ].join('\n');

    assert.equal(lineFromTraceback(text), null);
});

test('lineFromTraceback returns null for text that is not a traceback', () => {
    assert.equal(lineFromTraceback('Hello, World!'), null);
    assert.equal(lineFromTraceback(''), null);
    assert.equal(lineFromTraceback('Error: division by zero'), null);
});
