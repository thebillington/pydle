import test from 'node:test';
import assert from 'node:assert/strict';

import { discardConfirmation } from '../js/ui/turtle-storage.js';

test('names the drawing and says there is no way back', () => {
    const { title, message } = discardConfirmation({
        name: 'my-spiral',
        paths: ['main.py'],
    });

    assert.equal(title, 'Discard 1 change?');
    assert.match(message, /my-spiral/);
    assert.match(message, /main\.py/);
    assert.match(message, /cannot be undone/);
    assert.match(message, /not in any commit yet/);
});

test('counts several changes and says when both sides changed', () => {
    const { title, message } = discardConfirmation({
        name: 'house',
        paths: ['main.py', 'notes.txt'],
        conflicts: ['main.py'],
    });

    assert.equal(title, 'Discard 2 changes?');
    assert.match(message, /The changes to .house. go back to/);
    assert.match(message, /1 file was also changed in GitHub, and is left alone/);
});

test('does not invent a list when there is nothing to discard', () => {
    const { title, message } = discardConfirmation({
        name: 'house',
        paths: [],
        conflicts: [],
    });

    assert.equal(title, 'Discard 0 changes?');
    assert.match(message, /version in GitHub: \. /);
});

test('falls back to a generic name and ignores malformed paths', () => {
    const { message } = discardConfirmation({
        paths: ['main.py', null, '', 4],
        conflicts: [undefined],
    });

    assert.match(message, /this drawing/);
    assert.match(message, /main\.py/);
    assert.doesNotMatch(message, /left alone/);
});
