import { test } from 'node:test';
import assert from 'node:assert/strict';

/*
 * `renameCommitSnapshot` moves the local record of what was last committed from
 * one project name to another. It only touches IndexedDB, so the test supplies a
 * tiny in-memory implementation of the small part of the API the vault uses.
 *
 * The names matter: a project saved before the snake_case rule has its snapshot
 * under the hyphenated name (`commit:my-project`), while everything written now
 * uses `commit:my_project`. The two keys are seeded and checked directly, which
 * is the only way to reproduce a name storage no longer produces itself.
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
                    const rows = stores.get(name);
                    const transaction = {};

                    const finish = () => {
                        queueMicrotask(() => {
                            if (typeof transaction.oncomplete === 'function') {
                                transaction.oncomplete();
                            }
                        });
                    };

                    transaction.objectStore = () => ({
                        get(key) {
                            const result = {};
                            queueMicrotask(() => {
                                result.result = rows.get(key);
                                if (typeof result.onsuccess === 'function') {
                                    result.onsuccess();
                                }
                                finish();
                            });
                            return result;
                        },
                        put(value, key) {
                            const result = {};
                            queueMicrotask(() => {
                                rows.set(key, value);
                                result.result = key;
                                if (typeof result.onsuccess === 'function') {
                                    result.onsuccess();
                                }
                                finish();
                            });
                            return result;
                        },
                        delete(key) {
                            const result = {};
                            queueMicrotask(() => {
                                rows.delete(key);
                                if (typeof result.onsuccess === 'function') {
                                    result.onsuccess();
                                }
                                finish();
                            });
                            return result;
                        },
                    });

                    return transaction;
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

test('renameCommitSnapshot moves a hyphenated snapshot to the snake_case key', async () => {
    const meta = table('meta');
    const snapshot = { sha: 'abc123', files: { 'main.py': 'beef' } };
    meta.set('commit:my-project', snapshot);

    const moved = await fs.renameCommitSnapshot('my-project', 'my_project');

    assert.equal(moved, true);
    assert.equal(meta.has('commit:my-project'), false);
    assert.deepEqual(meta.get('commit:my_project'), snapshot);
    assert.deepEqual(await fs.readCommitSnapshot('my_project'), snapshot);
});

test('renameCommitSnapshot keeps the namespace it was given', async () => {
    const meta = table('meta');
    meta.set('commit:drawings/my-picture', { sha: 'def', files: {} });

    const moved = await fs.renameCommitSnapshot('my-picture', 'my_picture', {
        kind: 'drawings',
    });

    assert.equal(moved, true);
    assert.equal(meta.has('commit:drawings/my-picture'), false);
    assert.deepEqual(meta.get('commit:drawings/my_picture'), { sha: 'def', files: {} });
});

test('renameCommitSnapshot is a quiet no-op when nothing was committed', async () => {
    const meta = table('meta');

    assert.equal(await fs.renameCommitSnapshot('never_committed', 'still_never'), false);
    assert.equal(meta.has('commit:still_never'), false);
});

test('renameCommitSnapshot does nothing when both names are the same', async () => {
    const meta = table('meta');
    const snapshot = { sha: 'x', files: {} };
    meta.set('commit:my_project', snapshot);

    assert.equal(await fs.renameCommitSnapshot('my_project', 'my_project'), false);
    assert.deepEqual(meta.get('commit:my_project'), snapshot);
});

test('renameCommitSnapshot refuses a name that is a path', async () => {
    await assert.rejects(
        () => fs.renameCommitSnapshot('a/b', 'my_project'),
        TypeError,
    );
    await assert.rejects(() => fs.renameCommitSnapshot('my_project', '..'), TypeError);
});
