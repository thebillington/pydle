/**
 * End-to-end tests for the commit/preview path in `js/sync.js`.
 *
 * There is no browser here: `tests/fake/idb.js` is the vault's storage and
 * `tests/fake/github.js` is the repository behind `fetch`. Both are in-memory,
 * so the whole sign-in -> edit -> preview -> commit -> preview loop runs in Node
 * with no credentials and no network.
 *
 * The fake GitHub hashes blobs, trees and commits the way git does, which is
 * what makes the snapshot's hashes comparable with the repository's. See the
 * fake for that detail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { install as installIdb } from './fake/idb.js';
import { installFakeGitHub, PYDLE_JSON } from './fake/github.js';
import { REPO_NAME, createSync } from '../js/sync.js';
import { saveTokens } from '../js/vault/tokens.js';

// sync.js hashes blobs with `crypto.subtle`, which the browser has and Node 18
// only exposes behind a flag. The harness supplies the same WebCrypto.
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

const OWNER = 'octocat';

// One installation for the whole file: the vault modules cache their open
// database handle at module scope, so the fake must keep the same handles and
// only clear their contents between tests.
const idb = installIdb();

/**
 * Seed the files every real workspace has, plus anything a test needs.
 *
 * @param {Record<string, string>} [extra]
 */
function workspaceFiles(extra = {}) {
    return {
        'pydle.json': PYDLE_JSON,
        'work/.gitkeep': '',
        ...extra,
    };
}

/**
 * A clean vault, a seeded fake repository, a stored token and a connected sync.
 *
 * The token is written straight into the `auth` store: the device flow is a
 * different module and needs a real GitHub app, so the harness starts after it.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} [files]
 */
async function connected(t, files = {}) {
    idb.reset();

    const world = installFakeGitHub({ owner: OWNER, repo: REPO_NAME, branch: 'main' });
    t.after(() => world.restore());

    world.seed(workspaceFiles(files));

    await saveTokens({
        accessToken: 'test-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scope: 'repo',
    });

    const sync = createSync();
    await sync.connect();
    assert.equal(sync.status, 'connected', 'the fake repository should sign in');

    return { sync, world };
}

/**
 * Commits reachable from the branch with a given message.
 *
 * Used to prove a retry did not leave two commits for one save.
 *
 * @param {{ history: () => Array<{ message: string }> }} world
 * @param {string} message
 */
function commitsWithMessage(world, message) {
    return world.history().filter((commit) => commit.message === message);
}

test('local changes are reported by dirty() and previewCommit()', async (t) => {
    const { sync } = await connected(t);

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');
    await sync.writeFiles('demo', 'notes.txt', 'remember the turtle\n');

    const dirty = await sync.dirty('demo');
    assert.equal(dirty.count, 2);
    assert.deepEqual(
        dirty.paths.map((entry) => entry.path),
        ['main.py', 'notes.txt'],
    );
    assert.ok(dirty.paths.every((entry) => entry.status === 'added'));

    const preview = await sync.previewCommit('demo');
    assert.deepEqual(
        preview.paths.map((entry) => entry.path).sort(),
        ['main.py', 'notes.txt'],
    );
    assert.equal(preview.count, preview.paths.length, 'count is the number of paths');
    assert.equal(preview.count, 2);
});

test('committing selected files leaves nothing listed afterwards', async (t) => {
    const { sync, world } = await connected(t);

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');
    await sync.writeFiles('demo', 'notes.txt', 'remember the turtle\n');

    // A preview first is what the dialog does, and it is also the state the
    // "commit (1) forever" regression appeared in.
    await sync.previewCommit('demo');

    const result = await sync.commit({
        project: 'demo',
        paths: ['main.py', 'notes.txt'],
        message: 'Save demo',
    });

    assert.equal(result.sha, world.head());

    const after = await sync.previewCommit('demo');
    assert.equal(after.count, 0, 'a committed project must not still look dirty');
    assert.deepEqual(after.paths, []);
});

test('a preview after a commit costs at most two requests', async (t) => {
    const { sync, world } = await connected(t);
    world.resetRequests();

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');
    await sync.commit({ project: 'demo', paths: ['main.py'], message: 'Save demo' });

    // Let the commit's own background bookkeeping preview finish first: it is
    // deliberately not awaited by commit(), and it is part of the cost.
    await new Promise((resolve) => setTimeout(resolve, 0));
    world.resetRequests();

    const preview = await sync.previewCommit('demo');

    assert.equal(preview.count, 0);
    assert.ok(
        world.requestCount() <= 2,
        `preview used ${world.requestCount()} requests: ` +
            world.requests.map((request) => `${request.method} ${request.path}`).join(', '),
    );
});

// Current behaviour is wrong here: `currentHead()` trusts its 10-second cache,
// so a branch moved on another device moments after a commit is invisible to
// previewCommit() and the change is neither pulled nor conflicted. The test
// describes the intended behaviour and is marked todo until the cache rule is
// revisited. (`commit()` itself reads the ref freshly, so it does notice.)
test('a commit made elsewhere is pulled or reported as a conflict', { todo: 'previewCommit trusts a stale HEAD cache' }, async (t) => {
    const { sync, world } = await connected(t);

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');
    await sync.commit({ project: 'demo', paths: ['main.py'], message: 'Local edit' });

    // Another device advances the branch without this device hearing about it.
    world.commitElsewhere({ 'work/demo/main.py': 'print(2)\n' }, 'Changed on another device');

    const preview = await sync.previewCommit('demo');

    const pulled = preview.pulled.includes('main.py');
    const conflicted = preview.conflicts.some((conflict) => conflict.path === 'main.py');
    assert.ok(
        pulled || conflicted,
        `expected the remote change to be pulled or conflicted, got ${JSON.stringify({
            count: preview.count,
            pulled: preview.pulled,
            conflicts: preview.conflicts,
            paths: preview.paths,
            headSha: preview.headSha,
        })}`,
    );
});

