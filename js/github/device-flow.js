/**
 * GitHub OAuth device flow, spoken through the auth shim.
 *
 * `github.com` sends no CORS headers, so the two login endpoints cannot be called
 * from a page. The shim forwards them and returns GitHub's JSON verbatim.
 *
 * The device flow needs no client secret, which is why the shim is safe to stand
 * in front of. It does see the token in transit — never log request or response
 * bodies here.
 */
import { CONFIG } from '../config.js';

/**
 * A device-flow failure the UI can explain.
 *
 * `code` is GitHub's own error code: `expired_token` and `access_denied` are the
 * two the UI acts on. `authorization_pending` and `slow_down` are never errors.
 */
export class DeviceFlowError extends Error {
    /**
     * @param {string} message
     * @param {{ code?: string, description?: string }} [details]
     */
    constructor(message, { code = 'unknown_error', description } = {}) {
        super(message);
        this.name = 'DeviceFlowError';
        /** @type {string} */
        this.code = code;
        /** @type {string | null} */
        this.description = description ?? null;
    }
}

/**
 * An error shaped like the browser's own abort error.
 *
 * @returns {Error}
 */
function abortError() {
    const error = new Error('The device flow was cancelled.');
    error.name = 'AbortError';
    return error;
}

/**
 * Throw if the caller aborted the flow.
 *
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
    if (signal && signal.aborted) {
        throw abortError();
    }
}

/**
 * Sleep that can be interrupted by an AbortSignal.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(abortError());
            return;
        }

        const timer = setTimeout(() => {
            finish();
            resolve();
        }, ms);

        function onAbort() {
            clearTimeout(timer);
            finish();
            reject(abortError());
        }

        function finish() {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

/**
 * Wait, calling `onTick` about once a second so the UI can show a countdown.
 *
 * @param {number} ms
 * @param {{ startedAt: number, expiresIn: number, signal?: AbortSignal, onTick?: (tick: { elapsed: number, remaining: number }) => void }} options
 * @returns {Promise<void>}
 */
async function pause(ms, { startedAt, expiresIn, signal, onTick }) {
    const end = Date.now() + ms;

    for (;;) {
        throwIfAborted(signal);

        const left = end - Date.now();
        if (left <= 0) {
            break;
        }

        await sleep(Math.min(1000, left), signal);

        if (onTick) {
            const elapsed = Math.floor((Date.now() - startedAt) / 1000);
            const remaining = Math.max(0, Math.floor(expiresIn - (Date.now() - startedAt) / 1000));
            onTick({ elapsed, remaining });
        }
    }
}

/**
 * Parse a token-endpoint body.
 *
 * GitHub answers JSON, but the OAuth spec allows form encoding, so accept both.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseTokenBody(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
        return {};
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return Object.fromEntries(new URLSearchParams(trimmed));
    }
}

/**
 * POST a form to one of the shim's login endpoints.
 *
 * @param {string} path
 * @param {Record<string, string>} params
 * @param {string} shimBase
 * @returns {Promise<Record<string, any>>}
 */
async function postForm(path, params, shimBase) {
    const response = await fetch(`${shimBase}${path}`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
    });

    const text = await response.text();
    const data = parseTokenBody(text);

    if (!response.ok) {
        const code = typeof data.error === 'string' ? data.error : 'http_error';
        const description = typeof data.error_description === 'string' ? data.error_description : undefined;
        throw new DeviceFlowError(`GitHub login failed (${code}).`, { code, description });
    }

    return data;
}

/**
 * Read a number from either JSON or a form-encoded body (where it is a string).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * The token shape the vault stores and the rest of the app consumes.
 *
 * @param {Record<string, any>} data
 * @returns {{ accessToken: string, refreshToken: string | null, expiresIn: number | null, scope: string }}
 */
function toTokens(data) {
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresIn: toNumber(data.expires_in),
        scope: data.scope ?? '',
    };
}

