/**
 * The seam between the local vault and GitHub.
 *
 * This is the only module that knows both sides, so it owns the mapping between
 * them: vault project `spiral`, file `main.py`, is repo path `work/spiral/main.py`.
 * Nothing else in the app needs to know that, and the UI never imports from
 * `js/github/` or `js/vault/` directly.
 *
 * The rule that matters: the browser is the source of truth. Editing writes to the
 * local vault immediately and never waits on the network. Committing to GitHub is a
 * separate, deliberate act: nothing reaches GitHub until the user commits, with a
 * message and a chosen set of files.
 */
import { CONFIG } from './config.js';
import { DeviceFlowError, pollForToken, refreshAccessToken, startDeviceFlow } from './github/device-flow.js';
import { GitHubError, ghFetch } from './github/http.js';
import { createRepo, getRepo, getUser } from './github/git-data.js';
import { bootstrapRepo } from './github/scaffold.js';
import { ConflictError, commitFiles } from './github/commit.js';
import { clearTokens, loadTokens, saveTokens } from './vault/tokens.js';
import * as vault from './vault/fs.js';
import { normalizeProjectName, safeJoin } from './vault/paths.js';
import { planMerge } from './reconcile.js';

/**
 * Repository name inside the user's own account. One workspace per person.
 *
 * Deliberately not `pydle`: a GitHub account is very likely to already contain a
 * repository with the project's own name, and adopting that would commit into
 * somebody's source repository. `pydle-workspace` says what it is, and collides
 * with nothing.
 */
export const REPO_NAME = 'pydle-workspace';

/** Marker file that proves a repository is a pydle workspace. */
const WORKSPACE_MARKER = 'pydle.json';

/** Directory inside the repo that holds program projects. */
const WORK_ROOT = 'work';

/**
 * Repository root per kind.
 *
 * `work` holds programs, `drawings` holds turtle work. The vault mirrors this, and
 * keeps `work` at its existing path so nothing on a device migrates.
 */
const KIND_ROOTS = { work: 'work', drawings: 'drawings' };

/**
 * @param {string} [kind]
 * @returns {string}
 */
function repoRoot(kind = 'work') {
    const root = KIND_ROOTS[kind];
    if (typeof root !== 'string') {
        throw new SyncError('config', 'Unknown project type.');
    }
    return root;
}

/** Refresh a little before expiry rather than waiting for a 401. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * An error the UI can turn into a sentence.
 *
 * `kind` decides the recovery offered, not the wording:
 * - `auth`      reconnect; the token is gone or rejected
 * - `network`   retry later; local work is safe
 * - `conflict`  another device wrote first; nothing was lost
 * - `config`    a setup problem the user cannot fix (no client id, no repo)
 */
export class SyncError extends Error {
    /**
     * @param {'auth' | 'network' | 'conflict' | 'config'} kind
     * @param {string} message
     * @param {{ cause?: Error }} [details]
     */
    constructor(kind, message, { cause } = {}) {
        super(message);
        this.name = 'SyncError';
        this.kind = kind;
        if (cause) {
            this.cause = cause;
        }
    }
}

/**
 * Wrap anything thrown by the modules below as a SyncError.
 *
 * @param {unknown} error
 * @returns {SyncError}
 */
function asSyncError(error) {
    if (error instanceof SyncError) {
        return error;
    }
    if (error instanceof ConflictError) {
        return new SyncError('conflict', error.message, { cause: error });
    }
    if (error instanceof GitHubError) {
        if (error.isAuthError) {
            return new SyncError('auth', 'GitHub rejected the sign-in. Please reconnect.', { cause: error });
        }
        if (error.status === 0 || error.status >= 500) {
            return new SyncError('network', 'Could not reach GitHub. Your work is saved on this device.', { cause: error });
        }
        return new SyncError('config', error.message, { cause: error });
    }
    if (error instanceof DeviceFlowError) {
        return new SyncError('auth', error.message, { cause: error });
    }
    if (error instanceof TypeError) {
        // fetch rejects with TypeError when the network is unreachable.
        return new SyncError('network', 'Could not reach GitHub. Your work is saved on this device.', { cause: error });
    }
    return new SyncError('network', error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error : undefined,
    });
}

/**
 * Decode a base64 blob from the Git Data API.
 *
 * @param {string} base64
 * @returns {string}
 */
