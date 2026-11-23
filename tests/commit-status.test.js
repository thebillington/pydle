import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeChange } from '../js/commit-status.js';

test('a file only on this device is added', () => {
    assert.equal(describeChange(null, 'print(1)\n'), 'added');
});

test('a file only in the repository is deleted', () => {
    assert.equal(describeChange('print(1)\n', null), 'deleted');
});

test('absent from both is unchanged', () => {
    assert.equal(describeChange(null, null), 'unchanged');
});

test('different content on each side is modified', () => {
    assert.equal(describeChange('print(1)\n', 'print(2)\n'), 'modified');
});

test('identical content on both sides is unchanged', () => {
    assert.equal(describeChange('print(1)\n', 'print(1)\n'), 'unchanged');
});

test('a file the repository already has is not "added", even if this device never committed it', () => {
    // The regression: the vault has no record of the file, so the old code called
    // it added and skipped looking upstream entirely.
    const remote = 'def greet():\n    return "hi"\n';
    const local = 'def greet():\n    return "hello"\n';
    assert.equal(describeChange(remote, local), 'modified');
});