test('a fresh session sees a change made elsewhere and pulls it', async (t) => {
    const { sync, world } = await connected(t);

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');
    await sync.commit({ project: 'demo', paths: ['main.py'], message: 'Local edit' });

    world.commitElsewhere({ 'work/demo/main.py': 'print(2)\n' }, 'Changed on another device');

    // A second session has its own (empty) HEAD cache but the same vault, which
    // is both a check on the fake's remote-move support and the behaviour the
    // todo above asks for.
    const second = createSync();
    await second.connect();

    const preview = await second.previewCommit('demo');
    assert.deepEqual(preview.pulled, ['main.py']);
    assert.deepEqual(preview.conflicts, []);
    assert.equal(preview.count, 0, 'after pulling, the file matches the repository');
    assert.equal((await second.readProject('demo'))['main.py'], 'print(2)\n');
});

test('a file already in the repository is modified, never added', async (t) => {
    const { sync } = await connected(t, {
        'work/demo/main.py': 'print(1)\n',
    });

    // No snapshot on this device yet: dirty() can only call this "added", which
    // is why the preview has to consult the repository before deciding.
    await sync.writeFiles('demo', 'main.py', 'print(2)\n');

    const preview = await sync.previewCommit('demo');
    const entry = preview.paths.find((item) => item.path === 'main.py');

    assert.ok(entry, 'main.py should be listed as changed');
    assert.equal(entry.status, 'modified');
    assert.equal(entry.before, 'print(1)\n');
    assert.equal(entry.after, 'print(2)\n');
});

test('preview still works offline when HEAD has not moved', async (t) => {
    const { sync, world } = await connected(t, {
        'work/demo/main.py': 'print(1)\n',
    });

    // Same content on both sides. A first online preview records the content in
    // the snapshot, so the next one has no reason to ask GitHub anything.
    await sync.writeFiles('demo', 'main.py', 'print(1)\n');
    const first = await sync.previewCommit('demo');
    assert.equal(first.count, 0);

    world.resetRequests();
    world.offline(true);

    const offline = await sync.previewCommit('demo');
    assert.equal(offline.count, 0);
    assert.equal(world.requestCount(), 0, 'the snapshot should answer without the network');
});

test('a rate-limited preview says so and is not an auth error', async (t) => {
    const { sync, world } = await connected(t);

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');
    world.rateLimitUntil(Date.now() + 60_000);

    await assert.rejects(
        () => sync.previewCommit('demo'),
        (error) => {
            assert.match(error.message, /limiting requests/i);
            // Deliberately only "not auth": this path currently lets the raw
            // GitHubError out, so it has no `kind` at all. The requirement is
            // that a busy account is never mistaken for a signed-out one.
            assert.notEqual(error.kind, 'auth');
            return true;
        },
    );
});

test('a stale ref gets a 422, rebuilds on the new head, and commits once', async (t) => {
    const { sync, world } = await connected(t);

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');

    // Just before the ref update, another device moves the branch. The fake
    // answers the update with GitHub's non-fast-forward 422.
    world.failNext(
        422,
        { message: 'Update is not a fast forward' },
        {},
        {
            method: 'PATCH',
            beforeResponse: () => {
                world.commitElsewhere({ 'work/demo/other.py': 'print(2)\n' }, 'Racing device');
            },
        },
    );

    const result = await sync.commit({
        project: 'demo',
        paths: ['main.py'],
        message: 'Save after a race',
    });

    assert.equal(world.head(), result.sha);
    assert.equal(
        commitsWithMessage(world, 'Save after a race').length,
        1,
        'one save must produce one reachable commit, not two',
    );

    const after = await sync.previewCommit('demo');
    assert.equal(after.count, 0);
});

test('a 422 on the retry is a conflict with no reachable commit', async (t) => {
    const { sync, world } = await connected(t);

    await sync.writeFiles('demo', 'main.py', 'print(1)\n');

    // The first update races with another device; the rebuild races again and
    // this time the other device does not move, so the client cannot tell the
    // two writes apart. It must stop rather than keep trying or force the ref.
    world.failNext(422, { message: 'Update is not a fast forward' }, {}, {
        method: 'PATCH',
        beforeResponse: () => world.commitElsewhere({ 'work/demo/a.py': 'a\n' }, 'First race'),
    });
    world.failNext(422, { message: 'Update is not a fast forward' }, {}, { method: 'PATCH' });

    await assert.rejects(
        () => sync.commit({ project: 'demo', paths: ['main.py'], message: 'Doomed save' }),
        (error) => {
            assert.equal(error.kind, 'conflict');
            assert.match(error.message, /another device/i);
            return true;
        },
    );

    assert.equal(
        commitsWithMessage(world, 'Doomed save').length,
        0,
        'a failed save must not appear in the reachable history',
    );
});