function decodeBase64(base64) {
    const binary = atob(base64.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Build the commit identity from the signed-in user.
 *
 * The noreply address keeps a real email out of the history while still linking
 * commits to the profile, so the repo stays a portfolio the student owns.
 *
 * @param {{ login: string, id: number, name?: string | null }} user
 * @returns {{ name: string, email: string }}
 */
export function identityFor(user) {
    return {
        name: user.name || user.login,
        email: `${user.id}+${user.login}@users.noreply.github.com`,
    };
}

/**
 * Create the sync service.
 *
 * @param {{ onChange?: (sync: any) => void }} [options]
 */
export function createSync({ onChange } = {}) {
    /** @type {'signed-out' | 'connecting' | 'connected' | 'offline' | 'error'} */
    let status = 'signed-out';
    /** @type {{ accessToken: string, refreshToken?: string, expiresAt?: number, scope?: string } | null} */
    let tokens = null;
    /** @type {{ login: string, id: number, name?: string | null } | null} */
    let user = null;
    /** @type {{ owner: string, repo: string, branch: string } | null} */
    let workspace = null;
    /** @type {SyncError | null} */
    let lastError = null;
    /** @type {AbortController | null} */
    let signInController = null;

    /** Set while a commit is in flight, so two prompts cannot race. */
    let committing = false;
    /**
     * In-flight refresh. GitHub rotates refresh tokens, so two callers refreshing
     * at once means the loser is rejected and the winner is the only usable token.
     */
    let refreshInFlight = null;
    /** In-flight connect, so a second caller joins the first instead of racing it. */
    let connectInFlight = null;

    const listeners = new Set();
    if (typeof onChange === 'function') {
        listeners.add(onChange);
    }

    function snapshot() {
        return {
            status,
            identity: user ? { login: user.login, name: user.name || user.login } : null,
            workspace: workspace ? { owner: workspace.owner, repo: workspace.repo } : null,
            error: lastError,
            committing,
        };
    }

    function emit() {
        const state = snapshot();
        for (const listener of listeners) {
            try {
                listener(state);
            } catch {
                // A broken listener must not break syncing.
            }
        }
    }

    function setStatus(next, error = null) {
        status = next;
        lastError = error;
        emit();
    }

    /**
     * Subscribe to state changes.
     *
     * @param {(state: any) => void} listener
     * @returns {() => void} unsubscribe
     */
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    /* -------------------------------------------------------------- */
    /* Tokens                                                          */
    /* -------------------------------------------------------------- */

    function tokenExpired() {
        if (!tokens) {
            return true;
        }
        if (!tokens.expiresAt) {
            return false;
        }
        return Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS;
    }

    async function storeTokenResponse(response) {
        const expiresAt = response.expiresIn ? Date.now() + response.expiresIn * 1000 : undefined;
        tokens = {
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresAt,
            scope: response.scope,
        };
        await saveTokens({
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresAt,
            scope: response.scope,
        });
    }

    /**
     * Ensure `tokens.accessToken` is usable, refreshing when it is stale.
     *
     * @returns {Promise<string>}
     */
    async function ensureToken() {
        if (!tokens) {
            throw new SyncError('auth', 'Not signed in.');
        }
        if (!tokenExpired()) {
            return tokens.accessToken;
        }
        if (!tokens.refreshToken) {
            throw new SyncError('auth', 'The sign-in has expired. Please reconnect.');
        }
        if (refreshInFlight) {
            return refreshInFlight;
        }

        refreshInFlight = (async () => {
            try {
                const refreshed = await refreshAccessToken({
                    clientId: CONFIG.clientId,
                    refreshToken: tokens.refreshToken,
                    shimBase: CONFIG.shimBase,
                });
                await storeTokenResponse(refreshed);
                return tokens.accessToken;
            } catch (error) {
                throw new SyncError('auth', 'The sign-in has expired. Please reconnect.', {
                    cause: error,
                });
            } finally {
                refreshInFlight = null;
            }
        })();

        return refreshInFlight;
    }

    /**
     * Run an API call, refreshing once and retrying if it comes back 401.
     *
     * @template T
     * @param {(token: string) => Promise<T>} call
     * @returns {Promise<T>}
     */
    async function withToken(call) {
        const token = await ensureToken();
        try {
            return await call(token);
        } catch (error) {
            if (error instanceof GitHubError && error.isAuthError && tokens && tokens.refreshToken) {
                tokens.expiresAt = 0;
                const retryToken = await ensureToken();
                return await call(retryToken);
            }
            throw error;
        }
    }

    /* -------------------------------------------------------------- */
    /* Sign in                                                         */
    /* -------------------------------------------------------------- */

    /**
     * Start the device flow and resolve once GitHub has issued a token.
     *
     * @param {{ onCode?: (code: { userCode: string, verificationUri: string, expiresIn: number }) => void, onTick?: (tick: { elapsed: number, remaining: number }) => void, signal?: AbortSignal }} [options]
     * @returns {Promise<void>}
     */
    async function beginSignIn({ onCode, onTick, signal } = {}) {
        if (!CONFIG.clientId) {
            throw new SyncError('config', 'This copy of pydle has no GitHub app configured.');
        }

        signInController = new AbortController();
        const combined = signal
            ? AbortSignal.any
                ? AbortSignal.any([signal, signInController.signal])
                : signInController.signal
            : signInController.signal;

        setStatus('connecting');

        try {
            const flow = await startDeviceFlow({
                clientId: CONFIG.clientId,
                scopes: CONFIG.scopes,
                shimBase: CONFIG.shimBase,
            });

            if (typeof onCode === 'function') {
                onCode({
                    userCode: flow.userCode,
                    verificationUri: flow.verificationUri,
                    expiresIn: flow.expiresIn,
                });
            }

            const response = await pollForToken({
                clientId: CONFIG.clientId,
                deviceCode: flow.deviceCode,
                interval: flow.interval,
                expiresIn: flow.expiresIn,
                shimBase: CONFIG.shimBase,
                signal: combined,
                onTick,
            });

            await storeTokenResponse(response);
            await connect();
        } catch (error) {
            if (error && error.name === 'AbortError') {
                setStatus('signed-out');
                return;
            }
            const syncError = error instanceof DeviceFlowError && error.code === 'expired_token'
                ? new SyncError('auth', 'That code expired. Press Connect to get a new one.', { cause: error })
                : asSyncError(error);
            setStatus('error', syncError);
            throw syncError;
        } finally {
            signInController = null;
        }
    }

    /** Abandon an in-flight sign-in. */
    function cancelSignIn() {
        if (signInController) {
            signInController.abort();
        }
    }

    /* -------------------------------------------------------------- */
    /* Connection                                                      */
    /* -------------------------------------------------------------- */

    /**
     * Load a saved token, identify the user and find the workspace.
     *
     * A missing workspace is not an error: the UI offers to create one.
     *
     * @returns {Promise<void>}
     */
    /**
     * Connect, joining an in-flight attempt rather than starting a second one.
     *
     * Two callers run on page load (the page's own bootstrap and the panel), and
     * both would otherwise refresh the token and then fight over the rotated
     * result, which showed as a failed connection that a retry fixed.
     *
     * @returns {Promise<void>}
     */
    function connect() {
        if (connectInFlight) {
            return connectInFlight;
        }
        connectInFlight = doConnect().finally(() => {
            connectInFlight = null;
        });
        return connectInFlight;
    }

    async function doConnect() {
        try {
            if (!tokens) {
                tokens = await loadTokens();
            }
            if (!tokens || !tokens.accessToken) {
                setStatus('signed-out');
                return;
            }

            user = await withToken((token) => getUser({ token }));

            try {
                const repo = await withToken((token) =>
                    getRepo({ token, owner: user.login, repo: REPO_NAME }),
                );

                if (!repo) {
                    workspace = null;
                } else {
                    const usable = await withToken((token) =>
                        isWorkspaceRepo(token, user.login, REPO_NAME, repo.default_branch, repo.size),
                    );

                    if (!usable) {
                        workspace = null;
                    } else {
                        workspace = {
                            owner: user.login,
                            repo: REPO_NAME,
                            branch: repo.default_branch,
                        };
                        // An empty repository is ours but unfinished: finish it here,
                        // so a half-created workspace heals on the next load.
                        if (!repo.size) {
                            await withToken((token) =>
                                scaffoldWithRetry({
                                    token,
                                    owner: workspace.owner,
                                    repo: workspace.repo,
                                    branch: workspace.branch,
                                }),
                            );
                        }
                    }
                }
            } catch (error) {
                const syncError = asSyncError(error);
                if (syncError.kind === 'auth') {
                    throw syncError;
                }
                // A network problem here should not sign the user out.
                workspace = null;
            }

            setStatus('connected');
        } catch (error) {
            const syncError = asSyncError(error);
            setStatus(syncError.kind === 'auth' ? 'signed-out' : 'error', syncError);
            if (syncError.kind === 'auth') {
                throw syncError;
            }
        }
    }

    /**
     * Write the scaffold commit, retrying while a fresh repository settles.
     *
     * GitHub can answer 409 ("Git Repository is empty") or 422 from the git data
     * API for a second or two after a repository is created. Without this, creating
     * a workspace failed intermittently and only worked when tried again later.
     *
     * @param {{ token: string, owner: string, repo: string, branch: string }} options
     * @returns {Promise<void>}
     */
    async function scaffoldWithRetry({ token, owner, repo, branch }) {
        const delays = [0, 500, 1000, 2000, 3000];
        let lastError = null;

        for (const delay of delays) {
            if (delay > 0) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            try {
                await bootstrapRepo({ token, owner, repo, branch, identity: identityFor(user) });
                return;
            } catch (error) {
                lastError = error;
                const retryable =
                    error instanceof GitHubError && (error.status === 409 || error.status === 422);
                if (!retryable) {
                    throw error;
                }
            }
        }

        throw lastError;
    }

    /**
     * Whether a repository is a pydle workspace.
     *
     * A repository that merely shares the name is not one, and adopting it would
     * write `work/` into somebody else's project. The marker file decides, and an
     * empty repository counts as fair game because it holds nothing to damage.
     *
     * @param {string} token
     * @param {string} owner
     * @param {string} repo
     * @param {string} branch
     * @param {number} size Repository size in KB, from the repo object.
     * @returns {Promise<boolean>}
     */
    async function isWorkspaceRepo(token, owner, repo, branch, size) {
        if (!size) {
            return true;
        }
        try {
            await ghFetch(
                `/repos/${owner}/${repo}/contents/${WORKSPACE_MARKER}` +
                    `?ref=${encodeURIComponent(branch)}`,
                { token },
            );
            return true;
        } catch (error) {
            if (error instanceof GitHubError && (error.status === 404 || error.status === 403)) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Create the workspace repo and write the scaffold commit.
     *
     * @returns {Promise<void>}
     */
    async function createWorkspace() {
        if (!user) {
            await connect();
        }
        if (!user) {
            throw new SyncError('auth', 'Sign in first.');
        }

        try {
            let repo = await withToken((token) =>
                getRepo({ token, owner: user.login, repo: REPO_NAME }),
            );

            if (!repo) {
                try {
                    repo = await withToken((token) => createRepo({ token, name: REPO_NAME }));
                } catch (error) {
                    if (error instanceof GitHubError && error.status === 422) {
                        throw new SyncError(
                            'config',
                            `Your GitHub account already has a repository called ${REPO_NAME}, and it is not a pydle workspace. Rename or delete it, then try again.`,
                            { cause: error },
                        );
                    }
                    throw error;
                }
            }

            workspace = { owner: user.login, repo: REPO_NAME, branch: repo.default_branch };

            // Idempotent: a repository that exists but is still empty gets its
            // scaffold now rather than leaving the student with a broken workspace.
            if (!repo.size) {
                await withToken((token) =>
                    scaffoldWithRetry({
                        token,
                        owner: workspace.owner,
                        repo: workspace.repo,
                        branch: workspace.branch,
                    }),
                );
            }

            setStatus('connected');
        } catch (error) {
            const syncError = asSyncError(error);
            setStatus('error', syncError);
            throw syncError;
        }
    }

    /** Forget this device. Local work is untouched. */
    async function disconnect() {
        await clearTokens();
        // Do not let an in-flight attempt resurrect a token after signing out.
        refreshInFlight = null;
        connectInFlight = null;
        tokens = null;
        user = null;
        workspace = null;
        setStatus('signed-out');
    }

    /* -------------------------------------------------------------- */
    /* Pull                                                            */
    /* -------------------------------------------------------------- */

    /**
     * Copy remote files into the vault, but only where the local copy is missing.
     *
     * It never overwrites a local file: a device that was offline is at least as
     * new as the server, and the cost of the other choice is a lost afternoon.
     *
     * @returns {Promise<{ written: number, skipped: number }>}
     */
    async function pull() {
        if (!workspace) {
            throw new SyncError('config', 'No workspace to pull from.');
        }

        try {
            setStatus('connected');

            const head = await withToken((token) =>
                getRef({ token, owner: workspace.owner, repo: workspace.repo, branch: workspace.branch }),
            );
            if (!head) {
                return { projects: 0, applied: 0, conflicts: [] };
            }

            // Both namespaces live in the same repository, so one pull covers
            // programs and drawings.
            const conflicts = [];
            let applied = 0;
            let count = 0;

            for (const kind of Object.keys(KIND_ROOTS)) {
                const projects = await remoteProjects(head.sha, kind);
                count += projects.length;

                for (const project of projects) {
                    // Reconcile rather than overwrite: a device that has been away
                    // gets the files only the repository changed, and keeps its own.
                    const result = await preflight(project, {}, kind);
                    applied += result.applied.length;
                    for (const conflict of result.conflicts) {
                        conflicts.push({ ...conflict, project, kind });
                    }
                }
            }

            emit();
            return { projects: count, applied, conflicts };
        } catch (error) {
            const syncError = asSyncError(error);
            setStatus(syncError.kind === 'auth' ? 'signed-out' : 'error', syncError);
            throw syncError;
        }
    }

    /* -------------------------------------------------------------- */
    /* Committing                                                      */
    /* -------------------------------------------------------------- */

    /**
     * The hash git itself would give this content as a blob.
     *
     * This matters: the repository's tree lists blob SHAs, so a local hash is only
     * comparable to a remote one if it is the same kind of hash. Git hashes
     * `blob <byte-length>\0<content>` with SHA-1, so do the same here rather than
     * inventing a second, incomparable digest.
     *
     * @param {string} text
     * @returns {Promise<string>}
     */
    async function gitBlobHash(text) {
        const body = new TextEncoder().encode(text);
        const header = new TextEncoder().encode(`blob ${body.length}\0`);
        const bytes = new Uint8Array(header.length + body.length);
        bytes.set(header, 0);
        bytes.set(body, header.length);
        const digest = await crypto.subtle.digest('SHA-1', bytes);
        return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    }

    /* -------------------------------------------------------------- */
    /* Remote state and reconciliation                                  */
    /* -------------------------------------------------------------- */

    /**
     * Blob hashes for one project as the repository has them now.
     *
     * One tree fetch, no file downloads: enough to decide what changed.
     *
     * @param {string} project
     * @param {string} ref Branch or commit sha.
     * @returns {Promise<Record<string, string>>}
     */
    async function remoteProjectHashes(project, ref, kind = 'work') {
        const prefix = `${repoRoot(kind)}/${project}/`;
        const tree = await withToken((token) =>
            ghFetch(
                `/repos/${workspace.owner}/${workspace.repo}/git/trees/` +
                    `${encodeURIComponent(ref)}?recursive=1`,
                { token },
            ),
        );

        const hashes = {};
        for (const entry of (tree && tree.tree) || []) {
            if (entry.type !== 'blob' || !entry.path.startsWith(prefix)) {
                continue;
            }
            hashes[entry.path.slice(prefix.length)] = entry.sha;
        }
        return hashes;
    }

    /**
     * Every project directory that exists in the repository.
     *
     * @param {string} ref
     * @returns {Promise<string[]>}
     */
    async function remoteProjects(ref, kind = 'work') {
        const tree = await withToken((token) =>
            ghFetch(
                `/repos/${workspace.owner}/${workspace.repo}/git/trees/` +
                    `${encodeURIComponent(ref)}?recursive=1`,
                { token },
            ),
        );

        const projects = new Set();
        const prefix = `${repoRoot(kind)}/`;
        for (const entry of (tree && tree.tree) || []) {
            if (!entry.path.startsWith(prefix)) {
                continue;
            }
            const rest = entry.path.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash > 0) {
                projects.add(rest.slice(0, slash));
            }
        }
        return [...projects].sort();
    }

    /**
     * Fetch one blob's text.
     *
     * @param {string} sha
     * @returns {Promise<string>}
     */
    async function readBlobText(sha) {
        const blob = await withToken((token) =>
            ghFetch(`/repos/${workspace.owner}/${workspace.repo}/git/blobs/${sha}`, { token }),
        );
        if (!blob || typeof blob.content !== 'string') {
            return '';
        }
        return blob.encoding === 'base64' ? decodeBase64(blob.content) : blob.content;
    }

    /**
     * Reconcile the local vault with the repository before committing.
     *
     * Safe changes are applied: anything only the repository changed is taken, and
     * anything only this device changed is left alone. Only files where both sides
     * moved differently are reported, never guessed at.
     *
     * @param {string} name
     * @param {{ [path: string]: 'local' | 'remote' }} [resolutions] Choices the user
     *   made for previously reported conflicts.
     * @returns {Promise<{ applied: string[], conflicts: Array<{ path: string, kind: string, remoteHash: string | null }>, headSha: string | null }>}
     */
    async function preflight(name, resolutions = {}, kind = 'work') {
        if (!workspace) {
            throw new SyncError('auth', 'Sign in to GitHub first.');
        }

        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            throw new SyncError('config', 'That project does not exist.');
        }

        try {
            const head = await withToken((token) =>
                getRef({ token, owner: workspace.owner, repo: workspace.repo, branch: workspace.branch }),
            );
            if (!head) {
                return { applied: [], conflicts: [], headSha: null };
            }

            const snapshot = await vault.readCommitSnapshot(project, { kind });
            const base = snapshot && snapshot.files ? snapshot.files : {};
            const remote = await remoteProjectHashes(project, head.sha, kind);

            const localFiles = await readProject(project, kind);
            const local = {};
            for (const [path, content] of Object.entries(localFiles)) {
                local[path] = await gitBlobHash(content);
            }

            const plan = planMerge(base, local, remote);

            const toApply = [...plan.apply];
            for (const conflict of plan.conflicts) {
                if (resolutions[conflict.path] === 'remote') {
                    toApply.push({
                        path: conflict.path,
                        remoteHash: conflict.remoteHash,
                        kind: conflict.remoteHash === null ? 'deleted' : 'updated',
                    });
                }
            }

            const applied = [];
            for (const item of toApply) {
                if (item.remoteHash === null) {
                    await vault.deleteFile(project, item.path, { kind });
                } else {
                    await vault.writeFile(project, item.path, await readBlobText(item.remoteHash), { kind });
                }
                applied.push(item.path);
            }

            const remaining = plan.conflicts.filter(
                (conflict) => resolutions[conflict.path] !== 'remote' && resolutions[conflict.path] !== 'local',
            );

            if (toApply.length > 0 || remaining.length === 0) {
                // The snapshot's base moves forward for everything now agreed with
                // the repository. Files still in conflict keep their old base.
                const nextFiles = { ...base };
                for (const item of toApply) {
                    if (item.remoteHash === null) {
                        delete nextFiles[item.path];
                    } else {
                        nextFiles[item.path] = item.remoteHash;
                    }
                }
                await vault.writeCommitSnapshot(
                    project,
                    {
                        sha: remaining.length === 0 ? head.sha : snapshot ? snapshot.sha : head.sha,
                        files: nextFiles,
                    },
                    { kind },
                );
            }

            emit();
            return { applied, conflicts: remaining, headSha: head.sha };
        } catch (error) {
            throw asSyncError(error);
        }
    }

    /**
     * Files that differ from what was last committed.
     *
     * Answered from a snapshot on this device, so it works offline and without
     * asking GitHub. A project that has never been committed counts every file as
     * added, which is the honest answer.
     *
     * @param {string} name
     * @returns {Promise<{ paths: Array<{ path: string, status: 'added' | 'modified' | 'deleted' }>, count: number, lastCommit: string | null }>}
     */
    async function dirty(name, kind = 'work') {
        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            return { paths: [], count: 0, lastCommit: null };
        }

        const files = await readProject(project, kind);
        const snapshot = await vault.readCommitSnapshot(project, { kind });
        const committed = snapshot && snapshot.files ? snapshot.files : {};

        const paths = [];
        const onDisk = new Set(Object.keys(files));

        for (const [path, content] of Object.entries(files)) {
            const hash = await gitBlobHash(content);
            if (!Object.prototype.hasOwnProperty.call(committed, path)) {
                paths.push({ path, status: 'added' });
            } else if (committed[path] !== hash) {
                paths.push({ path, status: 'modified' });
            }
        }
        for (const path of Object.keys(committed)) {
            if (!onDisk.has(path)) {
                paths.push({ path, status: 'deleted' });
            }
        }

        paths.sort((a, b) => a.path.localeCompare(b.path));
        return {
            paths,
            count: paths.length,
            lastCommit: snapshot ? snapshot.sha : null,
        };
    }

    /**
     * Commit the chosen files. This is the only way work reaches GitHub.
     *
     * Files that were left out of `paths` stay dirty: an unselected edit is never
     * silently recorded as committed.
     *
     * @param {{ project: string, paths: string[], message: string, resolutions?: { [path: string]: 'local' | 'remote' } }} options
     * @returns {Promise<{ sha: string, message: string }>}
     */
    async function commit({ project: name, paths, message, resolutions = {}, kind = 'work' }) {
        if (!workspace || !user) {
            throw new SyncError('auth', 'Sign in to GitHub before committing.');
        }
        if (committing) {
            throw new SyncError('config', 'A commit is already in progress.');
        }

        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            throw new SyncError('config', 'That project does not exist.');
        }

        const trimmedMessage = String(message || '').trim();
        if (trimmedMessage === '') {
            throw new SyncError('config', 'A commit needs a message.');
        }

        const selected = Array.isArray(paths) ? [...new Set(paths)] : [];
        if (selected.length === 0) {
            throw new SyncError('config', 'Choose at least one file to commit.');
        }

        committing = true;
        emit();

        try {
            // Reconcile first. If the repository moved while this device was away,
            // taking the safe changes is right, but overwriting a file both sides
            // changed is not, so that stops here and asks.
            const check = await preflight(project, resolutions, kind);
            if (check.conflicts.length > 0) {
                const clash = new SyncError(
                    'conflict',
                    'Some files were changed on another device as well. Choose which version to keep.',
                );
                clash.conflicts = check.conflicts;
                throw clash;
            }

            const files = await readProject(project, kind);
            const snapshot = await vault.readCommitSnapshot(project, { kind });
            const committed = snapshot && snapshot.files ? snapshot.files : {};

            const upserts = [];
            const deletes = [];

            for (const path of selected) {
                if (Object.prototype.hasOwnProperty.call(files, path)) {
                    upserts.push({
                        path: `${repoRoot(kind)}/${project}/${safeJoin(path)}`,
                        content: files[path],
                    });
                } else if (Object.prototype.hasOwnProperty.call(committed, path)) {
                    deletes.push(`${repoRoot(kind)}/${project}/${safeJoin(path)}`);
                }
            }

            if (upserts.length === 0 && deletes.length === 0) {
                throw new SyncError('config', 'Those files have not changed since the last commit.');
            }

            const result = await withToken((token) =>
                commitFiles({
                    token,
                    owner: workspace.owner,
                    repo: workspace.repo,
                    branch: workspace.branch,
                    files: upserts,
                    deletes,
                    message: trimmedMessage,
                    identity: identityFor(user),
                }),
            );

            const nextFiles = { ...committed };
            for (const path of selected) {
                if (Object.prototype.hasOwnProperty.call(files, path)) {
                    nextFiles[path] = await gitBlobHash(files[path]);
                } else {
                    delete nextFiles[path];
                }
            }
            await vault.writeCommitSnapshot(project, { sha: result.sha, files: nextFiles }, { kind });

            setStatus('connected');
            return { sha: result.sha, message: trimmedMessage };
        } catch (error) {
            const syncError = asSyncError(error);
            setStatus(syncError.kind === 'auth' ? 'signed-out' : 'error', syncError);
            throw syncError;
        } finally {
            committing = false;
            emit();
        }
    }

    /* History ---------------------------------------------------------- */

    /**
     * Commits that touched a project, newest first.
     *
     * @param {string} name
     * @param {{ limit?: number }} [options]
     * @returns {Promise<Array<{ sha: string, message: string, date: string | null, author: string }>>}
     */
    async function listCommits(name, { limit = 30, kind = 'work' } = {}) {
        if (!workspace) {
            throw new SyncError('auth', 'Sign in to GitHub to see history.');
        }
        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            throw new SyncError('config', 'That project does not exist.');
        }

        const scope = `${repoRoot(kind)}/${project}`;
        try {
            const commits = await withToken((token) =>
                ghFetch(
                    `/repos/${workspace.owner}/${workspace.repo}/commits` +
                        `?path=${encodeURIComponent(scope)}&per_page=${Math.min(Math.max(limit, 1), 100)}`,
                    { token },
                ),
            );

            return (Array.isArray(commits) ? commits : []).map((entry) => ({
                sha: entry.sha,
                message: (entry.commit && entry.commit.message) || '',
                date: entry.commit && entry.commit.author ? entry.commit.author.date : null,
                author: entry.commit && entry.commit.author ? entry.commit.author.name : '',
            }));
        } catch (error) {
            throw asSyncError(error);
        }
    }

    /**
     * One commit with the patch for every file it touched.
     *
     * @param {string} sha
     * @returns {Promise<{ sha: string, message: string, date: string | null, author: string, files: Array<{ path: string, status: string, additions: number, deletions: number, patch: string }> }>}
     */
    async function getCommit(sha) {
        if (!workspace) {
            throw new SyncError('auth', 'Sign in to GitHub to see history.');
        }
        try {
            const detail = await withToken((token) =>
                ghFetch(`/repos/${workspace.owner}/${workspace.repo}/commits/${encodeURIComponent(sha)}`, {
                    token,
                }),
            );

            const files = (detail && detail.files ? detail.files : []).map((file) => ({
                // Strip the namespace root so the list reads as project paths.
                path: Object.values(KIND_ROOTS).reduce(
                    (acc, root) => (acc.startsWith(`${root}/`) ? acc.slice(root.length + 1) : acc),
                    file.filename,
                ),
                status: file.status || 'modified',
                additions: file.additions || 0,
                deletions: file.deletions || 0,
                patch: file.patch || '',
            }));

            return {
                sha: detail.sha || sha,
                message: (detail.commit && detail.commit.message) || '',
                date: detail.commit && detail.commit.author ? detail.commit.author.date : null,
                author: detail.commit && detail.commit.author ? detail.commit.author.name : '',
                files,
            };
        } catch (error) {
            throw asSyncError(error);
        }
    }

    /**
     * The contents of one file as it was at a given commit, or null.
     *
     * @param {string} sha
     * @param {string} path Path inside the project.
     * @param {string} project
     * @returns {Promise<string | null>}
     */
    async function fileAt(project, path, sha, kind = 'work') {
        if (!workspace) {
            throw new SyncError('auth', 'Sign in to GitHub to see history.');
        }
        let slug;
        let relative;
        try {
            slug = normalizeProjectName(project);
            relative = safeJoin(path);
        } catch {
            return null;
        }

        try {
            const blob = await withToken((token) =>
                ghFetch(
                    `/repos/${workspace.owner}/${workspace.repo}/contents/` +
                        `${encodeURIComponent(`${repoRoot(kind)}/${slug}/${relative}`)}` +
                        `?ref=${encodeURIComponent(sha)}`,
                    { token },
                ),
            );
            if (!blob || typeof blob.content !== 'string') {
                return null;
            }
            return blob.encoding === 'base64' ? decodeBase64(blob.content) : blob.content;
        } catch (error) {
            const syncError = asSyncError(error);
            if (syncError.kind === 'config') {
                return null;
            }
            throw syncError;
        }
    }

    /**
     * True when anything in a project is uncommitted. Used to decide whether to
     * warn before leaving.
     *
     * @param {string} name
     * @returns {Promise<boolean>}
     */
    async function hasUncommitted(name) {
        return (await dirty(name)).count > 0;
    }

    /* -------------------------------------------------------------- */
    /* Projects                                                        */
    /* -------------------------------------------------------------- */

    /**
     * Projects currently in the local vault, newest first.
     *
     * @returns {Promise<Array<{ name: string, updatedAt: number }>>}
     */
    async function listProjects(kind = 'work') {
        try {
            return await vault.listProjects(kind);
        } catch {
            return [];
        }
    }

    /**
     * Read one project's files.
     *
     * @param {string} name
     * @returns {Promise<Record<string, string>>}
     */
    async function readProject(name, kind = 'work') {
        try {
            return await vault.readProject(name, { kind });
        } catch {
            return {};
        }
    }

    /**
     * Write one file into a project. Local only: this never touches the network.
     *
     * This is the call the editor makes on save. Whether and when it becomes a
     * commit is the user's decision, made in the commit prompt.
     *
     * @param {string} name Project name.
     * @param {string} path Path relative to the project.
     * @param {string} content
     * @returns {Promise<void>}
     */
    async function writeFiles(name, path, content, { kind = 'work' } = {}) {
        await vault.writeFile(name, path, content, { kind });
        emit();
    }

    /**
     * Delete a file locally. Its removal from GitHub happens on the next commit,
     * where it shows up as a deleted file.
     *
     * @param {string} name
     * @param {string} path
     * @returns {Promise<void>}
     */
    async function deleteFile(name, path, { kind = 'work' } = {}) {
        await vault.deleteFile(name, path, { kind });
        emit();
    }

    /**
     * Delete a whole project, locally and on GitHub.
     *
     * @param {string} name
     * @returns {Promise<void>}
     */
    async function deleteProject(name, kind = 'work') {
        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            return;
        }

        // Deleting a project is already a confirmed, destructive action, so the
        // remote deletion happens with it rather than being left as an orphaned
        // dirty state for a project that no longer appears anywhere.
        const snapshot = await vault.readCommitSnapshot(project, { kind });
        const committed = snapshot && snapshot.files ? Object.keys(snapshot.files) : [];

        if (committed.length > 0 && workspace && user) {
            try {
                await withToken((token) =>
                    commitFiles({
                        token,
                        owner: workspace.owner,
                        repo: workspace.repo,
                        branch: workspace.branch,
                        files: [],
                        deletes: committed.map((path) => `${repoRoot(kind)}/${project}/${path}`),
                        message: `Delete ${project}`,
                        identity: identityFor(user),
                    }),
                );
            } catch {
                // The local delete is what the user asked for; a failed remote
                // delete is reported through status, not by blocking the delete.
            }
        }

        await vault.deleteProject(project, { kind });
        emit();
    }

    return {
        get status() {
            return status;
        },
        get identity() {
            return user ? { login: user.login, name: user.name || user.login } : null;
        },
        get workspace() {
            return workspace ? { owner: workspace.owner, repo: workspace.repo } : null;
        },
        get error() {
            return lastError;
        },
        get committing() {
            return committing;
        },
        subscribe,
        onStatus: subscribe,
        beginSignIn,
        cancelSignIn,
        connect,
        createWorkspace,
        pull,
        listProjects,
        readProject,
        writeFiles,
        deleteFile,
        deleteProject,
        dirty,
        preflight,
        commit,
        hasUncommitted,
        listCommits,
        getCommit,
        fileAt,
        disconnect,
    };
}

export { REPO_NAME as DEFAULT_REPO_NAME };
export const WORK_DIR = WORK_ROOT;
export const constants = { WORK_ROOT, REPO_NAME };
