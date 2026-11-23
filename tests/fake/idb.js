/**
 * A tiny in-memory `indexedDB`, enough for `js/vault/fs.js` and
 * `js/vault/tokens.js`.
 *
 * It is deliberately not a general implementation. The vault only needs one
 * database, stores without key paths or indexes, `get`/`put`/`delete`,
 * `getAll`/`getAllKeys` and a key cursor for prefix deletes. Everything is
 * asynchronous the way IndexedDB is: request callbacks and transaction
 * completion run in microtasks, so callers can attach handlers after issuing a
 * request (which is exactly what the vault does).
 *
 * `reset()` clears the contents of every store but keeps the database objects
 * alive. The vault modules cache their `dbPromise` at module scope, so swapping
 * the database object between tests would leave two openers writing to two
 * different databases.
 */

/** @type {Map<string, FakeDatabase>} */
const databases = new Map();

/** Monotonic key for `put(value)` without a key. Unused by the vault. */
let autoKey = 1;

/**
 * Compare two IndexedDB keys. The vault only uses strings, so string order is
 * the only interesting case, but numbers are handled for completeness.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
function compareKeys(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b;
    }
    const left = String(a);
    const right = String(b);
    return left < right ? -1 : left > right ? 1 : 0;
}

/** One request, with the fields the vault reads. */
class FakeRequest {
    constructor() {
        /** @type {any} */
        this.result = undefined;
        /** @type {any} */
        this.error = null;
        /** @type {(() => void) | null} */
        this.onsuccess = null;
        /** @type {(() => void) | null} */
        this.onerror = null;
    }
}

/** An `IDBKeyRange`-shaped filter. */
class FakeKeyRange {
    /**
     * @param {unknown} lower
     * @param {unknown} upper
     * @param {boolean} lowerOpen
     * @param {boolean} upperOpen
     */
    constructor(lower, upper, lowerOpen = false, upperOpen = false) {
        this.lower = lower;
        this.upper = upper;
        this.lowerOpen = lowerOpen;
        this.upperOpen = upperOpen;
    }

    /** @param {unknown} key */
    includes(key) {
        const aboveLower = this.lower === undefined
            ? true
            : this.lowerOpen
              ? compareKeys(key, this.lower) > 0
              : compareKeys(key, this.lower) >= 0;
        const belowUpper = this.upper === undefined
            ? true
            : this.upperOpen
              ? compareKeys(key, this.upper) < 0
              : compareKeys(key, this.upper) <= 0;
        return aboveLower && belowUpper;
    }

    static bound(lower, upper, lowerOpen = false, upperOpen = false) {
        return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
    }

    static only(value) {
        return new FakeKeyRange(value, value, false, false);
    }

    static lowerBound(lower, open = false) {
        return new FakeKeyRange(lower, undefined, open, true);
    }

    static upperBound(upper, open = false) {
        return new FakeKeyRange(undefined, upper, true, open);
    }
}

/**
 * One transaction. Completion fires once every request issued through it has
 * finished, including a cursor that keeps calling `continue()`.
 */
class FakeTransaction {
    /**
     * @param {FakeDatabase} db
     * @param {string | string[]} names
     * @param {string} mode
     */
    constructor(db, names, mode) {
        this.db = db;
        this.mode = mode;
        /** @type {any} */
        this.error = null;
        /** @type {(() => void) | null} */
        this.oncomplete = null;
        /** @type {(() => void) | null} */
        this.onerror = null;
        /** @type {(() => void) | null} */
        this.onabort = null;
        this._pending = 0;
        this._finished = false;
        this._scopes = new Set(Array.isArray(names) ? names : [names]);

        for (const name of this._scopes) {
            if (!db._stores.has(name)) {
                throw new Error(`fake-indexeddb: no object store called ${JSON.stringify(name)}`);
            }
        }
    }

    /** @param {string} name */
    objectStore(name) {
        if (!this._scopes.has(name)) {
            throw new Error(`fake-indexeddb: ${JSON.stringify(name)} is not in this transaction`);
        }
        const data = this.db._stores.get(name);
        if (!data) {
            throw new Error(`fake-indexeddb: no object store called ${JSON.stringify(name)}`);
        }
        return new FakeObjectStore(this, data);
    }

    _begin() {
        this._pending += 1;
    }

    _end() {
        this._pending -= 1;
        this._maybeComplete();
    }

    _maybeComplete() {
        if (this._finished || this._pending > 0) {
            return;
        }
        this._finished = true;
        queueMicrotask(() => {
            if (this.oncomplete) {
                this.oncomplete();
            }
        });
    }

    /**
     * Run one request body synchronously, then report success in a microtask.
     *
     * Computing the result synchronously is what lets the vault read
     * `request.result` from `transaction.oncomplete`, which it does in `run()`.
     *
     * @param {() => any} operation
     * @returns {FakeRequest}
     */
    _request(operation) {
        const request = new FakeRequest();
        try {
            request.result = operation();
        } catch (error) {
            request.error = error;
            this.error = error;
        }
        this._begin();
        queueMicrotask(() => {
            if (request.error) {
                if (request.onerror) {
                    request.onerror();
                }
            } else if (request.onsuccess) {
                request.onsuccess();
            }
            this._end();
        });
        return request;
    }
}