/**
 * Ask GitHub for a code to show the user.
 *
 * @param {{ clientId?: string, scopes?: string[] | string, shimBase?: string }} [options]
 * @returns {Promise<{ deviceCode: string, userCode: string, verificationUri: string, expiresIn: number, interval: number }>}
 */
export async function startDeviceFlow({ clientId = CONFIG.clientId, scopes = CONFIG.scopes, shimBase = CONFIG.shimBase } = {}) {
    const scope = Array.isArray(scopes) ? scopes.join(' ') : String(scopes ?? '');
    const data = await postForm('/login/device/code', { client_id: clientId, scope }, shimBase);

    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: toNumber(data.expires_in) ?? 900,
        interval: toNumber(data.interval) ?? 5,
    };
}

/**
 * Poll the token endpoint until the user approves, declines, or the code expires.
 *
 * RFC 8628 loop: honour `interval`, add 5 seconds for `slow_down` and keep that
 * longer interval for all later polls. `authorization_pending` just means "not
 * yet". Aborting rejects with an `AbortError`.
 *
 * @param {{ clientId?: string, deviceCode: string, interval?: number, expiresIn?: number, shimBase?: string, signal?: AbortSignal, onTick?: (tick: { elapsed: number, remaining: number }) => void }} options
 * @returns {Promise<{ accessToken: string, refreshToken: string | null, expiresIn: number | null, scope: string }>}
 */
export async function pollForToken({
    clientId = CONFIG.clientId,
    deviceCode,
    interval = 5,
    expiresIn = 900,
    shimBase = CONFIG.shimBase,
    signal,
    onTick,
} = {}) {
    const startedAt = Date.now();
    let currentInterval = Math.max(1, Number(interval) || 5);

    for (;;) {
        throwIfAborted(signal);

        const remaining = expiresIn - (Date.now() - startedAt) / 1000;
        if (remaining <= 0) {
            throw new DeviceFlowError('The device code expired. Start again for a new code.', {
                code: 'expired_token',
            });
        }

        await pause(Math.min(currentInterval * 1000, remaining * 1000), {
            startedAt,
            expiresIn,
            signal,
            onTick,
        });
        throwIfAborted(signal);

        const data = await postForm(
            '/login/oauth/access_token',
            {
                client_id: clientId,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            },
            shimBase,
        );

        if (data.access_token) {
            return toTokens(data);
        }

        const code = typeof data.error === 'string' ? data.error : '';
        const description = typeof data.error_description === 'string' ? data.error_description : undefined;

        if (code === 'authorization_pending') {
            continue;
        }
        if (code === 'slow_down') {
            currentInterval += 5;
            continue;
        }
        if (code === 'expired_token') {
            throw new DeviceFlowError('The device code expired. Start again for a new code.', {
                code,
                description,
            });
        }
        if (code === 'access_denied') {
            throw new DeviceFlowError('You declined the sign-in request.', { code, description });
        }

        throw new DeviceFlowError(`GitHub login failed (${code || 'no token returned'}).`, {
            code: code || 'unknown_error',
            description,
        });
    }
}

/**
 * Trade an `offline_access` refresh token for a new access token.
 *
 * @param {{ clientId?: string, refreshToken: string, shimBase?: string }} options
 * @returns {Promise<{ accessToken: string, refreshToken: string | null, expiresIn: number | null, scope: string }>}
 */
export async function refreshAccessToken({ clientId = CONFIG.clientId, refreshToken, shimBase = CONFIG.shimBase } = {}) {
    const data = await postForm(
        '/login/oauth/access_token',
        {
            client_id: clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        },
        shimBase,
    );

    if (!data.access_token) {
        const code = typeof data.error === 'string' ? data.error : 'unknown_error';
        const description = typeof data.error_description === 'string' ? data.error_description : undefined;
        throw new DeviceFlowError('GitHub would not refresh the token. Reconnect to continue.', {
            code,
            description,
        });
    }

    return toTokens(data);
}
