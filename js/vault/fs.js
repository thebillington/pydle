/**
 * Local vault storage: one call surface over the Origin Private File System
 * (OPFS) with an IndexedDB fallback.
 *
 * Layout is `project/relative/path` in both backends. Every caller-supplied
 * path goes through `safeJoin` and is checked with `assertInside`, so a path
 * can never leave its project. `updatedAt` bookkeeping lives in IndexedDB in
 * both backends (`meta` store), because OPFS does not expose a directory mtime.
 *
 * Missing files and projects are never an error: reads return `null` or `{}`.
 */

import { isReservedPath, normalizeProjectName, safeJoin } from './paths.js';

/** IndexedDB database shared with the token store. */
const DB_NAME = 'pydle';

/** Schema version; stores are created on demand so any opener can upgrade. */
const DB_VERSION = 1;

const FILE_STORE = 'files';
const META_STORE = 'meta';
const AUTH_STORE = 'auth';

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
 * @param {string} project Normalised project slug.
 * @returns {Promise<void>}
 */
async function touchProject(project) {
    await idbPut(META_STORE, { updatedAt: Date.now() }, project);
}

/**
 * Read a project's recorded update time.
 *
 * @param {string} project Normalised project slug.
 * @returns {Promise<number>} Milliseconds since the epoch, or 0.
 */
