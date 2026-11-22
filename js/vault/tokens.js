/**
 * GitHub token persistence in IndexedDB.
 *
 * One record, one key: `auth` store, key `tokens`. Nothing here renders or
 * logs a token — callers get the object back and decide.
 *
 * This module shares the `pydle` database with `fs.js`; both openers create
 * whatever stores are missing, so load order does not matter.
 */

const DB_NAME = 'pydle';
const DB_VERSION = 1;
const AUTH_STORE = 'auth';
const FILE_STORE = 'files';
const META_STORE = 'meta';
const TOKENS_KEY = 'tokens';

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
                reject(new Error('tokens: IndexedDB is not available'));
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
 * Run one operation against the auth store.
 *
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} operation
 * @returns {Promise<T>}
 */
async function runAuth(mode, operation) {
    const database = await db();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(AUTH_STORE, mode);
        const request = operation(transaction.objectStore(AUTH_STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error ?? request.error);
        transaction.onabort = () => reject(transaction.error ?? request.error);
    });
}

/**
 * Persist the OAuth tokens.
 *
 * `expiresAt` is stored as given (milliseconds since the epoch is expected);
 * `savedAt` is added so a caller can reason about staleness.
 *
 * @param {object} tokens
 * @param {string} tokens.accessToken
 * @param {string} [tokens.refreshToken]
 * @param {number} [tokens.expiresAt]
 * @param {string} [tokens.scope]
 * @returns {Promise<void>}
 */
export async function saveTokens(tokens) {
    if (tokens === null || typeof tokens !== 'object') {
        throw new TypeError(`tokens: saveTokens expected an object, got ${tokens === null ? 'null' : typeof tokens}`);
    }

    const record = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        savedAt: Date.now(),
    };

    await runAuth('readwrite', (store) => store.put(record, TOKENS_KEY));
}

/**
 * Load the stored tokens.
 *
 * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt?: number, scope?: string, savedAt: number } | null>}
 *   The saved record, or null when this device has none.
 */
export async function loadTokens() {
    const record = await runAuth('readonly', (store) => store.get(TOKENS_KEY));
    if (record === undefined || record === null || typeof record !== 'object') {
        return null;
    }
    return record;
}

/**
 * Forget this device: remove the stored tokens.
 *
 * @returns {Promise<void>}
 */
export async function clearTokens() {
    await runAuth('readwrite', (store) => store.delete(TOKENS_KEY));
}
