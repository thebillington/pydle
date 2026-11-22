import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getRef, getRepo } from '../js/github/git-data.js';

/**
 * An empty repository does not answer 404 for a ref that does not exist. It
 * answers 409 "Git Repository is empty", and the whole scaffold depended on
 * getRef returning null there. Getting this wrong made every workspace creation
 * fail before it could seed the first commit.
 */

const realFetch = globalThis.fetch;

function stubFetch(status, body) {
    globalThis.fetch = async () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
}

test.afterEach(() => {
    globalThis.fetch = realFetch;
});

test('getRef treats 409 from an empty repository as "no branch"', async () => {
    stubFetch(409, { message: 'Git Repository is empty.' });
    const ref = await getRef({ token: 't', owner: 'o', repo: 'r', branch: 'main' });
    assert.equal(ref, null);
});

test('getRef treats 404 as "no branch"', async () => {
    stubFetch(404, { message: 'Not Found' });
    const ref = await getRef({ token: 't', owner: 'o', repo: 'r', branch: 'main' });
    assert.equal(ref, null);
});

test('getRef returns the sha when the branch exists', async () => {
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ object: { sha: 'abc123' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    const ref = await getRef({ token: 't', owner: 'o', repo: 'r', branch: 'main' });
    assert.deepEqual(ref, { sha: 'abc123' });
});

test('getRef still throws a real failure', async () => {
    stubFetch(401, { message: 'Bad credentials' });
    await assert.rejects(
        () => getRef({ token: 't', owner: 'o', repo: 'r', branch: 'main' }),
        (error) => error.status === 401,
    );
});

test('getRepo returns null only for 404, not for 409', async () => {
    stubFetch(404, { message: 'Not Found' });
    assert.equal(await getRepo({ token: 't', owner: 'o', repo: 'r' }), null);

    stubFetch(409, { message: 'Git Repository is empty.' });
    await assert.rejects(
        () => getRepo({ token: 't', owner: 'o', repo: 'r' }),
        (error) => error.status === 409,
    );
});