/** One object store's methods, scoped to a transaction. */
class FakeObjectStore {
    /**
     * @param {FakeTransaction} transaction
     * @param {Map<any, any>} data
     */
    constructor(transaction, data) {
        this.transaction = transaction;
        this._data = data;
    }

    /** @param {unknown} query */
    _keys(query) {
        const keys = [...this._data.keys()].sort(compareKeys);
        const range = query && typeof query.includes === 'function' ? query : null;
        return range ? keys.filter((key) => range.includes(key)) : keys;
    }

    /** @param {unknown} key */
    get(key) {
        return this.transaction._request(() => this._data.get(key));
    }

    /**
     * @param {unknown} value
     * @param {unknown} [key]
     */
    put(value, key) {
        return this.transaction._request(() => {
            const effective = key === undefined ? `auto:${autoKey++}` : key;
            this._data.set(effective, value);
            return effective;
        });
    }

    /** @param {unknown} key */
    delete(key) {
        return this.transaction._request(() => {
            this._data.delete(key);
            return undefined;
        });
    }

    /** @param {unknown} [query] */
    getAll(query) {
        return this.transaction._request(() => this._keys(query).map((key) => this._data.get(key)));
    }

    /** @param {unknown} [query] */
    getAllKeys(query) {
        return this.transaction._request(() => this._keys(query));
    }

    /**
     * A key cursor, which is all `idbDeletePrefix` needs.
     *
     * The transaction stays open until the cursor runs out, so the deletes issued
     * from `cursor.continue()` all belong to the same transaction, as in a browser.
     *
     * @param {unknown} [query]
     */
    openKeyCursor(query) {
        const request = new FakeRequest();
        const keys = this._keys(query);
        let index = 0;

        this.transaction._begin();

        const step = () => {
            if (index >= keys.length) {
                request.result = null;
                if (request.onsuccess) {
                    request.onsuccess();
                }
                this.transaction._end();
                return;
            }

            const key = keys[index];
            index += 1;
            request.result = {
                key,
                primaryKey: key,
                continue: () => queueMicrotask(step),
            };
            if (request.onsuccess) {
                request.onsuccess();
            }
        };

        queueMicrotask(step);
        return request;
    }
}

/** The `objectStoreNames` collection a caller can inspect. */
class StoreNames {
    /** @param {Map<string, Map<any, any>>} stores */
    constructor(stores) {
        this._stores = stores;
        this.length = stores.size;
    }

    /** @param {string} name */
    contains(name) {
        return this._stores.has(name);
    }

    /** @param {number} index */
    item(index) {
        return [...this._stores.keys()][index] ?? null;
    }

    [Symbol.iterator]() {
        return this._stores.keys();
    }
}

/** A database handle. */
class FakeDatabase {
    /**
     * @param {string} name
     * @param {number} version
     */
    constructor(name, version) {
        this.name = name;
        this.version = version;
        /** @type {Map<string, Map<any, any>>} */
        this._stores = new Map();
        this.objectStoreNames = new StoreNames(this._stores);
    }

    /** @param {string} name */
    createObjectStore(name) {
        if (!this._stores.has(name)) {
            this._stores.set(name, new Map());
        }
        this.objectStoreNames = new StoreNames(this._stores);
        return { name };
    }

    /**
     * @param {string | string[]} names
     * @param {string} [mode]
     */
    transaction(names, mode = 'readonly') {
        return new FakeTransaction(this, names, mode);
    }

    close() {}
}

/** The `indexedDB` object installed on `globalThis`. */
const fakeIndexedDB = {
    /**
     * @param {string} name
     * @param {number} [version]
     */
    open(name, version = 1) {
        const request = new FakeRequest();
        queueMicrotask(() => {
            const target = Number(version) || 1;
            let db = databases.get(name);
            if (!db) {
                db = new FakeDatabase(name, 0);
                databases.set(name, db);
            }

            const oldVersion = db.version;
            request.result = db;

            try {
                if (target > oldVersion) {
                    // Upgrade before success, exactly like a browser, and with the
                    // new version already visible on the handle.
                    db.version = target;
                    db.objectStoreNames = new StoreNames(db._stores);
                    if (request.onupgradeneeded) {
                        request.onupgradeneeded();
                    }
                }
                if (request.onsuccess) {
                    request.onsuccess();
                }
            } catch (error) {
                request.error = error;
                if (request.onerror) {
                    request.onerror();
                }
            }
        });
        return request;
    },

    /** @param {string} name */
    deleteDatabase(name) {
        const request = new FakeRequest();
        queueMicrotask(() => {
            databases.delete(name);
            request.result = undefined;
            if (request.onsuccess) {
                request.onsuccess();
            }
        });
        return request;
    },
};

/**
 * Install the fake on `globalThis` and return a reset hook.
 *
 * `reset()` empties every store in every database created so far and leaves the
 * handles in place, which is what the vault's module-level `dbPromise` needs.
 *
 * @returns {{ reset: () => void }}
 */
export function install() {
    globalThis.indexedDB = fakeIndexedDB;
    globalThis.IDBKeyRange = FakeKeyRange;

    return {
        reset() {
            for (const db of databases.values()) {
                for (const store of db._stores.values()) {
                    store.clear();
                }
            }
        },
    };
}
