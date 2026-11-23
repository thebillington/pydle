import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    defaultFilePath,
    normalizeFileName,
    projectSlug,
    validateFileName,
} from '../js/ui/files.js';

test('normalizeFileName adds .py when there is no extension', () => {
    assert.equal(normalizeFileName('helpers'), 'helpers.py');
    assert.equal(normalizeFileName('  helpers  '), 'helpers.py');
    assert.equal(normalizeFileName('my_program'), 'my_program.py');
    assert.equal(normalizeFileName('a1'), 'a1.py');
});

test('normalizeFileName keeps an explicit extension', () => {
    assert.equal(normalizeFileName('helpers.py'), 'helpers.py');
    assert.equal(normalizeFileName('notes.txt'), 'notes.txt');
    assert.equal(normalizeFileName('data.json'), 'data.json');
    assert.equal(normalizeFileName('main.PY'), 'main.PY');
});

test('normalizeFileName rejects slashes and traversal', () => {
    assert.equal(normalizeFileName('lib/helpers.py'), null);
    assert.equal(normalizeFileName('lib\\helpers.py'), null);
    assert.equal(normalizeFileName('/main.py'), null);
    assert.equal(normalizeFileName('../secrets.py'), null);
    assert.equal(normalizeFileName('..'), null);
    assert.equal(normalizeFileName('a/../b.py'), null);
    assert.equal(normalizeFileName('helpers..py'), null);
});

test('normalizeFileName rejects leading dots and empty input', () => {
    assert.equal(normalizeFileName('.hidden.py'), null);
    assert.equal(normalizeFileName('.'), null);
    assert.equal(normalizeFileName(''), null);
    assert.equal(normalizeFileName('   '), null);
    assert.equal(normalizeFileName(null), null);
    assert.equal(normalizeFileName(42), null);
});

test('normalizeFileName rejects awkward names', () => {
    assert.equal(normalizeFileName('helpers.'), null);
    assert.equal(normalizeFileName('a\nb.py'), null);
    assert.equal(normalizeFileName('a\u0000.py'), null);
    assert.equal(normalizeFileName('x'.repeat(200) + '.py'), null);
    // The reserved classroom namespaces stay out of the editor's reach.
    assert.equal(normalizeFileName('assignments'), null);
    assert.equal(normalizeFileName('feedback'), null);
});

test('validateFileName accepts a new name', () => {
    assert.deepEqual(validateFileName('helpers', []), { ok: true, name: 'helpers.py' });
    assert.deepEqual(validateFileName('main.py', ['other.py']), { ok: true, name: 'main.py' });
});

test('validateFileName rejects duplicates, including by case', () => {
    const result = validateFileName('main.py', ['main.py', 'helpers.py']);
    assert.equal(result.ok, false);
    assert.match(result.error, /already in this project/);

    const cased = validateFileName('Helpers', ['helpers.py']);
    assert.equal(cased.ok, false);
});

test('validateFileName explains an unsafe name', () => {
    const result = validateFileName('../x.py', ['main.py']);
    assert.equal(result.ok, false);
    assert.match(result.error, /single file name/);
});

test('validateFileName allows a case-only rename when the old name is excluded', () => {
    const existing = ['main.py'].filter((name) => name !== 'helpers.py');
    assert.deepEqual(validateFileName('Helpers', existing), { ok: true, name: 'Helpers.py' });
});

test('defaultFilePath prefers main.py', () => {
    assert.equal(defaultFilePath(['alpha.py', 'main.py', 'zeta.py']), 'main.py');
    assert.equal(defaultFilePath(['README.md', 'main.py']), 'main.py');
});

test('defaultFilePath falls back to the first Python file alphabetically', () => {
    assert.equal(defaultFilePath(['zeta.py', 'alpha.py', 'notes.txt']), 'alpha.py');
    assert.equal(defaultFilePath(['b.py', 'a.py', 'B.py']), 'B.py');
});

test('defaultFilePath falls back to the first file of any kind', () => {
    assert.equal(defaultFilePath(['zeta.txt', 'alpha.md', 'notes']), 'alpha.md');
});

test('defaultFilePath answers null for an empty project', () => {
    assert.equal(defaultFilePath([]), null);
    assert.equal(defaultFilePath(null), null);
    assert.equal(defaultFilePath(undefined), null);
});

test('projectSlug normalises a name typed at the save prompt', () => {
    assert.equal(projectSlug('My Project'), 'my_project');
    assert.equal(projectSlug('my-project'), 'my_project');
    assert.equal(projectSlug('  spiral  '), 'spiral');
    assert.equal(projectSlug('!!!'), null);
    assert.equal(projectSlug(''), null);
    assert.equal(projectSlug(null), null);
});
