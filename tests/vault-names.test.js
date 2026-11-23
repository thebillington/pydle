import { test } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Project names are stored, not computed.
 *
 * The bug this file pins down: `listProjects()` returns directories under their
 * stored names, which may predate the snake_case rule (`old-name`). Every read
 * and write used to normalise the name first, so opening `old-name` read
 * `old_name`'s directory — and saving then overwrote it. A stored name and its
 * canonical twin must stay two different projects.
 *
 * Node has neither OPFS nor IndexedDB, so this supplies the small in-memory part
 * of IndexedDB the vault actually uses (get/put/delete, prefix listing and a
 * cursor). That exercises the real `js/vault/fs.js` over its IndexedDB backend,
 * not a shim of the vault itself.
 */

/** store name -> key/value map */
const stores = new Map();

/**
 * @param {string} name
 * @returns {Map<unknown, unknown>}
 */
function table(name) {
    if (!stores.has(name)) {
        stores.set(name, new Map());
    }
    return stores.get(name);
}

/**
 * @param {{ lower: string, upper: string } | null} range
 * @param {unknown} key
 * @returns {boolean}
 */
function inRange(range, key) {
    if (!range) {
        return true;
    }
    return key >= range.lower && key <= range.upper;
}

globalThis.IDBKeyRange = {
    bound(lower, upper) {
        return { lower, upper };
    },
};

/**
 * One transaction over a single store, completing after every request it made.
 *
 * @param {Map<unknown, unknown>} rows
 * @returns {{ oncomplete: null | (() => void), objectStore: () => object }}
 */
function createTransaction(rows) {
    const transaction = { oncomplete: null, onerror: null, onabort: null };
    let pending = 0;
    let scheduled = false;

    const settle = () => {
        if (pending !== 0 || scheduled) {
            return;
        }
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            if (pending === 0 && typeof transaction.oncomplete === 'function') {
                transaction.oncomplete();
            }
        });
    };

    /**
     * @param {() => void} work
     */
    const track = (work) => {
        pending += 1;
        queueMicrotask(() => {
            try {
                work();
            } finally {
                pending -= 1;
                settle();
            }
        });
    };

    const store = {
        get(key) {
            const request = {};
            track(() => {
                request.result = rows.get(key);
                if (typeof request.onsuccess === 'function') {
                    request.onsuccess();
                }
            });
            return request;
        },
        put(value, key) {
            const request = {};
            track(() => {
                rows.set(key, value);
                request.result = key;
                if (typeof request.onsuccess === 'function') {
                    request.onsuccess();
                }
            });
            return request;
        },
        delete(key) {
            const request = {};
            track(() => {
                rows.delete(key);
                if (typeof request.onsuccess === 'function') {
                    request.onsuccess();
                }
            });
            return request;
        },
        getAllKeys(range) {
            const request = {};
            track(() => {
                request.result = [...rows.keys()].filter((key) => inRange(range, key));
                if (typeof request.onsuccess === 'function') {
                    request.onsuccess();
                }
            });
            return request;
        },
        getAll(range) {
            const request = {};
            track(() => {
                request.result = [...rows.entries()]
                    .filter(([key]) => inRange(range, key))
                    .map(([, value]) => value);
                if (typeof request.onsuccess === 'function') {
                    request.onsuccess();
                }
            });
            return request;
        },
        openKeyCursor(range) {
            const keys = [...rows.keys()].filter((key) => inRange(range, key));
            const request = {};
            let index = 0;
            pending += 1;

            const step = () => {
                queueMicrotask(() => {
                    if (index >= keys.length) {
                        request.result = null;
                        if (typeof request.onsuccess === 'function') {
                            request.onsuccess();
                        }
                        pending -= 1;
                        settle();
                        return;
                    }
                    const key = keys[index];
                    index += 1;
                    request.result = { primaryKey: key, continue: step };
                    if (typeof request.onsuccess === 'function') {
                        request.onsuccess();
                    }
                });
            };
            step();
            return request;
        },
    };

    transaction.objectStore = () => store;
    return transaction;
}

globalThis.indexedDB = {
    open() {
        const request = {};

        queueMicrotask(() => {
            const database = {
                objectStoreNames: {
                    contains: (name) => stores.has(name),
                },
                createObjectStore(name) {
                    table(name);
                    return {};
                },
                transaction(name) {
                    if (!stores.has(name)) {
                        throw new Error(`fake indexedDB: no store ${name}`);
                    }
                    return createTransaction(stores.get(name));
                },
            };

            request.result = database;
            if (typeof request.onupgradeneeded === 'function') {
                request.onupgradeneeded();
            }
            if (typeof request.onsuccess === 'function') {
                request.onsuccess();
            }
        });

        return request;
    },
};

const fs = await import('../js/vault/fs.js');

test('a stored hyphenated name and its canonical twin stay separate', async () => {
    await fs.writeFile('old-name', 'main.py', 'print("legacy")\n');

    // The legacy project is stored under the name it was listed as, and reads
    // back from there.
    assert.deepEqual(await fs.readProject('old-name'), { 'main.py': 'print("legacy")\n' });
    // The canonical name is a different project, and it does not exist yet.
    assert.deepEqual(await fs.readProject('old_name'), {});
    assert.equal(table('files').has('old-name/main.py'), true);
    assert.equal(table('files').has('old_name/main.py'), false);

    // Writing to the twin does not touch the legacy project.
    await fs.writeFile('old_name', 'main.py', 'print("twin")\n');

    assert.deepEqual(await fs.readProject('old-name'), { 'main.py': 'print("legacy")\n' });
    assert.deepEqual(await fs.readProject('old_name'), { 'main.py': 'print("twin")\n' });
});

