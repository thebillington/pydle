/**
 * Local vault storage: one call surface over the Origin Private File System
 * (OPFS) with an IndexedDB fallback.
 *
 * Layout is `project/relative/path` in both backends. Every caller-supplied
 * path goes through `safeJoin` and is checked with `assertInside`, so a path
 * can never leave its project. `updatedAt` bookkeeping lives in IndexedDB in
 * both backends (`meta` store), because OPFS does not expose a directory mtime.
 *
 * Project names are *stored*, not computed. A name is normalised exactly once,
 * when a project is created or renamed; every later read, write and delete uses
 * the stored name verbatim. Re-normalising on access is what let a project
 * called `old-name` read and overwrite its canonical twin `old_name`.
 *
 * Missing files and projects are never an error: reads return `null` or `{}`.
 * An unusable project name is an error, because it is not a missing project.
 */

import { isReservedPath, normalizeProjectName, safeJoin } from './paths.js';

/** IndexedDB database shared with the token store. */
const DB_NAME = 'pydle';

/** Schema version; stores are created on demand so any opener can upgrade. */
const DB_VERSION = 1;

const FILE_STORE = 'files';
const META_STORE = 'meta';
const AUTH_STORE = 'auth';

/** Meta keys holding a project's last committed state. */
const SNAPSHOT_PREFIX = 'commit:';

/**
 * Project namespaces.
 *
 * `work` deliberately maps to the empty string: it is the original layout, so the
 * programs already on every device keep working with no migration. `drawings` is a
 * new sibling directory. Anything added here needs the same treatment in sync.js,
 * which mirrors it into `work/` and `drawings/` in the repository.
 */
const KIND_DIRS = { work: '', drawings: 'drawings' };

/**
 * @param {string} kind
 * @returns {string} Directory segment, or '' for the root.
 */
function kindDir(kind) {
    if (!Object.prototype.hasOwnProperty.call(KIND_DIRS, kind)) {
        throw new TypeError(`vault: unknown kind ${JSON.stringify(kind)}`);
    }
    return KIND_DIRS[kind];
}

/**
 * Key prefix for the IndexedDB stores, so the two namespaces cannot collide.
 *
 * @param {string} kind
 * @returns {string}
 */
function keyPrefix(kind) {
    const dir = kindDir(kind);
    return dir === '' ? '' : `${dir}/`;
}

/** Directory under the OPFS origin root that holds every project. */
const VAULT_DIR = 'vault';

/* ------------------------------------------------------------------ */
/* IndexedDB plumbing                                                  */
/* ------------------------------------------------------------------ */

let dbPromise = null;

/**
 * Open (once) the shared `pydle` database.
 *
 * @returns {Promise<IDBDatabase>}
 */
function db() {
    if (dbPromise === null) {
        dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('vault: IndexedDB is not available'));
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                for (const name of [FILE_STORE, META_STORE, AUTH_STORE]) {
                    if (!database.objectStoreNames.contains(name)) {
                        database.createObjectStore(name);
                    }
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }).catch((error) => {
            dbPromise = null;
            throw error;
        });
    }

    return dbPromise;
}

/**
 * Wrap one IndexedDB request in a promise.
 *
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function ask(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Run a single operation against one object store and await its completion.
 *
 * @template T
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} operation
 * @returns {Promise<T>}
 */
async function run(storeName, mode, operation) {
    const database = await db();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error ?? request.error);
        transaction.onabort = () => reject(transaction.error ?? request.error);
    });
}

/**
 * Get one value from a store.
 *
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<unknown>}
 */
function idbGet(storeName, key) {
    return run(storeName, 'readonly', (store) => store.get(key));
}

/**
 * Put one value into a store.
 *
 * @param {string} storeName
 * @param {unknown} value
 * @param {IDBValidKey} [key]
 * @returns {Promise<unknown>}
 */
function idbPut(storeName, value, key) {
    return run(storeName, 'readwrite', (store) =>
        key === undefined ? store.put(value) : store.put(value, key),
    );
}

/**
 * Delete one key from a store.
 *
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<unknown>}
 */
function idbDelete(storeName, key) {
    return run(storeName, 'readwrite', (store) => store.delete(key));
}

/**
 * Key range covering every key with `prefix`.
 *
 * @param {string} prefix
 * @returns {IDBKeyRange}
 */
