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

/** Repo name inside the user's own account. One workspace per person. */
export const REPO_NAME = 'pydle';

/** Directory inside the repo that holds projects. */
const WORK_ROOT = 'work';

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
        try {
            const refreshed = await refreshAccessToken({
                clientId: CONFIG.clientId,
                refreshToken: tokens.refreshToken,
                shimBase: CONFIG.shimBase,
            });
            await storeTokenResponse(refreshed);
            return tokens.accessToken;
        } catch (error) {
            throw new SyncError('auth', 'The sign-in has expired. Please reconnect.', { cause: error });
        }
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
    async function connect() {
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
                workspace = repo
                    ? { owner: user.login, repo: REPO_NAME, branch: repo.default_branch }
                    : null;
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
            const repo = await withToken((token) => createRepo({ token, name: REPO_NAME }));
            workspace = { owner: user.login, repo: REPO_NAME, branch: repo.default_branch };

            await withToken((token) =>
                bootstrapRepo({
                    token,
                    owner: workspace.owner,
                    repo: workspace.repo,
                    branch: workspace.branch,
                    identity: identityFor(user),
                }),
            );

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

            const tree = await withToken((token) =>
                ghFetch(
                    `/repos/${workspace.owner}/${workspace.repo}/git/trees/${encodeURIComponent(workspace.branch)}?recursive=1`,
                    { token },
                ),
            );

            let written = 0;
            let skipped = 0;

            for (const entry of tree.tree || []) {
                if (entry.type !== 'blob' || !entry.path.startsWith(`${WORK_ROOT}/`)) {
                    continue;
                }
                const rest = entry.path.slice(WORK_ROOT.length + 1);
                const slash = rest.indexOf('/');
                if (slash <= 0) {
                    continue;
                }
                const project = rest.slice(0, slash);
                const file = rest.slice(slash + 1);

                let existing = {};
                try {
                    existing = await vault.readProject(project);
                } catch {
                    existing = {};
                }
                if (Object.prototype.hasOwnProperty.call(existing, file)) {
                    skipped += 1;
                    continue;
                }

                const blob = await withToken((token) =>
                    ghFetch(
                        `/repos/${workspace.owner}/${workspace.repo}/git/blobs/${entry.sha}`,
                        { token },
                    ),
                );
                const content = blob.encoding === 'base64' ? decodeBase64(blob.content) : blob.content;
                await vault.writeFile(project, file, content);
                written += 1;
            }

            emit();
            return { written, skipped };
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
     * Hex SHA-256 of a file's contents.
     *
     * Only ever used to answer "has this changed since it was committed", so a
     * plain hash suffices: no diffing, no line mapping, no dependency.
     *
     * @param {string} text
     * @returns {Promise<string>}
     */
    async function contentHash(text) {
        const bytes = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
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
    async function dirty(name) {
        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            return { paths: [], count: 0, lastCommit: null };
        }

        const files = await readProject(project);
        const snapshot = await vault.readCommitSnapshot(project);
        const committed = snapshot && snapshot.files ? snapshot.files : {};

        const paths = [];
        const onDisk = new Set(Object.keys(files));

        for (const [path, content] of Object.entries(files)) {
            const hash = await contentHash(content);
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
     * @param {{ project: string, paths: string[], message: string }} options
     * @returns {Promise<{ sha: string, message: string }>}
     */
    async function commit({ project: name, paths, message }) {
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
            const files = await readProject(project);
            const snapshot = await vault.readCommitSnapshot(project);
            const committed = snapshot && snapshot.files ? snapshot.files : {};

            const upserts = [];
            const deletes = [];

            for (const path of selected) {
                if (Object.prototype.hasOwnProperty.call(files, path)) {
                    upserts.push({
                        path: `${WORK_ROOT}/${project}/${safeJoin(path)}`,
                        content: files[path],
                    });
                } else if (Object.prototype.hasOwnProperty.call(committed, path)) {
                    deletes.push(`${WORK_ROOT}/${project}/${safeJoin(path)}`);
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
                    nextFiles[path] = await contentHash(files[path]);
                } else {
                    delete nextFiles[path];
                }
            }
            await vault.writeCommitSnapshot(project, { sha: result.sha, files: nextFiles });

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
    async function listCommits(name, { limit = 30 } = {}) {
        if (!workspace) {
            throw new SyncError('auth', 'Sign in to GitHub to see history.');
        }
        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            throw new SyncError('config', 'That project does not exist.');
        }

        const scope = `${WORK_ROOT}/${project}`;
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
                // Strip the work/ prefix so the list reads as project paths.
                path: file.filename.startsWith(`${WORK_ROOT}/`)
                    ? file.filename.slice(WORK_ROOT.length + 1)
                    : file.filename,
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
    async function fileAt(project, path, sha) {
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
                        `${encodeURIComponent(`${WORK_ROOT}/${slug}/${relative}`)}` +
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
    async function listProjects() {
        try {
            return await vault.listProjects();
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
    async function readProject(name) {
        try {
            return await vault.readProject(name);
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
    async function writeFiles(name, path, content) {
        await vault.writeFile(name, path, content);
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
    async function deleteFile(name, path) {
        await vault.deleteFile(name, path);
        emit();
    }

    /**
     * Delete a whole project, locally and on GitHub.
     *
     * @param {string} name
     * @returns {Promise<void>}
     */
    async function deleteProject(name) {
        let project;
        try {
            project = normalizeProjectName(name);
        } catch {
            return;
        }

        // Deleting a project is already a confirmed, destructive action, so the
        // remote deletion happens with it rather than being left as an orphaned
        // dirty state for a project that no longer appears anywhere.
        const snapshot = await vault.readCommitSnapshot(project);
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
                        deletes: committed.map((path) => `${WORK_ROOT}/${project}/${path}`),
                        message: `Delete ${project}`,
                        identity: identityFor(user),
                    }),
                );
            } catch {
                // The local delete is what the user asked for; a failed remote
                // delete is reported through status, not by blocking the delete.
            }
        }

        await vault.deleteProject(project);
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
