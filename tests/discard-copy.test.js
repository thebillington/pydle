import { test } from 'node:test';
import assert from 'node:assert/strict';

import { discardCopy } from '../js/discard-copy.js';

test('a file GitHub has goes back to that version', () => {
    const copy = discardCopy({ paths: [{ path: 'main.py', status: 'modified' }] });
    assert.equal(copy.title, 'Discard 1 change?');
    assert.match(copy.message, /1 file goes back to the version in GitHub: main\.py\./);
    assert.deepEqual(copy.restored, ['main.py']);
    assert.deepEqual(copy.removed, []);
});

test('a file GitHub does not have is removed, not "restored"', () => {
    const copy = discardCopy({ paths: [{ path: 'scratch.py', status: 'added' }] });
    assert.match(copy.message, /1 file is not in GitHub, so it will be removed: scratch\.py\./);
    assert.doesNotMatch(copy.message, /goes back to/);
    assert.deepEqual(copy.removed, ['scratch.py']);
});

test('a mix says both, and lists them together', () => {
    const copy = discardCopy({
        paths: [
            { path: 'main.py', status: 'modified' },
            { path: 'scratch.py', status: 'added' },
        ],
    });
    assert.equal(copy.title, 'Discard 2 changes?');
    assert.match(copy.message, /1 file goes back to the version in GitHub and 1 file is not in GitHub/);
    assert.match(copy.message, /main\.py, scratch\.py/);
});

test('it always says the action cannot be undone', () => {
    for (const paths of [[], [{ path: 'a.py', status: 'added' }], [{ path: 'b.py', status: 'modified' }]]) {
        assert.match(discardCopy({ paths }).message, /cannot be undone/);
    }
});

test('a file changed on both sides is left out and named', () => {
    const copy = discardCopy({
        paths: [
            { path: 'main.py', status: 'modified' },
            { path: 'clash.py', status: 'modified' },
        ],
        conflicts: ['clash.py'],
    });
    assert.deepEqual(copy.paths, ['main.py']);
    assert.match(copy.message, /1 file was also changed in GitHub, and is left alone/);
    assert.doesNotMatch(copy.message.split('\n\n')[0], /clash\.py/);
});

test('the subject names the drawing or project it belongs to', () => {
    const copy = discardCopy({ paths: [{ path: 'main.py', status: 'modified' }], subject: 'spiral' });
    assert.equal(copy.title, 'Discard 1 change in \u201cspiral\u201d?');
    assert.match(copy.message, /^1 file goes back to the version in GitHub/);
});

test('a long list is truncated rather than read aloud', () => {
    const paths = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.py`, status: 'added' }));
    assert.match(discardCopy({ paths }).message, /and more/);
});

test('plain path strings still work, and are treated as restorable', () => {
    const copy = discardCopy({ paths: ['main.py'] });
    assert.deepEqual(copy.paths, ['main.py']);
    assert.match(copy.message, /goes back to/);
});
