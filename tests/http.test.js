import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../js/config.js';
import { ghFetch, GitHubError } from '../js/github/http.js';

/**
 * Replace globalThis.fetch for one test and record every call.
 *
 * @param {import('node:test').TestContext} t
 * @param {(url: string, options: object, index: number) => object} handler
 * @returns {Array<{ url: string, options: any }>}
 */
function stubFetch(t, handler) {
    const original = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url, options });
        return handler(url, options, calls.length - 1);
    };

    t.after(() => {
        globalThis.fetch = original;
    });

    return calls;
}

/**
 * A minimal Response stand-in: ghFetch only reads `ok`, `status` and `text()`.
 *
 * @param {unknown} body
 * @param {number} [status]
 * @returns {object}
 */
function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => {
            if (body === null) {
                return '';
            }
            return typeof body === 'string' ? body : JSON.stringify(body);
        },
    };
}

test('ghFetch sets Authorization, Accept and the pinned API version', async (t) => {
    const calls = stubFetch(t, () => response({ login: 'octocat' }));

    await ghFetch('/user', { token: 'tok-123' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${CONFIG.apiBase}/user`);
    assert.equal(calls[0].options.method, 'GET');

    const headers = calls[0].options.headers;
    assert.equal(headers.Authorization, 'Bearer tok-123');
    assert.equal(headers.Accept, 'application/vnd.github+json');
    assert.equal(headers['X-GitHub-Api-Version'], CONFIG.apiVersion);
    assert.equal(headers['X-GitHub-Api-Version'], '2026-03-10');
});

test('ghFetch encodes an object body as JSON and passes strings through', async (t) => {
    const calls = stubFetch(t, () => response({ sha: 'abc' }));

    await ghFetch('/repos/o/r/git/blobs', {
        token: 'tok',
        method: 'POST',
        body: { content: 'print(1)', encoding: 'utf-8' },
    });

    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), { content: 'print(1)', encoding: 'utf-8' });

    await ghFetch('/repos/o/r/git/blobs', { token: 'tok', method: 'POST', body: '{"raw":true}' });

    assert.equal(calls[1].options.body, '{"raw":true}');
});

test('ghFetch returns parsed JSON', async (t) => {
    stubFetch(t, () => response({ default_branch: 'trunk', private: true }));

    const repo = await ghFetch('/repos/o/r', { token: 'tok' });

    assert.deepEqual(repo, { default_branch: 'trunk', private: true });
});

test('a 401 becomes a GitHubError with isAuthError set', async (t) => {
    stubFetch(t, () => response({ message: 'Bad credentials' }, 401));

    await assert.rejects(
        () => ghFetch('/user', { token: 'stale' }),
        (error) => {
            assert.ok(error instanceof GitHubError);
            assert.equal(error.status, 401);
            assert.equal(error.isAuthError, true);
            assert.deepEqual(error.body, { message: 'Bad credentials' });
            assert.match(error.message, /Bad credentials/);
            return true;
        },
    );
});

test('non-auth failures are not marked as auth errors', async (t) => {
    stubFetch(t, () => response({ message: 'Not Found' }, 404));

    await assert.rejects(
        () => ghFetch('/repos/o/missing', { token: 'tok' }),
        (error) => {
            assert.ok(error instanceof GitHubError);
            assert.equal(error.status, 404);
            assert.equal(error.isAuthError, false);
            return true;
        },
    );
});

test('204 and empty bodies return null', async (t) => {
    stubFetch(t, (url, options, index) => (index === 0 ? response(null, 204) : response('', 200)));

    assert.equal(await ghFetch('/user', { token: 'tok' }), null);
    assert.equal(await ghFetch('/user', { token: 'tok' }), null);
});
