import { test } from 'node:test';
import assert from 'node:assert/strict';

import { missingFromSnapshot, snapshotContents, snapshotMatchesHead } from '../js/preview.js';

test('a snapshot describes the repository only when HEAD is its commit', () => {
    assert.equal(snapshotMatchesHead('abc', { sha: 'abc' }), true);
    assert.equal(snapshotMatchesHead('abd', { sha: 'abc' }), false);
    assert.equal(snapshotMatchesHead(null, { sha: 'abc' }), false);
    assert.equal(snapshotMatchesHead('abc', null), false);
    assert.equal(snapshotMatchesHead('abc', {}), false);
});

test('contents come from the stored snapshot, not from a hash', () => {
    const contents = snapshotContents({
        files: {
            'main.py': { hash: 'h1', content: 'print(1)\n' },
            'old.py': { hash: 'h2' },
            'legacy.py': 'print(2)\n',
        },
    });

    assert.equal(contents.get('main.py'), 'print(1)\n');
    assert.equal(contents.get('legacy.py'), 'print(2)\n');
    assert.equal(contents.has('old.py'), false, 'a hash is not content');
});

test('nothing is invented for a missing or malformed snapshot', () => {
    assert.equal(snapshotContents(null).size, 0);
    assert.equal(snapshotContents({}).size, 0);
    assert.equal(snapshotContents({ files: { a: null, b: 5 } }).size, 0);
});

test('only paths the snapshot cannot answer for are fetched', () => {
    const contents = new Map([['main.py', 'x']]);
    assert.deepEqual(missingFromSnapshot(['main.py', 'new.py'], contents), ['new.py']);
});
