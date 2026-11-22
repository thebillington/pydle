import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    assertInside,
    isReservedPath,
    normalizeProjectName,
    safeJoin,
} from '../js/vault/paths.js';

test('safeJoin joins simple fragments', () => {
    assert.equal(safeJoin('work', 'main.py'), 'work/main.py');
    assert.equal(safeJoin('a', 'b', 'c.txt'), 'a/b/c.txt');
    assert.equal(safeJoin('a/b', 'c'), 'a/b/c');
});

test('safeJoin collapses "." segments', () => {
    assert.equal(safeJoin('a/./b'), 'a/b');
    assert.equal(safeJoin('./a', 'b'), 'a/b');
    assert.equal(safeJoin('a', '.', 'b'), 'a/b');
});

test('safeJoin rejects parent traversal', () => {
    assert.throws(() => safeJoin('../x'), TypeError);
    assert.throws(() => safeJoin('a/../../b'), TypeError);
    assert.throws(() => safeJoin('..'), TypeError);
    assert.throws(() => safeJoin('a', '..', 'b'), TypeError);
});

test('safeJoin rejects absolute paths', () => {
    assert.throws(() => safeJoin('/etc/passwd'), TypeError);
    assert.throws(() => safeJoin('a', '/b'), TypeError);
});

test('safeJoin rejects backslashes', () => {
    assert.throws(() => safeJoin('a\\b'), TypeError);
});

test('safeJoin rejects empty input and empty segments', () => {
    assert.throws(() => safeJoin(''), TypeError);
    assert.throws(() => safeJoin(), TypeError);
    assert.throws(() => safeJoin('a//b'), TypeError);
    assert.throws(() => safeJoin('a/'), TypeError);
});

test('safeJoin rejects control characters', () => {
    assert.throws(() => safeJoin('a\u0000b'), TypeError);
    assert.throws(() => safeJoin('a\nb'), TypeError);
});

test('safeJoin error names the offending input', () => {
    assert.throws(() => safeJoin('a/../../b'), /a\/\.\.\/\.\.\/b/);
    assert.throws(() => safeJoin('/etc/passwd'), /\/etc\/passwd/);
});

test('normalizeProjectName slugifies display names', () => {
    assert.equal(normalizeProjectName('My Project'), 'my-project');
    assert.equal(normalizeProjectName('  __hello__  '), 'hello');
    assert.equal(normalizeProjectName('ÜBER'), 'ber');
    assert.equal(normalizeProjectName('a b__c'), 'a-b-c');
    assert.equal(normalizeProjectName('--x--'), 'x');
});

test('normalizeProjectName throws when nothing usable remains', () => {
    assert.throws(() => normalizeProjectName('!!!'), TypeError);
    assert.throws(() => normalizeProjectName(''), TypeError);
    assert.throws(() => normalizeProjectName('   '), TypeError);
});

test('normalizeProjectName caps the slug at 64 characters', () => {
    const slug = normalizeProjectName('a'.repeat(100));
    assert.equal(slug.length, 64);
    assert.equal(slug, 'a'.repeat(64));

    // A hyphen left dangling by the cut is trimmed, so the cap still holds.
    const trimmed = normalizeProjectName('b'.repeat(63) + ' x');
    assert.equal(trimmed, 'b'.repeat(63));
    assert.ok(trimmed.length <= 64);
});

test('isReservedPath recognises the reserved roots', () => {
    assert.equal(isReservedPath('assignments/x'), true);
    assert.equal(isReservedPath('feedback/2026-11.md'), true);
    assert.equal(isReservedPath('work/x'), false);
    assert.equal(isReservedPath('assignments'), true);
    assert.equal(isReservedPath(''), false);
});

test('assertInside accepts root and descendants', () => {
    assert.equal(assertInside('projects/my-project', 'projects/my-project'), true);
    assert.equal(assertInside('projects/my-project', 'projects/my-project/work/main.py'), true);
    assert.equal(assertInside('projects', 'projects/a/b.txt'), true);
});

test('assertInside rejects paths outside the root', () => {
    assert.equal(assertInside('projects/my-project', 'projects/other/main.py'), false);
    assert.equal(assertInside('projects/my-project', 'projects'), false);
    assert.equal(assertInside('a/b', 'a/bc/d'), false);
});

test('assertInside rejects traversal that escapes', () => {
    assert.equal(assertInside('projects/my-project', 'projects/my-project/../../other/x'), false);
    assert.equal(assertInside('projects/my-project', '../my-project/x'), false);
    assert.equal(assertInside('projects/my-project', 'projects/my-project/..'), false);
});

test('assertInside tolerates dot segments and repeated slashes', () => {
    assert.equal(assertInside('projects/p', 'projects/p/./work//main.py'), true);
    assert.equal(assertInside('projects/p', '/projects/p/work/main.py'), true);
});

test('assertInside rejects malformed paths without throwing', () => {
    assert.equal(assertInside('projects/p', 'projects\\p\\x'), false);
    assert.equal(assertInside('projects/p', 'projects/p/\u0000'), false);
});
