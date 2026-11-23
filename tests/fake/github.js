/**
 * An in-memory GitHub repository behind a `fetch` replacement.
 *
 * It implements only the endpoints pydle uses, but it implements them the way
 * git does where it matters: blob, tree and commit SHAs are real git object
 * hashes, so the SHA the client computes in `gitBlobHash()` is the same SHA the
 * fake tree contains. That is what makes "is this file already in the
 * repository?" a meaningful question rather than a string comparison against a
 * made-up value.
 *
 * Two GitHub behaviours are reproduced on purpose:
 *
 * - A ref lookup in an empty repository answers 409 "Git Repository is empty",
 *   and the git data endpoints refuse blobs until a commit exists.
 * - Moving a branch with PATCH answers 422 unless the new commit's first parent
 *   is the commit the branch currently points at. That is the non-fast-forward
 *   rule, and it is what `js/github/commit.js` retries on.
 *
 * Test controls live on the object returned by `installFakeGitHub()`; see the
 * bottom of this file.
 */

import { createHash } from 'node:crypto';

const PYDLE_JSON = '{"format":1,"app":"pydle"}';

/**
 * Git's object ID: SHA-1 over `<type> <byte length>\0<content>`.
 *
 * @param {'blob' | 'tree' | 'commit'} type
 * @param {Buffer} content
 * @returns {string} Hex SHA.
 */
function hashObject(type, content) {
    const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
    return createHash('sha1').update(header).update(content).digest('hex');
}

/**
 * A fetch Response stand-in. `ghFetch` reads `ok`, `status`, `headers.get` and
 * `text()`; nothing else is needed.
 *
 * @param {unknown} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function respond(body, status = 200, headers = {}) {
    const lowered = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
    let text = '';
    if (body !== null && body !== undefined) {
        text = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => lowered[String(name).toLowerCase()] ?? null },
        text: async () => text,
    };
}

/**
 * @param {unknown} raw
 * @returns {any}
 */