async function projectUpdatedAt(project) {
    try {
        const record = await idbGet(META_STORE, project);
        return record && Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
    } catch {
        return 0;
    }
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalise a project name, throwing on unusable input.
 *
 * @param {string} project
 * @returns {string}
 */
function requireProject(project) {
    return normalizeProjectName(project);
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
 * @param {string} project Normalised slug.
 * @param {boolean} [create]
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function projectDir(project, create = false) {
    const root = await vaultRoot(create);
    return root.getDirectoryHandle(project, { create });
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

/* ------------------------------------------------------------------ */
/* IndexedDB backend                                                   */
/* ------------------------------------------------------------------ */

/**
 * Read one file from the IndexedDB store.
 *
 * @param {string} project Normalised slug.
 * @param {string} path Normalised relative path.
 * @returns {Promise<string | null>}
 */
async function idbReadFile(project, path) {
    const value = await idbGet(FILE_STORE, `${project}/${path}`);
    return typeof value === 'string' ? value : null;
}

/**
 * All files of one project as `{ path: content }`.
 *
 * @param {string} project Normalised slug.
 * @returns {Promise<Record<string, string>>}
 */
async function idbReadProject(project) {
    const prefix = `${project}/`;
    const entries = await idbEntries(FILE_STORE, prefix);
    const files = {};
    for (const [key, value] of entries) {
        if (typeof key === 'string' && typeof value === 'string') {
            files[key.slice(prefix.length)] = value;
        }
    }
    return files;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which storage backend this browser will use.
 *
 * @returns {'opfs' | 'idb'}
 */
export function isAvailable() {
    return hasOpfs() ? 'opfs' : 'idb';
}

/**
 * List projects, newest first.
 *
 * @returns {Promise<Array<{ name: string, updatedAt: number }>>}
 */
export async function listProjects() {
    /** @type {Map<string, number>} */
    const projects = new Map();

    if (hasOpfs()) {
        const root = await vaultRoot();
        for await (const [name, handle] of root.entries()) {
            if (handle.kind !== 'directory') {
                continue;
            }
            // Every project we create is already a slug. Anything else (a stray
            // directory made by hand) would be listed but never readable, since
            // every other call normalises its argument, so skip it.
            let slug;
            try {
                slug = normalizeProjectName(name);
            } catch {
                continue;
            }
            if (slug !== name) {
                continue;
            }
            projects.set(slug, 0);
        }
        // Fill in mtimes for anything the meta store has not seen.
        for (const [name, updatedAt] of projects) {
            let resolved = updatedAt;
            try {
                resolved = await projectUpdatedAt(name);
            } catch {
                resolved = 0;
            }
            if (resolved === 0) {
                try {
                    const dir = await projectDir(name);
                    for await (const { handle } of walkFiles(dir)) {
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
            if (typeof key !== 'string') {
                continue;
            }
            const slash = key.indexOf('/');
            if (slash > 0) {
                projects.set(key.slice(0, slash), 0);
            }
        }
        for (const name of projects.keys()) {
            projects.set(name, await projectUpdatedAt(name));
        }
        for (const [key, value] of await idbEntries(META_STORE)) {
            if (typeof key !== 'string' || projects.has(key)) {
                continue;
            }
            const updatedAt = value && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
            projects.set(key, updatedAt);
        }
    }

    return [...projects.entries()]
        .map(([name, updatedAt]) => ({ name, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/**
 * Read every file in a project as `{ relativePath: content }`.
 *
 * A missing (or unusable) project returns `{}`.
 *
 * @param {string} name Project name.
 * @returns {Promise<Record<string, string>>}
 */
export async function readProject(name) {
    let project;
    try {
        project = requireProject(name);
    } catch {
        return {};
    }

    if (hasOpfs()) {
        let dir;
        try {
            dir = await projectDir(project);
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

    return idbReadProject(project);
}

/**
 * Create or overwrite one file.
 *
 * Parent directories are created as needed.
 *
 * @param {string} project Project name.
 * @param {string} path Path relative to the project root.
 * @param {string} content UTF-8 text.
 * @returns {Promise<void>}
 */
export async function writeFile(project, path, content) {
    const name = requireProject(project);
    const relative = requirePath(path);
    if (typeof content !== 'string') {
        throw new TypeError(
            `vault: content for "${relative}" must be a string, got ${typeof content}`,
        );
    }

    if (hasOpfs()) {
        const dir = await projectDir(name, true);
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
        await idbPut(FILE_STORE, content, `${name}/${relative}`);
    }

    await touchProject(name);
}

/**
 * Delete one file. Missing files are ignored.
 *
 * @param {string} project Project name.
 * @param {string} path Path relative to the project root.
 * @returns {Promise<boolean>} True when something was removed.
 */
export async function deleteFile(project, path) {
    const name = requireProject(project);
    const relative = requirePath(path);

    if (hasOpfs()) {
        let dir;
        try {
            dir = await projectDir(name);
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
        await touchProject(name);
        return true;
    }

    const key = `${name}/${relative}`;
    const existing = await idbGet(FILE_STORE, key);
    if (existing === undefined) {
        return false;
    }
    await idbDelete(FILE_STORE, key);
    await touchProject(name);
    return true;
}

/**
 * Delete a project and everything in it. Missing projects are ignored.
 *
 * @param {string} name Project name.
 * @returns {Promise<void>}
 */
export async function deleteProject(name) {
    const project = requireProject(name);

    if (hasOpfs()) {
        const root = await vaultRoot();
        try {
            await root.removeEntry(project, { recursive: true });
        } catch (error) {
            if (!isMissing(error)) {
                throw error;
            }
        }
    } else {
        await idbDeletePrefix(FILE_STORE, `${project}/`);
    }

    await idbDelete(META_STORE, project);
}

/**
 * Rename a project, keeping every file.
 *
 * @param {string} from Current project name.
 * @param {string} to New project name.
 * @returns {Promise<void>}
 */
export async function renameProject(from, to) {
    const source = requireProject(from);
    const target = requireProject(to);
    if (source === target) {
        return;
    }

    if (hasOpfs()) {
        const root = await vaultRoot();
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
        const files = await idbReadProject(source);
        const entries = await idbEntries(FILE_STORE, `${source}/`);
        if (entries.length === 0) {
            return;
        }
        if ((await idbEntries(FILE_STORE, `${target}/`)).length > 0) {
            throw new Error(`vault: project "${target}" already exists`);
        }
        for (const [path, content] of Object.entries(files)) {
            await idbPut(FILE_STORE, content, `${target}/${path}`);
        }
        await idbDeletePrefix(FILE_STORE, `${source}/`);
    }

    await touchProject(target);
    await idbDelete(META_STORE, source);
}