function prefixRange(prefix) {
    return IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, false);
}

/**
 * Read every key and value in a store, optionally limited to a prefix.
 *
 * @param {string} storeName
 * @param {string} [prefix]
 * @returns {Promise<Array<[IDBValidKey, unknown]>>}
 */
async function idbEntries(storeName, prefix) {
    const database = await db();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const query = prefix === undefined ? null : prefixRange(prefix);
        const keysRequest = store.getAllKeys(query);
        const valuesRequest = store.getAll(query);
        transaction.oncomplete = () => {
            resolve(keysRequest.result.map((key, index) => [key, valuesRequest.result[index]]));
        };
        transaction.onerror = () => reject(transaction.error ?? keysRequest.error);
        transaction.onabort = () => reject(transaction.error ?? keysRequest.error);
    });
}

/**
 * Delete every key in a store matching a prefix.
 *
 * @param {string} storeName
 * @param {string} prefix
 * @returns {Promise<void>}
 */
async function idbDeletePrefix(storeName, prefix) {
    const database = await db();
    await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.openKeyCursor(prefixRange(prefix));
        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                store.delete(cursor.primaryKey);
                cursor.continue();
            }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? request.error);
        transaction.onabort = () => reject(transaction.error ?? request.error);
    });
}

/**
 * Record a project's update time.
 *
 * @param {string} project Stored project name.
 * @returns {Promise<void>}
 */
async function touchProject(kind, project) {
    await idbPut(META_STORE, { updatedAt: Date.now() }, keyPrefix(kind) + project);
}

/**
 * Read a project's recorded update time.
 *
 * @param {string} project Stored project name.
 * @returns {Promise<number>} Milliseconds since the epoch, or 0.
 */
