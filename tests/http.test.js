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
function response(body, status = 200, headers = {}) {
    const lowered = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => lowered[String(name).toLowerCase()] ?? null },
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

test('a request that never answers fails instead of waiting for ever', async (t) => {
    // A dropped connection leaves fetch pending, which left the commit window on
    // "Checking for changes" with no way out. The wait is bounded instead.
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) =>
        new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
        });
    t.after(() => {
        globalThis.fetch = original;
    });

    // Node's timeout signals use unref'd timers, so hold the loop open or the
    // runner decides the test is done before the timeout can fire.
    const keepAlive = setTimeout(() => {}, 2000);
    try {
        await assert.rejects(
            () => ghFetch('/user', { token: 'tok', timeoutMs: 40 }),
            (error) => {
                assert.ok(error instanceof GitHubError);
                assert.equal(error.status, 0);
                assert.match(error.message, /did not answer in time/);
                return true;
            },
        );
    } finally {
        clearTimeout(keepAlive);
    }
});

test('a network failure is reported as a connection problem', async (t) => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    t.after(() => {
        globalThis.fetch = original;
    });

    await assert.rejects(
        () => ghFetch('/user', { token: 'tok' }),
        (error) => {
            assert.ok(error instanceof GitHubError);
            assert.equal(error.status, 0);
            assert.match(error.message, /could not be reached/);
            return true;
        },
    );
});

test('a spent rate limit is named as one, not as a 403', async (t) => {
    stubFetch(t, () =>
        response(
            { message: 'API rate limit exceeded' },
            403,
            { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 90) },
        ),
    );

    await assert.rejects(
        () => ghFetch('/repos/o/r/git/trees/main', { token: 'tok' }),
        (error) => {
            assert.ok(error instanceof GitHubError);
            assert.equal(error.rateLimited, true);
            assert.match(error.message, /limiting requests/);
            assert.match(error.message, /still on this device/);
            assert.doesNotMatch(error.message, /scraping/);
            return true;
        },
    );
});

test('a rate limit is recognised from the message alone', async (t) => {
    stubFetch(t, () =>
        response({ message: 'You have exceeded a secondary rate limit.' }, 403),
    );

    await assert.rejects(
        () => ghFetch('/user', { token: 'tok' }),
        (error) => {
            assert.equal(error.rateLimited, true);
            return true;
        },
    );
});

test('an ordinary 403 is not called a rate limit', async (t) => {
    stubFetch(t, () => response({ message: 'Resource not accessible by integration' }, 403));

    await assert.rejects(
        () => ghFetch('/repos/o/r', { token: 'tok' }),
        (error) => {
            assert.equal(error.rateLimited, false);
            assert.match(error.message, /403/);
            return true;
        },
    );
});
