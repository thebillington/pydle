/**
 * The one door to api.github.com.
 *
 * Every request goes through `ghFetch`, so the three required headers and the
 * error mapping live in exactly one place. `api.github.com` sends CORS headers,
 * so data requests go straight from the browser; only the two login endpoints
 * need the shim.
 */
import { CONFIG } from '../config.js';

/**
 * A failed GitHub API request.
 *
 * `401` is special: the whole app treats it as "reconnect", never as a generic
 * error, so it sets `isAuthError` rather than making callers compare numbers.
 */
export class GitHubError extends Error {
    /**
     * @param {string} message
     * @param {{ status?: number, body?: unknown }} [details]
     */
    constructor(message, { status = 0, body = null } = {}) {
        super(message);
        this.name = 'GitHubError';
        /** @type {number} HTTP status, or 0 if the request never completed. */
        this.status = status;
        /** @type {unknown} Parsed response body, when there was one. */
        this.body = body;
        /** @type {boolean} True only for 401 — the caller should reconnect. */
        this.isAuthError = status === 401;
        /** @type {boolean} True when GitHub refused because of a rate limit. */
        this.rateLimited = false;
    }
}

/**
 * True when `headers` already carries a header with this name, case-insensitively.
 *
 * @param {Record<string, string>} headers
 * @param {string} name
 * @returns {boolean}
 */
function hasHeader(headers, name) {
    const wanted = name.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Pull a human-readable message out of a GitHub error body.
 *
 * @param {number} status
 * @param {unknown} body
 * @returns {string}
 */
function describeError(status, body) {
    let detail = '';
    if (body && typeof body === 'object' && typeof body.message === 'string') {
        detail = body.message;
    } else if (typeof body === 'string') {
        detail = body;
    }
    return detail ? `GitHub API ${status}: ${detail}` : `GitHub API request failed (${status}).`;
}

/**
 * Parse a response body as JSON, falling back to the raw text.
 *
 * @param {string} text
 * @returns {unknown}
 */
function parseBody(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return text;
    }
}

/**
 * Call the GitHub REST API.
 *
 * @param {string} path Full REST path, e.g. `/user` or `/repos/o/r/git/blobs`.
 * @param {{ token?: string, method?: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<any>} Parsed JSON, or null for 204 / an empty body.
 * @throws {GitHubError} On any non-ok response. 401 sets `isAuthError`.
 */
export async function ghFetch(path, { token, method = 'GET', body, headers, timeoutMs = 30000 } = {}) {
    const url = `${CONFIG.apiBase}${path}`;
    const requestHeaders = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': CONFIG.apiVersion,
        ...headers,
    };

    if (token) {
        requestHeaders.Authorization = `Bearer ${token}`;
    }

    let payload;
    if (body !== undefined && body !== null) {
        if (typeof body === 'string') {
            payload = body;
        } else {
            payload = JSON.stringify(body);
            if (!hasHeader(requestHeaders, 'content-type')) {
                requestHeaders['Content-Type'] = 'application/json';
            }
        }
    }

    // A fetch that never returns leaves the caller waiting for ever, which is
    // exactly what a dropped connection does. Bound it, so a stalled request becomes
    // an error the dialog can report rather than an endless spinner.
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: requestHeaders,
            body: payload,
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
                ? AbortSignal.timeout(timeoutMs)
                : undefined,
        });
    } catch (error) {
        throw new GitHubError(
            error && error.name === 'TimeoutError'
                ? 'GitHub did not answer in time. Check your connection and try again.'
                : 'GitHub could not be reached. Check your connection and try again.',
        );
    }
    const text = await response.text();
    const parsed = response.status === 204 ? null : parseBody(text);

    if (!response.ok) {
        // A rate limit is not a normal failure: it means pydle asked too often, and
        // it needs to be reported in those words rather than as "API 403" next to a
        // message about scraping. The remaining count is in a header; the body says
        // it too, which survives a proxy that strips headers.
        // Tolerate a response without real headers: the tests use a minimal stand-in
        // for Response, and a missing header must not become a TypeError.
        const header = (name) =>
            response.headers && typeof response.headers.get === 'function'
                ? response.headers.get(name)
                : null;

        const remaining = header('x-ratelimit-remaining');
        const bodyText = text.toLowerCase();
        const limited =
            response.status === 429 ||
            (response.status === 403 &&
                (remaining === '0' || bodyText.includes('rate limit') || bodyText.includes('secondary rate')));

        if (limited) {
            const reset = header('x-ratelimit-reset');
            const minutes =
                reset && Number.isFinite(Number(reset))
                    ? Math.max(1, Math.ceil((Number(reset) * 1000 - Date.now()) / 60000))
                    : null;
            const error = new GitHubError(
                'GitHub is limiting requests' +
                    (minutes ? ' for about ' + minutes + ' more minute' + (minutes === 1 ? '' : 's') : '') +
                    '. Nothing is lost: your work is still on this device. Try again when the limit resets.',
                { status: response.status, body: parsed },
            );
            error.rateLimited = true;
            // When GitHub says, remember how long for. Errors are not only shown,
            // they are used to stop asking until the limit resets.
            error.resetAt =
                reset && Number.isFinite(Number(reset))
                    ? Number(reset) * 1000
                    : Date.now() + 60000;
            throw error;
        }

        // 404 and 409 are routine here and are handled by the caller: a repository
        // that does not exist yet, and an empty repository refusing refs and blobs.
        // Logging them made a working sign-in look like a wall of errors.
        if (response.status !== 404 && response.status !== 409) {
            // Path and status only. Never the body: a token response would be in it.
            console.warn('[pydle] github', method, path.split('?')[0], response.status);
        }

        throw new GitHubError(describeError(response.status, parsed), {
            status: response.status,
            body: parsed,
        });
    }

    return parsed;
}
