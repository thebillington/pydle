import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { commitBadge } from '../js/commit-badge.js';

test('shown when there is local work and GitHub is connected', () => {
    const badge = commitBadge({ signedIn: true, project: 'spiral', count: 2 });
    assert.equal(badge.visible, true);
    assert.equal(badge.count, 2);
    assert.match(badge.label, /^Commit 2 files to GitHub$/);
});

test('a single file is not "1 files"', () => {
    const badge = commitBadge({ signedIn: true, project: 'spiral', count: 1 });
    assert.match(badge.label, /^Commit 1 file to GitHub$/);
});

test('hidden when there is nothing to commit', () => {
    assert.equal(commitBadge({ signedIn: true, project: 'spiral', count: 0 }).visible, false);
});

test('hidden when signed out, because there is nowhere to commit to', () => {
    assert.equal(commitBadge({ signedIn: false, project: 'spiral', count: 3 }).visible, false);
});

test('hidden when no project is open', () => {
    assert.equal(commitBadge({ signedIn: true, project: null, count: 3 }).visible, false);
    assert.equal(commitBadge({ signedIn: true, project: '', count: 3 }).visible, false);
});

test('a count that is not a number hides it rather than showing "NaN"', () => {
    for (const count of [NaN, undefined, null, 'two']) {
        const badge = commitBadge({ signedIn: true, project: 'spiral', count });
        assert.equal(badge.visible, false);
        assert.equal(badge.count, 0);
    }
});

test('a fractional count is floored, not rounded or printed raw', () => {
    assert.equal(commitBadge({ signedIn: true, project: 'spiral', count: 2.9 }).count, 2);
});

/*
 * The regression this file exists for. The rail badge once asked GitHub for its
 * number, so a rate limit or a dropped connection painted zero, and zero hides
 * the control. It must stay local.
 */
test('the rail badge does not ask GitHub for its number', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const start = html.indexOf('async function refreshCommitState()');
    assert.ok(start > 0, 'refreshCommitState should exist');

    const end = html.indexOf('/** Whether the commit dialog ended in a commit', start);
    const body = html.slice(start, end > start ? end : start + 3000);

    assert.doesNotMatch(body, /previewCommit/, 'the badge must not call the repository');
    assert.doesNotMatch(body, /getRef|cachedHead|currentHead/, 'the badge must not read the ref');
    assert.match(body, /sync\.dirty\(/, 'the badge is drawn from local state');
});