test('listProjects reports both names and warns that they are ambiguous', async () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args);

    let listed;
    try {
        listed = await fs.listProjects();
    } finally {
        console.warn = original;
    }

    const names = listed.map((entry) => entry.name);
    assert.ok(names.includes('old-name'), names.join(', '));
    assert.ok(names.includes('old_name'), names.join(', '));

    assert.ok(
        warnings.some(
            (args) =>
                args[0] === '[pydle] vault: ambiguous project name' && args[1] === 'old-name',
        ),
        JSON.stringify(warnings),
    );
    // The canonical name is not itself ambiguous.
    assert.ok(
        !warnings.some((args) => args[1] === 'old_name'),
        JSON.stringify(warnings),
    );
});

test('deleting one of the twins leaves the other alone', async () => {
    await fs.writeFile('left-over', 'main.py', 'a');
    await fs.writeFile('left_over', 'main.py', 'b');

    await fs.deleteProject('left-over');

    assert.deepEqual(await fs.readProject('left-over'), {});
    assert.deepEqual(await fs.readProject('left_over'), { 'main.py': 'b' });
});

test('commit snapshots are keyed by the stored name', async () => {
    await fs.writeCommitSnapshot('snapshot-pair', { sha: 'abc', files: {} });

    assert.deepEqual(await fs.readCommitSnapshot('snapshot-pair'), { sha: 'abc', files: {} });
    assert.equal(await fs.readCommitSnapshot('snapshot_pair'), null);

    await fs.clearCommitSnapshot('snapshot_pair');
    assert.deepEqual(await fs.readCommitSnapshot('snapshot-pair'), { sha: 'abc', files: {} });

    await fs.clearCommitSnapshot('snapshot-pair');
    assert.equal(await fs.readCommitSnapshot('snapshot-pair'), null);
});

test('writeFile with a canonical new name creates the project', async () => {
    await fs.writeFile('fresh_project', 'main.py', 'print(1)\n');

    assert.deepEqual(await fs.readProject('fresh_project'), { 'main.py': 'print(1)\n' });
    assert.equal(table('files').has('fresh_project/main.py'), true);

    const listed = await fs.listProjects();
    assert.ok(listed.some((entry) => entry.name === 'fresh_project'));
});

test('renameProject takes the stored source name and normalises the target', async () => {
    await fs.writeFile('to-rename', 'main.py', 'x = 1\n');
    await fs.writeCommitSnapshot('to-rename', { sha: 'def', files: { 'main.py': 'beef' } });

    await fs.renameProject('to-rename', 'Renamed Thing');

    assert.deepEqual(await fs.readProject('renamed_thing'), { 'main.py': 'x = 1\n' });
    assert.deepEqual(await fs.readProject('to-rename'), {});

    // Moving the snapshot is a separate call (sync.js pairs them), and it takes
    // the stored source name too.
    assert.deepEqual(await fs.readCommitSnapshot('to-rename'), {
        sha: 'def',
        files: { 'main.py': 'beef' },
    });
    await fs.renameCommitSnapshot('to-rename', 'renamed_thing');
    assert.deepEqual(await fs.readCommitSnapshot('renamed_thing'), {
        sha: 'def',
        files: { 'main.py': 'beef' },
    });
});

test('names that are not one plain path segment are rejected', async () => {
    const bad = ['a/b', '..', '.', '', 'a\\b', '/abs', 'a\u0000b', 'a//b'];

    for (const name of bad) {
        const label = JSON.stringify(name);

        await assert.rejects(
            () => fs.readProject(name),
            { name: 'TypeError' },
            `readProject accepted ${label}`,
        );
        await assert.rejects(
            () => fs.writeFile(name, 'main.py', 'x'),
            { name: 'TypeError' },
            `writeFile accepted ${label}`,
        );
        await assert.rejects(
            () => fs.deleteFile(name, 'main.py'),
            { name: 'TypeError' },
            `deleteFile accepted ${label}`,
        );
        await assert.rejects(
            () => fs.deleteProject(name),
            { name: 'TypeError' },
            `deleteProject accepted ${label}`,
        );
        await assert.rejects(
            () => fs.readCommitSnapshot(name),
            { name: 'TypeError' },
            `readCommitSnapshot accepted ${label}`,
        );
        await assert.rejects(
            () => fs.writeCommitSnapshot(name, { files: {} }),
            { name: 'TypeError' },
            `writeCommitSnapshot accepted ${label}`,
        );
        await assert.rejects(
            () => fs.clearCommitSnapshot(name),
            { name: 'TypeError' },
            `clearCommitSnapshot accepted ${label}`,
        );
    }

    // Nothing was written under a malformed key either.
    const keys = [...table('files').keys()];
    assert.ok(!keys.some((key) => key.includes('..')), keys.join(', '));
    assert.ok(!keys.some((key) => key.startsWith('/')), keys.join(', '));
});