async function projectUpdatedAt(kind, project) {
    try {
        const record = await idbGet(META_STORE, keyPrefix(kind) + project);
        return record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
    } catch {
        return 0;
    }
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalise a *new* project name, throwing on unusable input.
 *
 * Only creation (and the target of a rename) may do this. Reading or writing an
 * existing project must use `requireStoredName`: the directory on disk may
 * predate the snake_case rule, and rewriting its name here would silently point
 * at a different project.
 *
 * @param {string} project
 * @returns {string}
 */
function requireProject(project) {
    return normalizeProjectName(project);
}

/**
 * Validate a project name exactly as it is stored, without normalising it.
 *
 * This is the access rule for every existing project: the name is used verbatim,
 * because that is the directory (or key prefix) it lives under. A project saved
 * before the snake_case rule may be called `my-project`; normalising that would
 * point at `my_project`, which is either absent or a *different* project.
 *
 * Only proof required is that it is one safe path segment: a non-empty string
 * with no separator, no `.`/`..`, no backslash, no control character, and no
 * change when passed through `safeJoin`.
 *
 * @param {string} project
 * @returns {string}
 */
function requireStoredName(project) {
    if (typeof project !== 'string' || project === '') {
        throw new TypeError(
            `vault: project name must be a non-empty string, got ${typeof project}`,
        );
    }
    if (project.includes('/') || project === '.' || project === '..') {
        throw new TypeError(`vault: ${JSON.stringify(project)} is not a project name`);
    }
    let segment;
    try {
        segment = safeJoin(project);
    } catch {
        throw new TypeError(`vault: ${JSON.stringify(project)} is not a project name`);
    }
    if (segment !== project) {
        throw new TypeError(`vault: ${JSON.stringify(project)} is not a single project name`);
    }
    return project;
}

/**
 * Validate a project-relative path and refuse reserved namespaces.
 *
 * @param {string} path
 * @returns {string} Normalised relative path.
 */
function requirePath(path) {
    const relative = safeJoin(path);
    if (isReservedPath(relative)) {
        throw new TypeError(`vault: "${relative}" is a reserved path`);
    }
    return relative;
}

/**
 * Whether an error means "that entry does not exist".
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissing(error) {
    return (
        error instanceof DOMException &&
        (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
    ) || (error instanceof Error && error.name === 'NotFoundError');
}

/* ------------------------------------------------------------------ */
/* OPFS backend                                                        */
/* ------------------------------------------------------------------ */

/**
 * Whether OPFS is usable in this browser.
 *
 * @returns {boolean}
 */
function hasOpfs() {
    return (
        typeof navigator !== 'undefined' &&
        navigator.storage !== undefined &&
        typeof navigator.storage.getDirectory === 'function'
    );
}

/**
 * Walk every file under a directory.
 *
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} [prefix]
 * @yields {{ path: string, handle: FileSystemFileHandle }}
 */
async function* walkFiles(dir, prefix = '') {
    for await (const [name, handle] of dir.entries()) {
        const path = prefix === '' ? name : `${prefix}/${name}`;
        if (handle.kind === 'file') {
            yield { path, handle };
        } else {
            yield* walkFiles(handle, path);
        }
    }
}

/**
 * Get the top-level vault directory in OPFS.
 *
 * @param {boolean} [create]
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function vaultRoot(create = true) {
    const origin = await navigator.storage.getDirectory();
    return origin.getDirectoryHandle(VAULT_DIR, { create });
}

/**
 * Get a project directory, optionally creating it.
 *
 * @param {string} project Stored project name.
 * @param {boolean} [create]
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
/**
 * The directory holding one kind: the vault root for `work`, a subdirectory for
 * everything else.
 *
 * @param {string} kind
 * @param {boolean} [create]
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function kindRoot(kind, create = true) {
    const root = await vaultRoot(create);
    const dir = kindDir(kind);
    if (dir === '') {
        return root;
    }
    return root.getDirectoryHandle(dir, { create });
}

/**
 * Get a project directory, optionally creating it.
 *
 * @param {string} kind
 * @param {string} project Stored project name.
 * @param {boolean} [create]
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function projectDir(kind, project, create = false) {
    const root = await kindRoot(kind, create);
    return root.getDirectoryHandle(project, { create });
}
/**
 * Remove now-empty parent directories after deleting a file, deepest first.
 *
 * @param {FileSystemDirectoryHandle} project
 * @param {string[]} segments Directory segments below the project root.
 * @returns {Promise<void>}
 */
async function pruneEmptyDirs(project, segments) {
    const chain = [];
    let dir = project;
    for (const name of segments) {
        let next;
        try {
            next = await dir.getDirectoryHandle(name);
        } catch (error) {
            if (isMissing(error)) {
                return;
            }
            throw error;
        }
        chain.push({ parent: dir, name });
        dir = next;
    }

    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const { parent, name } = chain[index];
        try {
            await parent.removeEntry(name);
        } catch {
            // Not empty (or already gone): leave the rest of the chain alone.
            return;
        }
    }
}

/**
 * Recursively remove a directory tree.
 *
 * @param {FileSystemDirectoryHandle} dir
 * @returns {Promise<void>}
 */
async function removeTree(dir) {
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
            await dir.removeEntry(name);
        } else {
            await removeTree(handle);
            await dir.removeEntry(name, { recursive: true });
        }
    }
}

/**
 * Read one file from the IndexedDB store.
 *
 * @param {string} project Stored project name.
 * @param {string} path Normalised relative path.
 * @returns {Promise<string | null>}
 */
async function idbReadFile(kind, project, path) {
    const value = await idbGet(FILE_STORE, `${keyPrefix(kind)}${project}/${path}`);
    return typeof value === 'string' ? value : null;
}

/**
 * All files of one project as `{ path: content }`.
 *
 * @param {string} project Stored project name.
 * @returns {Promise<Record<string, string>>}
 */
async function idbReadProject(kind, project) {
    const prefix = `${keyPrefix(kind)}${project}/`;
    const entries = await idbEntries(FILE_STORE, prefix);
    const files = {};
    for (const [key, value] of entries) {
        if (typeof key === 'string' && typeof value === 'string') {
            files[key.slice(prefix.length)] = value;
        }
    }
    return files;
}

export function isAvailable() {
    return hasOpfs() ? 'opfs' : 'idb';
}

/**
 * List projects, newest first.
 *
 * Names are the stored directory names, never a computed form: a project saved
 * before the snake_case rule comes back hyphenated, because that is what opening
 * it must read.
 *
 * @returns {Promise<Array<{ name: string, updatedAt: number }>>}
 */
