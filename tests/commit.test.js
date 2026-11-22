import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../js/config.js';
import { commitFiles, ConflictError } from '../js/github/commit.js';

const OWNER = 'octocat';
const REPO = 'pydle';
const BRANCH = 'main';
const HEAD = 'head-1';

const IDENTITY = {
    name: 'Ada Lovelace',
    email: '1+ada@users.noreply.github.com',
};

/**
 * A minimal GitHub Git Data API stand-in.
 *
 * Automatically advances the branch on the "other device" whenever a PATCH is
 * rejected with 422, so the retry has a genuinely different head to build on.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ failPatchTimes?: number }} [options]
 * @returns {{ calls: Array<{ method: string, path: string, body: any }>, head: () => string }}
 */
function fakeGitHub(t, { failPatchTimes = 0 } = {}) {
    const original = globalThis.fetch;
    const calls = [];
    let head = HEAD;
    let blobCount = 0;
    let treeCount = 0;
    let commitCount = 0;
    let patchFailures = 0;

    globalThis.fetch = async (url, options = {}) => {
        const method = options.method ?? 'GET';
        const path = url.slice(CONFIG.apiBase.length);
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;

        calls.push({ method, path, body });

        if (method === 'GET' && path === `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`) {
            return respond({ object: { sha: head } });
        }

        if (method === 'POST' && path === `/repos/${OWNER}/${REPO}/git/blobs`) {
            blobCount += 1;
            return respond({ sha: `blob-${blobCount}` });
        }

        if (method === 'POST' && path === `/repos/${OWNER}/${REPO}/git/trees`) {
            treeCount += 1;
            return respond({ sha: `tree-${treeCount}` });
        }

        if (method === 'POST' && path === `/repos/${OWNER}/${REPO}/git/commits`) {
            commitCount += 1;
            return respond({ sha: `commit-${commitCount}` });
        }

        if (method === 'PATCH' && path === `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`) {
            if (patchFailures < failPatchTimes) {
                patchFailures += 1;
                // The other device moved the branch under us.
                head = `remote-${patchFailures}`;
                return respond({ message: 'Update is not a fast forward' }, 422);
            }
            head = body.sha;
            return respond({ object: { sha: body.sha } });
        }

        throw new Error(`Unexpected request: ${method} ${path}`);
    };

    t.after(() => {
        globalThis.fetch = original;
    });

    return { calls, head: () => head };
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {object}
 */
function respond(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
    };
}

/**
 * @param {Array<{ method: string, path: string, body: any }>} calls
 * @returns {Array<string>}
 */
function requestSequence(calls) {
    return calls.map((call) => `${call.method} ${call.path}`);
}

const FILES = [
    { path: 'work/spiral/main.py', content: 'print("hi")\n' },
    { path: 'work/spiral/project.json', content: '{"title":"Spiral"}' },
];

test('commitFiles assembles blobs -> tree -> commit -> updateRef', async (t) => {
    const server = fakeGitHub(t);

    const commit = await commitFiles({
        token: 'tok',
        owner: OWNER,
        repo: REPO,
        branch: BRANCH,
        files: FILES,
        message: 'Save spiral',
        identity: IDENTITY,
    });

    assert.equal(commit.sha, 'commit-1');

    assert.deepEqual(requestSequence(server.calls), [
        `GET /repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`,
        `POST /repos/${OWNER}/${REPO}/git/blobs`,
        `POST /repos/${OWNER}/${REPO}/git/blobs`,
        `POST /repos/${OWNER}/${REPO}/git/trees`,
        `POST /repos/${OWNER}/${REPO}/git/commits`,
        `PATCH /repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`,
    ]);

    const [, firstBlob, secondBlob, tree, commitCall, patch] = server.calls;
    assert.equal(firstBlob.body.content, FILES[0].content);
    assert.equal(secondBlob.body.content, FILES[1].content);

    assert.equal(tree.body.base_tree, HEAD);
    assert.deepEqual(
        tree.body.tree.map((entry) => [entry.path, entry.sha]),
        [
            [FILES[0].path, 'blob-1'],
            [FILES[1].path, 'blob-2'],
        ],
    );

    assert.deepEqual(commitCall.body.parents, [HEAD]);
    assert.equal(commitCall.body.tree, 'tree-1');
    assert.equal(commitCall.body.message, 'Save spiral');
    assert.deepEqual(commitCall.body.author, IDENTITY);
    assert.deepEqual(commitCall.body.committer, IDENTITY);

    assert.deepEqual(patch.body, { sha: 'commit-1' });
    assert.equal('force' in patch.body, false, 'must never force-push');
    assert.equal(server.head(), 'commit-1');
});

test('a 422 rebuilds on the new head and succeeds on the retry', async (t) => {
    const server = fakeGitHub(t, { failPatchTimes: 1 });

    const commit = await commitFiles({
        token: 'tok',
        owner: OWNER,
        repo: REPO,
        branch: BRANCH,
        files: FILES,
        message: 'Save again',
        identity: IDENTITY,
    });

    const patches = server.calls.filter((call) => call.method === 'PATCH');
    const trees = server.calls.filter((call) => call.path.endsWith('/git/trees'));
    const commits = server.calls.filter((call) => call.path.endsWith('/git/commits'));

    assert.equal(patches.length, 2, 'retries exactly once');
    assert.equal(trees.length, 2, 'rebuilds the tree');
    assert.equal(commits.length, 2, 'rebuilds the commit');

    assert.equal(trees[0].body.base_tree, HEAD);
    assert.equal(trees[1].body.base_tree, 'remote-1');
    assert.deepEqual(commits[1].body.parents, ['remote-1']);

    // Blobs are content-addressed, so they are created once and reused.
    assert.equal(server.calls.filter((call) => call.path.endsWith('/git/blobs')).length, 2);

    assert.equal(commit.sha, 'commit-2');
    assert.equal(server.head(), 'commit-2');
});

test('a second 422 throws ConflictError with the old and new SHAs', async (t) => {
    const server = fakeGitHub(t, { failPatchTimes: 2 });

    await assert.rejects(
        () =>
            commitFiles({
                token: 'tok',
                owner: OWNER,
                repo: REPO,
                branch: BRANCH,
                files: FILES,
                message: 'Doomed save',
                identity: IDENTITY,
            }),
        (error) => {
            assert.ok(error instanceof ConflictError);
            assert.equal(error.oldSha, HEAD);
            assert.equal(error.newSha, 'remote-2');
            assert.match(error.message, /another device/);
            return true;
        },
    );

    const patches = server.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 2, 'does not retry a third time');
    assert.equal(server.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/git/blobs')).length, 2);
});
