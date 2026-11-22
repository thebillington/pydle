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
 * @param {{ token?: string, method?: string, body?: unknown, headers?: Record<string, string> }} [options]
 * @returns {Promise<any>} Parsed JSON, or null for 204 / an empty body.
 * @throws {GitHubError} On any non-ok response. 401 sets `isAuthError`.
 */
export async function ghFetch(path, { token, method = 'GET', body, headers } = {}) {
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

    const response = await fetch(url, { method, headers: requestHeaders, body: payload });
    const text = await response.text();
    const parsed = response.status === 204 ? null : parseBody(text);

    if (!response.ok) {
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