export async function listProjects(kind = 'work') {
    const prefix = keyPrefix(kind);
    // Other namespaces are directories inside this one, so without this a turtle
    // drawings folder would be offered to the student as a project.
    const otherNamespaces = new Set(
        Object.values(KIND_DIRS).filter((dir) => dir !== '' && dir !== kindDir(kind)),
    );
    /** @type {Map<string, number>} */
    const projects = new Map();

    if (hasOpfs()) {
        // Listing never creates the namespace: a request to see what exists
        // should not leave an empty directory behind.
        let root;
        try {
            root = await kindRoot(kind, false);
        } catch (error) {
            if (isMissing(error)) {
                return [];
            }
            throw error;
        }
        for await (const [name, handle] of root.entries()) {
            if (handle.kind !== 'directory') {
                continue;
            }
            // Every directory that names a project is listed under the name it
            // is actually stored as. A project saved before the snake_case rule
            // is still called `my-project` on disk; hiding it here would hide
            // the work before startup gets a chance to rename it. A directory
            // with no usable name at all can never be addressed, so it is not a
            // project.
            try {
                normalizeProjectName(name);
            } catch {
                continue;
            }
            if (otherNamespaces.has(name)) {
                continue;
            }
            projects.set(name, 0);
        }
        // Fill in mtimes for anything the meta store has not seen.
        for (const [name, updatedAt] of projects) {
            let resolved = updatedAt;
            try {
                resolved = await projectUpdatedAt(kind, name);
            } catch {
                resolved = 0;
            }
            if (resolved === 0) {
                try {
                    const directory = await projectDir(kind, name);
                    for await (const { handle } of walkFiles(directory)) {
                        const file = await handle.getFile();
                        resolved = Math.max(resolved, file.lastModified);
                    }
                } catch {
                    // Leave it at 0 rather than failing the whole listing.
                }
            }
            projects.set(name, resolved);
        }
    } else {
        const entries = await idbEntries(FILE_STORE);
        for (const [key] of entries) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) {
                continue;
            }
            const rest = key.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash > 0) {
                projects.set(rest.slice(0, slash), 0);
            }
        }
        for (const name of projects.keys()) {
            projects.set(name, await projectUpdatedAt(kind, name));
        }
        // Projects with a meta record but no files yet, in this namespace only.
        for (const [key, value] of await idbEntries(META_STORE)) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) {
                continue;
            }
            if (key.startsWith(SNAPSHOT_PREFIX)) {
                continue;
            }
            const name = key.slice(prefix.length);
            if (name === '' || name.includes('/') || projects.has(name)) {
                continue;
            }
            if (otherNamespaces.has(name)) {
                continue;
            }
            projects.set(name, value && Number.isFinite(value.updatedAt) ? value.updatedAt : 0);
        }
    }

    // A stored name that is not canonical is still listed: it is readable under
    // its own spelling, and hiding it would hide the work. But if its canonical
    // twin also exists, two different directories now look the same to a human,
    // so say so — nothing else in the app will ever notice.
    for (const stored of projects.keys()) {
        let canonical;
        try {
            canonical = normalizeProjectName(stored);
        } catch {
            continue;
        }
        if (canonical !== stored && projects.has(canonical)) {
            console.warn('[pydle] vault: ambiguous project name', stored);
        }
    }

    return [...projects.entries()]
        .map(([name, updatedAt]) => ({ name, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}
/**
 * Read one project's files.
 *
 * `name` is the stored project name, used verbatim. An unusable name is a
 * programming error and throws; a valid name with nothing stored reads `{}`.
 *
 * @param {string} name Stored project name.
 * @returns {Promise<Record<string, string>>}
 */
export async function readProject(name, { kind = 'work' } = {}) {
    const project = requireStoredName(name);

    if (hasOpfs()) {
        let dir;
        try {
            dir = await projectDir(kind, project);
        } catch (error) {
            if (isMissing(error)) {
                return {};
            }
            throw error;
        }

        const files = {};
        for await (const { path, handle } of walkFiles(dir)) {
            files[path] = await (await handle.getFile()).text();
        }
        return files;
    }

    return idbReadProject(kind, project);
}
/**
 * Write one file into a project, creating the project directory if needed.
 *
 * `project` is the stored name, used verbatim. A fresh canonical name therefore
 * works unchanged: nothing is re-normalised, and missing directories are made.
 *
 * @param {string} project Stored project name.
 * @param {string} path Path relative to the project.
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeFile(project, path, content, { kind = 'work' } = {}) {
    const name = requireStoredName(project);
    const relative = requirePath(path);
    if (typeof content !== 'string') {
        throw new TypeError(
            `vault: content for "${relative}" must be a string, got ${typeof content}`,
        );
    }

    if (hasOpfs()) {
        const dir = await projectDir(kind, name, true);
        const segments = relative.split('/');
        const filename = segments.pop();
        let parent = dir;
        for (const segment of segments) {
            parent = await parent.getDirectoryHandle(segment, { create: true });
        }
        const handle = await parent.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        try {
            await writable.write(content);
        } finally {
            await writable.close();
        }
    } else {
        await idbPut(FILE_STORE, content, `${keyPrefix(kind)}${name}/${relative}`);
    }

    await touchProject(kind, name);
}
/**
 * Delete one file from a project. The stored name is used verbatim.
 *
 * @param {string} project Stored project name.
 * @param {string} path Path relative to the project.
 * @returns {Promise<boolean>} True when something was removed.
 */
export async function deleteFile(project, path, { kind = 'work' } = {}) {
    const name = requireStoredName(project);
    const relative = requirePath(path);

    if (hasOpfs()) {
        let dir;
        try {
            dir = await projectDir(kind, name);
        } catch (error) {
            if (isMissing(error)) {
                return false;
            }
            throw error;
        }

        const segments = relative.split('/');
        const filename = segments.pop();
        let parent = dir;
        for (const segment of segments) {
            try {
                parent = await parent.getDirectoryHandle(segment);
            } catch (error) {
                if (isMissing(error)) {
                    return false;
                }
                throw error;
            }
        }

        try {
            await parent.removeEntry(filename);
        } catch (error) {
            if (isMissing(error)) {
                return false;
            }
            throw error;
        }
        await pruneEmptyDirs(dir, segments);
        await touchProject(kind, name);
        return true;
    }

    const key = `${keyPrefix(kind)}${name}/${relative}`;
    const existing = await idbGet(FILE_STORE, key);
    if (existing === undefined) {
        return false;
    }
    await idbDelete(FILE_STORE, key);
    await touchProject(kind, name);
    return true;
}
/**
 * The local record of what was last committed for one project.
 *
 * The snapshot is keyed by the stored project name, verbatim: a project saved as
 * `my-project` has its snapshot under that spelling, and asking for `my_project`
 * must not see it.
 *
 * @param {string} project Stored project name.
 * @returns {Promise<{ sha?: string, files: Record<string, string> } | null>}
 */
export async function readCommitSnapshot(project, { kind = 'work' } = {}) {
    const slug = requireStoredName(project);
    try {
        const value = await idbGet(META_STORE, `${SNAPSHOT_PREFIX}${keyPrefix(kind)}${slug}`);
        if (value && typeof value === 'object' && value.files && typeof value.files === 'object') {
            return value;
        }
        return null;
    } catch {
        return null;
    }
}
/**
 * Record what was last committed for one project, under its stored name.
 *
 * @param {string} project Stored project name.
 * @param {{ sha?: string, files: Record<string, string> }} snapshot
 * @returns {Promise<void>}
 */
export async function writeCommitSnapshot(project, snapshot, { kind = 'work' } = {}) {
    const slug = requireStoredName(project);
    await idbPut(META_STORE, snapshot, `${SNAPSHOT_PREFIX}${keyPrefix(kind)}${slug}`);
}
/**
 * Forget what was last committed for one project, under its stored name.
 *
 * @param {string} project Stored project name.
 * @returns {Promise<void>}
 */
export async function clearCommitSnapshot(project, { kind = 'work' } = {}) {
    const slug = requireStoredName(project);
    try {
        await idbDelete(META_STORE, `${SNAPSHOT_PREFIX}${keyPrefix(kind)}${slug}`);
    } catch {
        // Nothing recorded: nothing to forget.
    }
}
/**
 * Move a project's commit snapshot from one stored name to another.
 *
 * A rename that moved only the files would make the next load look as though
 * every file had changed (the base would be gone) or, worse, as though the
 * project had never been committed. Both names are taken exactly as stored,
 * because the source predates the snake_case rule and normalising it would
 * point at a key that was never written.
 *
 * The write happens before the delete, so an interrupted rename leaves the
 * snapshot under both names rather than losing it.
 *
 * @param {string} from The stored name to move from.
 * @param {string} to The stored name to move to.
 * @param {{ kind?: string }} [options]
 * @returns {Promise<boolean>} True when a snapshot was moved.
 */
export async function renameCommitSnapshot(from, to, { kind = 'work' } = {}) {
    const source = requireStoredName(from);
    const target = requireStoredName(to);
    if (source === target) {
        return false;
    }

    const prefix = `${SNAPSHOT_PREFIX}${keyPrefix(kind)}`;
    const snapshot = await idbGet(META_STORE, prefix + source);
    if (!snapshot) {
        return false;
    }

    await idbPut(META_STORE, snapshot, prefix + target);
    await idbDelete(META_STORE, prefix + source);
    return true;
}
/**
 * Delete a whole project, by its stored name.
 *
 * The name is used verbatim, so deleting `my-project` cannot delete `my_project`.
 *
 * @param {string} name Stored project name.
 * @returns {Promise<void>}
 */
export async function deleteProject(name, { kind = 'work' } = {}) {
    const project = requireStoredName(name);

    if (hasOpfs()) {
        const root = await kindRoot(kind);
        try {
            await root.removeEntry(project, { recursive: true });
        } catch (error) {
            if (!isMissing(error)) {
                throw error;
            }
        }
    } else {
        await idbDeletePrefix(FILE_STORE, `${keyPrefix(kind)}${project}/`);
    }

    await idbDelete(META_STORE, keyPrefix(kind) + project);
    await clearCommitSnapshot(project, { kind });
}
/**
 * Rename a project directory.
 *
 * `from` is the name the project is stored under, exactly. It may predate the
 * snake_case rule (`my-project`), which is why it is not normalised here: the
 * migration needs to move that directory to `my_project`, and normalising the
 * source first would leave the old directory behind. `to` is normalised, so
 * every project written after a rename is canonical.
 *
 * @param {string} from Stored project name.
 * @param {string} to New project name.
 * @param {{ kind?: string }} [options]
 * @returns {Promise<void>}
 */
export async function renameProject(from, to, { kind = 'work' } = {}) {
    const source = requireStoredName(from);
    const target = requireProject(to);
    if (source === target) {
        return;
    }

    if (hasOpfs()) {
        const root = await kindRoot(kind);
        try {
            await root.getDirectoryHandle(target);
            throw new Error(`vault: project "${target}" already exists`);
        } catch (error) {
            if (!isMissing(error)) {
                throw error;
            }
        }

        let sourceDir;
        try {
            sourceDir = await root.getDirectoryHandle(source);
        } catch (error) {
            if (isMissing(error)) {
                return;
            }
            throw error;
        }

        const targetDir = await root.getDirectoryHandle(target, { create: true });
        for await (const { path, handle } of walkFiles(sourceDir)) {
            const segments = path.split('/');
            const filename = segments.pop();
            let parent = targetDir;
            for (const segment of segments) {
                parent = await parent.getDirectoryHandle(segment, { create: true });
            }
            const copy = await parent.getFileHandle(filename, { create: true });
            const writable = await copy.createWritable();
            try {
                await writable.write(await (await handle.getFile()).text());
            } finally {
                await writable.close();
            }
        }

        await removeTree(sourceDir);
        await root.removeEntry(source, { recursive: true });
    } else {
        const files = await idbReadProject(kind, source);
        const entries = await idbEntries(FILE_STORE, `${keyPrefix(kind)}${source}/`);
        if (entries.length === 0) {
            return;
        }
        if ((await idbEntries(FILE_STORE, `${keyPrefix(kind)}${target}/`)).length > 0) {
            throw new Error(`vault: project "${target}" already exists`);
        }
        for (const [path, content] of Object.entries(files)) {
            await idbPut(FILE_STORE, content, `${keyPrefix(kind)}${target}/${path}`);
        }
        await idbDeletePrefix(FILE_STORE, `${keyPrefix(kind)}${source}/`);
    }

    await touchProject(kind, target);
    await idbDelete(META_STORE, keyPrefix(kind) + source);
}
