import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ghFetch, GitHubError } from '../js/github/http.js';

const original = globalThis.fetch;

function stub(fn) {
    globalThis.fetch = fn;
}

test('a request that never answers becomes an error, not a wait for ever', async () => {
    // A dropped connection leaves fetch pending. That is what made the commit
    // window sit on "Checking for changes" indefinitely, so the wait is bounded.
    stub((url, options) =>
        new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
        }),
    );

    // Node's timeout signals use unref'd timers, so hold the loop open or the
    // runner decides the test is done before the timeout can fire.
    const keepAlive = setTimeout(() => {}, 2000);
    try {
        await assert.rejects(() => ghFetch('/user', { timeoutMs: 40 }), (error) => {
            assert.ok(error instanceof GitHubError);
            assert.equal(error.status, 0);
            assert.match(error.message, /did not answer in time/);
            return true;
        });
    } finally {
        clearTimeout(keepAlive);
    }
});

test('a network failure is reported as a connection problem', async () => {
    stub(() => Promise.reject(new TypeError('Failed to fetch')));

    await assert.rejects(() => ghFetch('/user'), (error) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, 0);
        assert.match(error.message, /could not be reached/);
        return true;
    });
});

test('a 401 still marks itself as an auth error', async () => {
    stub(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));

    await assert.rejects(() => ghFetch('/user'), (error) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.isAuthError, true);
        return true;
    });
});

test('a normal response is returned as parsed JSON', async () => {
    stub(async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }));

    const body = await ghFetch('/user');
    assert.deepEqual(body, { login: 'octocat' });
});