function parseBody(raw) {
    if (typeof raw !== 'string' || raw === '') {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Install a fake GitHub and return the repository plus its test controls.
 *
 * @param {{ owner?: string, repo?: string, branch?: string }} [options]
 */
export function installFakeGitHub({
    owner = 'octocat',
    repo = 'pydle-workspace',
    branch = 'main',
} = {}) {
    const previousFetch = globalThis.fetch;

    const user = {
        login: owner,
        id: 1,
        name: 'Octo Cat',
    };
    const identity = {
        name: user.name,
        email: `${user.id}+${user.login}@users.noreply.github.com`,
    };

    /** @type {string | null} */
    let head = null;
    /** @type {Map<string, Buffer>} */
    const blobs = new Map();
    /** @type {Map<string, Map<string, { mode: string, type: string, sha: string }>>} */
    const trees = new Map();
    /** @type {Map<string, any>} */
    const commits = new Map();
    /** @type {Array<{ method: string, path: string, body: any }>} */
    const requests = [];
    /** @type {Array<{ status: number, body: any, headers: Record<string, string>, options: any }>} */
    const failures = [];

    let rateUntil = 0;
    let offlineMode = false;
    let lastTimestamp = 0;

    const repoObject = () => {
        const flat = flatAt(head);
        let bytes = 0;
        if (flat) {
            for (const entry of flat.values()) {
                bytes += blobs.get(entry.sha)?.length ?? 0;
            }
        }
        return {
            id: 1,
            name: repo,
            full_name: `${owner}/${repo}`,
            private: true,
            owner: { login: owner },
            default_branch: branch,
            size: flat ? Math.max(1, Math.ceil(bytes / 1024)) : 0,
            permissions: { admin: true, push: true, pull: true },
        };
    };

    /**
     * The flat file map behind a tree SHA or a commit SHA.
     *
     * @param {string | null} sha
     * @returns {Map<string, { mode: string, type: string, sha: string }> | null}
     */
    function flatAt(sha) {
        if (!sha) {
            return null;
        }
        if (commits.has(sha)) {
            return trees.get(commits.get(sha).treeSha) ?? null;
        }
        return trees.get(sha) ?? null;
    }

    /**
     * Store a blob and return its git SHA.
     *
     * @param {Buffer} bytes
     * @returns {string}
     */
    function writeBlob(bytes) {
        const sha = hashObject('blob', bytes);
        blobs.set(sha, bytes);
        return sha;
    }

    /**
     * Build (and store) a nested tree from a flat path map, returning its SHA.
     *
     * Git's tree object is a sequence of `<mode> <name>\0<20 raw sha bytes>`
     * records, sorted by name with directories compared as `name/`. The SHA is
     * the hash of that byte sequence with a `tree <len>\0` header.
     *
     * @param {Map<string, { mode: string, type: string, sha: string }>} flat
     * @returns {string}
     */
    function buildTree(flat) {
        /** @param {{ files: Map<string, any>, dirs: Map<string, any> }} node */
        const write = (node) => {
            const records = [];
            const relative = new Map();

            for (const [name, entry] of node.files) {
                records.push({ name, sortKey: name, mode: entry.mode || '100644', sha: entry.sha });
                relative.set(name, { ...entry, mode: entry.mode || '100644', type: 'blob' });
            }

            for (const [name, child] of node.dirs) {
                const sub = write(child);
                // A directory sorts as though its name ended in a slash.
                records.push({ name, sortKey: `${name}/`, mode: '40000', sha: sub.sha });
                for (const [path, entry] of sub.flat) {
                    relative.set(`${name}/${path}`, entry);
                }
            }

            records.sort((a, b) =>
                Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')),
            );

            const parts = [];
            for (const record of records) {
                parts.push(Buffer.from(`${record.mode} ${record.name}\0`, 'utf8'));
                parts.push(Buffer.from(record.sha, 'hex'));
            }
            const content = Buffer.concat(parts);
            const sha = hashObject('tree', content);
            trees.set(sha, relative);
            return { sha, flat: relative };
        };

        const root = { files: new Map(), dirs: new Map() };
        for (const [path, entry] of flat) {
            const segments = path.split('/');
            const name = segments.pop();
            let node = root;
            for (const segment of segments) {
                if (!node.dirs.has(segment)) {
                    node.dirs.set(segment, { files: new Map(), dirs: new Map() });
                }
                node = node.dirs.get(segment);
            }
            node.files.set(name, entry);
        }

        return write(root).sha;
    }

    /** Next commit timestamp: strictly increasing, so equal inputs still differ. */
    function nextTimestamp() {
        const now = Math.floor(Date.now() / 1000);
        lastTimestamp = Math.max(now, lastTimestamp + 1);
        return lastTimestamp;
    }

    /**
     * Create a commit object and return its SHA.
     *
     * @param {{ message: string, treeSha: string, parents: string[], author?: any, committer?: any }} options
     */
    function writeCommit({ message, treeSha, parents, author = identity, committer = identity }) {
        const seconds = nextTimestamp();
        const date = new Date(seconds * 1000).toISOString();
        const person = (who) => `${who.name ?? identity.name} <${who.email ?? identity.email}> ${seconds} +0000`;
        const lines = [`tree ${treeSha}`];
        for (const parent of parents) {
            lines.push(`parent ${parent}`);
        }
        lines.push(`author ${person(author)}`);
        lines.push(`committer ${person(committer)}`);
        lines.push('', message);

        const sha = hashObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
        commits.set(sha, {
            sha,
            treeSha,
            parents: [...parents],
            message,
            author: { name: author.name ?? identity.name, email: author.email ?? identity.email, date },
            committer: {
                name: committer.name ?? identity.name,
                email: committer.email ?? identity.email,
                date,
            },
        });
        return sha;
    }

    /**
     * Apply path -> content upserts (and null deletes) on top of a flat map.
     *
     * @param {Map<string, any> | null} base
     * @param {Record<string, string | null>} files
     */
    function applyFiles(base, files) {
        const flat = new Map(base ?? []);
        for (const [path, content] of Object.entries(files || {})) {
            if (content === null) {
                flat.delete(path);
            } else {
                flat.set(path, {
                    mode: '100644',
                    type: 'blob',
                    sha: writeBlob(Buffer.from(String(content), 'utf8')),
                });
            }
        }
        return flat;
    }

    /**
     * The public commit shape, which is what the client reads.
     *
     * @param {any} commit
     */
    function commitJson(commit) {
        if (!commit) {
            return null;
        }
        return {
            sha: commit.sha,
            message: commit.message,
            tree: { sha: commit.treeSha },
            parents: commit.parents.map((sha) => ({ sha })),
            author: commit.author,
            committer: commit.committer,
        };
    }

    /** Commits reachable from the branch, newest first. */
    function history() {
        const list = [];
        const seen = new Set();
        let sha = head;
        while (sha && commits.has(sha) && !seen.has(sha)) {
            seen.add(sha);
            const commit = commits.get(sha);
            list.push(commit);
            sha = commit.parents[0] ?? null;
        }
        return list;
    }

    /**
     * Resolve a ref, branch name or SHA to a commit SHA.
     *
     * @param {string | null | undefined} ref
     * @returns {string | null}
     */
    function resolveRef(ref) {
        if (!ref || ref === branch) {
            return head;
        }
        if (commits.has(ref)) {
            return ref;
        }
        return head;
    }

    /**
     * Differences between a commit and its first parent, restricted to `scope`.
     *
     * @param {any} commit
     * @param {string | null} scope
     */
    function filesTouched(commit, scope) {
        const before = flatAt(commit.parents[0] ?? null) ?? new Map();
        const after = flatAt(commit.sha) ?? new Map();
        const paths = new Set([...before.keys(), ...after.keys()]);
        const changed = [];

        for (const path of paths) {
            if (scope && !(path === scope || path.startsWith(`${scope}/`))) {
                continue;
            }
            const a = before.get(path);
            const b = after.get(path);
            if (a && b && a.sha === b.sha) {
                continue;
            }
            changed.push({ path, before: a ?? null, after: b ?? null });
        }
        return changed;
    }

    /**
     * Route one request. Returns a Response stand-in.
     *
     * @param {string} method
     * @param {URL} url
     * @param {any} body
     */
    function route(method, url, body) {
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

        if (method === 'GET' && parts.length === 1 && parts[0] === 'user') {
            return respond(user);
        }

        if (method === 'POST' && parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
            if (body && body.name === repo) {
                return respond({ message: 'Repository creation failed: name already exists on this account.' }, 422);
            }
            return respond(repoObject(), 201);
        }

        if (parts[0] !== 'repos' || parts[1] !== owner || parts[2] !== repo) {
            return respond({ message: 'Not Found' }, 404);
        }

        // GET /repos/:owner/:repo
        if (parts.length === 3) {
            return respond(repoObject());
        }

        const area = parts[3];

        if (area === 'contents') {
            const path = parts.slice(4).join('/');
            const ref = url.searchParams.get('ref');
            const commitSha = resolveRef(ref);

            if (method === 'GET') {
                const flat = flatAt(commitSha);
                const entry = flat?.get(path);
                if (!entry) {
                    return respond({ message: 'Not Found' }, 404);
                }
                const bytes = blobs.get(entry.sha) ?? Buffer.alloc(0);
                return respond({
                    name: path.split('/').pop(),
                    path,
                    sha: entry.sha,
                    size: bytes.length,
                    type: 'file',
                    content: bytes.toString('base64'),
                    encoding: 'base64',
                });
            }

            if (method === 'PUT') {
                // The Contents API is the one write that works on an empty
                // repository, which is why the scaffold seeds through it.
                const content = Buffer.from(String(body?.content ?? ''), 'base64');
                const sha = writeBlob(content);
                const flat = new Map(flatAt(commitSha) ?? []);
                flat.set(path, { mode: '100644', type: 'blob', sha });
                const treeSha = buildTree(flat);
                const parents = commitSha ? [commitSha] : [];
                const commit = writeCommit({
                    message: body?.message || `Create ${path}`,
                    treeSha,
                    parents,
                });
                head = commit;
                return respond({
                    content: { path, sha, type: 'file' },
                    commit: commitJson(commits.get(commit)),
                }, 201);
            }
        }

        if (area === 'git') {
            const kind = parts[4];

            if (kind === 'blobs') {
                if (method === 'POST') {
                    // An empty repository refuses git data writes; the scaffold
                    // depends on this 409 to fall back to the Contents API.
                    if (!head) {
                        return respond({ message: 'Git Repository is empty.' }, 409);
                    }
                    const raw = String(body?.content ?? '');
                    const bytes = body?.encoding === 'base64'
                        ? Buffer.from(raw, 'base64')
                        : Buffer.from(raw, 'utf8');
                    return respond({ sha: writeBlob(bytes) }, 201);
                }
                if (method === 'GET' && parts.length === 6) {
                    const bytes = blobs.get(parts[5]);
                    if (!bytes) {
                        return respond({ message: 'Not Found' }, 404);
                    }
                    return respond({
                        sha: parts[5],
                        size: bytes.length,
                        content: bytes.toString('base64'),
                        encoding: 'base64',
                    });
                }
            }

            if (kind === 'trees') {
                if (method === 'POST' && parts.length === 5) {
                    if (!head) {
                        return respond({ message: 'Git Repository is empty.' }, 409);
                    }
                    const base = body?.base_tree ? flatAt(body.base_tree) : new Map();
                    if (body?.base_tree && !base) {
                        return respond({ message: 'Not Found' }, 404);
                    }
                    const flat = new Map(base ?? []);
                    for (const entry of body?.tree ?? []) {
                        if (entry.sha === null || entry.sha === undefined) {
                            flat.delete(entry.path);
                        } else {
                            flat.set(entry.path, {
                                mode: entry.mode || '100644',
                                type: entry.type || 'blob',
                                sha: entry.sha,
                            });
                        }
                    }
                    const sha = buildTree(flat);
                    return respond({ sha, tree: [...flat.entries()].map(([path, entry]) => ({ path, ...entry })) }, 201);
                }

                if (method === 'GET' && parts.length === 6) {
                    const commitSha = commits.has(parts[5]) ? parts[5] : null;
                    const treeSha = commitSha ? commits.get(commitSha).treeSha : parts[5];
                    const flat = trees.get(treeSha);
                    if (!flat) {
                        return respond({ message: 'Not Found' }, 404);
                    }
                    const recursive = ['1', 'true'].includes(url.searchParams.get('recursive') ?? '');
                    const entries = [];
                    for (const [path, entry] of flat) {
                        if (!recursive && path.includes('/')) {
                            continue;
                        }
                        entries.push({
                            path,
                            mode: entry.mode,
                            type: entry.type,
                            sha: entry.sha,
                            size: blobs.get(entry.sha)?.length ?? 0,
                        });
                    }
                    entries.sort((a, b) => a.path.localeCompare(b.path));
                    return respond({ sha: treeSha, tree: entries, truncated: false });
                }
            }

            if (kind === 'commits') {
                if (method === 'POST') {
                    if (!body?.tree || !trees.has(body.tree)) {
                        return respond({ message: 'Tree not found' }, 404);
                    }
                    const parents = Array.isArray(body.parents) ? body.parents : [];
                    for (const parent of parents) {
                        if (!commits.has(parent)) {
                            return respond({ message: 'Parent not found' }, 404);
                        }
                    }
                    const sha = writeCommit({
                        message: body.message || '',
                        treeSha: body.tree,
                        parents,
                        author: body.author ?? identity,
                        committer: body.committer ?? identity,
                    });
                    return respond(commitJson(commits.get(sha)), 201);
                }

                if (method === 'GET' && parts.length === 6) {
                    const commit = commits.get(parts[5]);
                    return commit ? respond(commitJson(commit)) : respond({ message: 'Not Found' }, 404);
                }
            }

            if (kind === 'ref' || kind === 'refs') {
                const sub = parts[5];
                const name = parts.slice(6).join('/');

                if (method === 'GET' && sub === 'heads') {
                    if (!head) {
                        return respond({ message: 'Git Repository is empty.' }, 409);
                    }
                    if (name !== branch) {
                        return respond({ message: 'Not Found' }, 404);
                    }
                    return respond({ ref: `refs/heads/${branch}`, object: { sha: head, type: 'commit' } });
                }

                if (method === 'POST' && kind === 'refs') {
                    if (head) {
                        return respond({ message: 'Reference already exists' }, 422);
                    }
                    if (!commits.has(body?.sha)) {
                        return respond({ message: 'Object does not exist' }, 422);
                    }
                    head = body.sha;
                    return respond({ ref: body?.ref ?? `refs/heads/${branch}`, object: { sha: head } }, 201);
                }

                if (method === 'PATCH' && sub === 'heads') {
                    if (name !== branch) {
                        return respond({ message: 'Not Found' }, 404);
                    }
                    if (!head) {
                        return respond({ message: 'Reference does not exist' }, 422);
                    }
                    const next = commits.get(body?.sha);
                    if (!next) {
                        return respond({ message: 'Object does not exist' }, 422);
                    }
                    if (body.sha === head) {
                        return respond({ ref: `refs/heads/${branch}`, object: { sha: head } });
                    }

                    // The non-fast-forward rule. A ref update may only advance the
                    // branch: the new commit must have the branch's current commit
                    // as its first parent. Anything else is a 422, which is what
                    // the client treats as "another device moved the branch".
                    if (next.parents[0] !== head) {
                        return respond({ message: 'Update is not a fast forward' }, 422);
                    }

                    head = body.sha;
                    return respond({ ref: `refs/heads/${branch}`, object: { sha: head } });
                }
            }
        }

        if (area === 'commits') {
            if (method === 'GET' && parts.length === 4) {
                const scope = url.searchParams.get('path');
                const requested = Number(url.searchParams.get('per_page'));
                const limit = Number.isFinite(requested) && requested > 0 ? requested : 30;

                const list = history()
                    .filter((commit) => filesTouched(commit, scope).length > 0)
                    .slice(0, limit)
                    .map((commit) => commitJson(commit));

                return respond(list);
            }

            if (method === 'GET' && parts.length === 5) {
                const commit = commits.get(parts[4]);
                if (!commit) {
                    return respond({ message: 'Not Found' }, 404);
                }
                const files = filesTouched(commit, null).map((change) => ({
                    filename: change.path,
                    status: !change.before ? 'added' : !change.after ? 'removed' : 'modified',
                    additions: 0,
                    deletions: 0,
                    patch: '',
                }));
                return respond({ ...commitJson(commit), files });
            }
        }

        return respond({ message: `No fake route for ${method} ${url.pathname}` }, 501);
    }

    /** @param {{ method: string, path: string, body: any }} request */
    function takeFailure(request) {
        for (let index = 0; index < failures.length; index += 1) {
            const failure = failures[index];
            if (failure.options.method && failure.options.method !== request.method) {
                continue;
            }
            if (typeof failure.options.match === 'function' && !failure.options.match(request)) {
                continue;
            }
            failures.splice(index, 1);
            return failure;
        }
        return null;
    }

    /** The replacement for `globalThis.fetch`. */
    const fakeFetch = async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const method = String(options.method ?? 'GET').toUpperCase();
        const body = parseBody(options.body);

        requests.push({ method, path: url.pathname, body });

        if (offlineMode) {
            throw new TypeError('Failed to fetch');
        }

        if (Date.now() < rateUntil) {
            return respond(
                { message: 'API rate limit exceeded for this account.' },
                403,
                {
                    'x-ratelimit-limit': '5000',
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset': String(Math.ceil(rateUntil / 1000)),
                    'retry-after': String(Math.max(1, Math.ceil((rateUntil - Date.now()) / 1000))),
                },
            );
        }

        const failure = takeFailure({ method, path: url.pathname, body });
        if (failure) {
            if (typeof failure.options.beforeResponse === 'function') {
                await failure.options.beforeResponse();
            }
            return respond(failure.body ?? { message: 'Injected failure' }, failure.status, failure.headers);
        }

        return route(method, url, body);
    };

    globalThis.fetch = fakeFetch;

    return {
        /** Initial commit containing exactly these files. */
        seed(files) {
            commits.clear();
            trees.clear();
            blobs.clear();
            const flat = applyFiles(null, files);
            const treeSha = buildTree(flat);
            head = writeCommit({
                message: 'Seed repository',
                treeSha,
                parents: [],
            });
            return head;
        },

        /** Make a commit on another device, moving the branch. */
        commitElsewhere(files, message = 'Changed on another device') {
            const flat = applyFiles(flatAt(head), files);
            const treeSha = buildTree(flat);
            head = writeCommit({ message, treeSha, parents: head ? [head] : [] });
            return head;
        },

        /**
         * Fail the next matching request.
         *
         * `options.method` restricts it (e.g. `'PATCH'`) and
         * `options.beforeResponse` runs first, which is how a test can move HEAD
         * just before a ref update is refused. Without a matcher this fails the
         * very next request.
         */
        failNext(status, body, headers = {}, options = {}) {
            failures.push({ status, body, headers, options });
        },

        /** Answer every request with a 403 rate limit until this time. */
        rateLimitUntil(timestamp) {
            rateUntil = timestamp;
        },

        /** Make every request reject as if the network were down. */
        offline(flag = true) {
            offlineMode = flag;
        },

        get requests() {
            return requests;
        },

        requestCount() {
            return requests.length;
        },

        resetRequests() {
            requests.length = 0;
        },

        /** Branch SHA currently on the fake repository. */
        head() {
            return head;
        },

        /** Commits reachable from the branch, newest first. */
        history() {
            return history().map((commit) => ({
                sha: commit.sha,
                message: commit.message,
                parents: [...commit.parents],
            }));
        },

        /** Put the original fetch back. */
        restore() {
            if (globalThis.fetch === fakeFetch) {
                globalThis.fetch = previousFetch;
            }
        },
    };
}

export { PYDLE_JSON };
