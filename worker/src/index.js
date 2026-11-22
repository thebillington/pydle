/**
 * pydle CORS shim for GitHub's OAuth device flow.
 *
 * github.com sends no CORS headers, so a static page cannot call the two OAuth
 * endpoints directly. This Worker forwards exactly those two paths to
 * https://github.com, with the status and body untouched, and adds CORS headers
 * for an explicit origin allowlist.
 *
 * It stores nothing, holds no client secret and has no database: the device flow
 * only needs the public client_id, so there is nothing here worth stealing.
 *
 * It does, however, see the token response in transit. NEVER log request or
 * response bodies (or the Authorization/Content-Type + body pair) — the body of
 * POST /login/oauth/access_token contains the access token and refresh token.
 * "Stores nothing" is not "sees nothing".
 */

const GITHUB_ORIGIN = 'https://github.com';
const TIMEOUT_MS = 10_000;
const MAX_AGE_SECONDS = 86_400;

/** Exact paths, and nothing else. No prefix matching, no normalisation. */
const ALLOWED_PATHS = new Set([
    '/login/device/code',
    '/login/oauth/access_token',
]);

/**
 * Origins allowed to read responses, from the comma-separated env var.
 * An unset or empty value allows no origin at all.
 *
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
function allowedOrigins(env) {
    return (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

/**
 * CORS headers for one request. The allow-origin header is only ever set to an
 * origin that is on the list; an unlisted origin gets no header at all and the
 * browser blocks the read. No Origin header means no header.
 *
 * @param {Request} request
 * @param {Record<string, string>} env
 * @returns {Headers}
 */
function corsHeaders(request, env) {
    const headers = new Headers();
    headers.set('Vary', 'Origin');

    const origin = request.headers.get('Origin');
    if (!origin) {
        return headers;
    }

    if (allowedOrigins(env).includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
    }

    return headers;
}

/**
 * Response helper so every reply, errors included, carries CORS headers and is
 * therefore readable by the calling page.
 *
 * @param {number} status
 * @param {Headers} headers
 * @param {BodyInit | null} body
 * @returns {Response}
 */
function reply(status, headers, body) {
    return new Response(body, { status, headers });
}

function jsonError(status, code, request, env) {
    const headers = corsHeaders(request, env);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return reply(status, headers, JSON.stringify({ error: code }));
}

/**
 * Pull client_id out of a form-urlencoded or JSON body. Returns null when the
 * body is unparseable or has no client_id, which the caller treats as a
 * mismatch.
 *
 * @param {string} body
 * @param {string} contentType
 * @returns {string | null}
 */
function parseClientId(body, contentType) {
    try {
        if (contentType.toLowerCase().includes('application/json')) {
            const data = JSON.parse(body);
            return typeof data?.client_id === 'string' ? data.client_id : null;
        }
        return new URLSearchParams(body).get('client_id');
    } catch {
        return null;
    }
}

/**
 * @param {Request} request
 * @param {Record<string, string>} env
 * @returns {Promise<Response>}
 */
async function handleRequest(request, env) {
    const { pathname } = new URL(request.url);

    if (!ALLOWED_PATHS.has(pathname)) {
        return jsonError(404, 'not_found', request, env);
    }

    if (request.method === 'OPTIONS') {
        const headers = corsHeaders(request, env);
        headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
        headers.set('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
        return reply(204, headers, null);
    }

    if (request.method !== 'POST') {
        return jsonError(404, 'not_found', request, env);
    }

    // Read the body once, as text, so it can be forwarded byte-for-byte and also
    // inspected for the client_id pin. Form-urlencoded and JSON both survive this
    // round trip unchanged. Never log it: see the top of this file.
    const body = await request.text();
    const contentType = request.headers.get('Content-Type') || 'application/x-www-form-urlencoded';

    if (env.CLIENT_ID) {
        const clientId = parseClientId(body, contentType);
        if (clientId !== env.CLIENT_ID) {
            return jsonError(403, 'client_id_mismatch', request, env);
        }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let upstream;
    try {
        upstream = await fetch(GITHUB_ORIGIN + pathname, {
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                // GitHub answers form-urlencoded unless JSON is asked for; the
                // page parses JSON, so ask for it explicitly.
                'Accept': 'application/json',
                'User-Agent': 'pydle-auth',
            },
            body,
            signal: controller.signal,
        });
    } catch {
        // Timeout, DNS failure, TLS failure, everything. Do not leak the cause:
        // it can only be infrastructure, and the page cannot act on it.
        return jsonError(502, 'upstream_unreachable', request, env);
    } finally {
        clearTimeout(timer);
    }

    const headers = corsHeaders(request, env);
    const upstreamType = upstream.headers.get('Content-Type');
    if (upstreamType) {
        headers.set('Content-Type', upstreamType);
    }
    // Token responses must never be cached by the browser or an intermediary.
    headers.set('Cache-Control', 'no-store');

    // Status and body are returned exactly as GitHub sent them, so the page sees
    // authorization_pending, slow_down and error codes unchanged. A null-body status
    // must not be handed a stream, so guard that case.
    const passthrough = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
    return reply(upstream.status, headers, passthrough);
}

export default {
    /**
     * @param {Request} request
     * @param {Record<string, string>} env
     * @returns {Promise<Response>}
     */
    async fetch(request, env) {
        const started = Date.now();
        let status = 0;

        try {
            const response = await handleRequest(request, env);
            status = response.status;
            return response;
        } catch (error) {
            status = 500;
            console.log(
                JSON.stringify({
                    event: 'shim_threw',
                    message: error && error.message ? error.message : String(error),
                }),
            );
            throw error;
        } finally {
            // Method, path and status only. Never the body: the token response is
            // in it, and logs are the last place a token should end up.
            const url = new URL(request.url);
            console.log(
                JSON.stringify({
                    event: 'shim',
                    method: request.method,
                    path: url.pathname,
                    status,
                    ms: Date.now() - started,
                }),
            );
        }
    },
};
