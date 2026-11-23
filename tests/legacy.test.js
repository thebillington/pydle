import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LEGACY_PREFIX,
    importLegacyProjects,
    listLegacyProjects,
    noteLegacyMismatch,
    readLegacyProject,
} from '../js/vault/legacy.js';

/**
 * Minimal localStorage double: insertion-ordered keys, `null` for a miss.
 *
 * @param {Record<string, string>} [initial]
 */
function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return map.has(key) ? map.get(key) : null;
        },
        setItem(key, value) {
            map.set(key, String(value));
        },
        removeItem(key) {
            map.delete(key);
        },
        key(index) {
            const keys = [...map.keys()];
            return index >= 0 && index < keys.length ? keys[index] : null;
        },
        get length() {
            return map.size;
        },
        has(key) {
            return map.has(key);
        },
        keys() {
            return [...map.keys()];
        },
    };
}

/**
 * A writer that records calls, optionally throwing for chosen projects.
 *
 * @param {Set<string>} [failing]
 */
function fakeWriter(failing = new Set()) {
    const writes = [];
    async function writeFile(name, path, content) {
        if (failing.has(name)) {
            throw new Error(`disk says no for ${name}`);
        }
        writes.push({ name, path, content });
    }
    return { writeFile, writes };
}

/** Vault lister backed by whatever has been written so far. */
function listerFor(writes) {
    return async () => [...new Set(writes.map((write) => write.name))];
}

test('listLegacyProjects returns only names under the prefix, sorted', () => {
    const storage = fakeStorage({
        'pydle_file_beta': 'b',
        'pydle_file_alpha': 'a',
        'other_key': 'nope',
        'pydle_file_': 'no name',
    });

    assert.deepEqual(listLegacyProjects(storage), ['alpha', 'beta']);
    assert.deepEqual(listLegacyProjects(storage, 'other_'), ['key']);
});

test('readLegacyProject returns the text, or null when absent', () => {
    const storage = fakeStorage({ 'pydle_file_note': 'print(1)' });

    assert.equal(readLegacyProject(storage, 'note'), 'print(1)');
    assert.equal(readLegacyProject(storage, 'missing'), null);
    assert.equal(readLegacyProject(storage, 'note', 'other_'), null);
});

test('imports several projects and removes each key after the write', async () => {
    const storage = fakeStorage({
        'pydle_file_alpha': 'print("a")',
        'pydle_file_beta': 'print("b")',
        'score': 'not ours',
    });
    const { writeFile, writes } = fakeWriter();

    const result = await importLegacyProjects({
        storage,
        writeFile,
        listProjects: async () => [],
    });

    assert.deepEqual(result, { imported: ['alpha', 'beta'], skipped: [], failed: [] });
    assert.deepEqual(writes, [
        { name: 'alpha', path: 'main.py', content: 'print("a")' },
        { name: 'beta', path: 'main.py', content: 'print("b")' },
    ]);
    assert.equal(storage.has('pydle_file_alpha'), false);
    assert.equal(storage.has('pydle_file_beta'), false);
    assert.equal(storage.getItem('score'), 'not ours');
});

test('a project already in the vault is skipped, never overwritten', async () => {
    const storage = fakeStorage({ 'pydle_file_alpha': 'legacy text' });
    const { writeFile, writes } = fakeWriter();

    const result = await importLegacyProjects({
        storage,
        writeFile,
        // The shape sync.listProjects actually returns.
        listProjects: async () => [{ name: 'alpha', updatedAt: 1 }],
    });

    assert.deepEqual(result, { imported: [], skipped: ['alpha'], failed: [] });
    assert.deepEqual(writes, []);
    // Skipping leaves the key: no write resolved, so nothing is redundant yet.
    assert.equal(storage.getItem('pydle_file_alpha'), 'legacy text');
});

test('names are imported under their vault slug', async () => {
    const storage = fakeStorage({ 'pydle_file_My Project': 'print(1)' });
    const { writeFile, writes } = fakeWriter();

    const result = await importLegacyProjects({
        storage,
        writeFile,
        listProjects: async () => [],
    });

    assert.deepEqual(result.imported, ['my_project']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].name, 'my_project');
    assert.equal(storage.has('pydle_file_My Project'), false);
});

test('two legacy names for one slug cannot overwrite the first import', async () => {
    const storage = fakeStorage({
        'pydle_file_My Project': 'first',
        'pydle_file_my-project': 'second',
    });
    const { writeFile, writes } = fakeWriter();

    const result = await importLegacyProjects({
        storage,
        writeFile,
        listProjects: async () => [],
    });

    // Sorted: "My Project" before "my-project", and both normalise to the same
    // snake_case name.
    assert.deepEqual(result.imported, ['my_project']);
    assert.deepEqual(result.skipped, ['my_project']);
    assert.deepEqual(writes, [{ name: 'my_project', path: 'main.py', content: 'first' }]);
});

test('a failed write keeps the key and is reported, without stopping the rest', async () => {
    const storage = fakeStorage({
        'pydle_file_alpha': 'print(1)',
        'pydle_file_broken': 'print(2)',
    });
    const { writeFile, writes } = fakeWriter(new Set(['broken']));

    const result = await importLegacyProjects({
        storage,
        writeFile,
        listProjects: async () => [],
    });

    assert.deepEqual(result.imported, ['alpha']);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, 'broken');
    assert.match(result.failed[0].reason, /write failed/);
    assert.match(result.failed[0].reason, /disk says no/);

    // The only copy of that text is still the legacy key.
    assert.equal(storage.getItem('pydle_file_broken'), 'print(2)');
    assert.equal(storage.has('pydle_file_alpha'), false);
    assert.deepEqual(writes, [{ name: 'alpha', path: 'main.py', content: 'print(1)' }]);
});

test('running twice imports nothing the second time', async () => {
    const storage = fakeStorage({
        'pydle_file_alpha': 'print(1)',
        'pydle_file_beta': 'print(2)',
    });
    const { writeFile, writes } = fakeWriter();
    const lister = listerFor(writes);

    const first = await importLegacyProjects({ storage, writeFile, listProjects: lister });
    const second = await importLegacyProjects({ storage, writeFile, listProjects: lister });

    assert.deepEqual(first.imported, ['alpha', 'beta']);
    assert.deepEqual(first.failed, []);
    assert.deepEqual(second.imported, []);
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.skipped, []);
    assert.equal(writes.length, 2);

    // A leftover key from a skipped project also stays skipped.
    const again = await importLegacyProjects({
        storage: fakeStorage({ 'pydle_file_alpha': 'print(1)' }),
        writeFile,
        listProjects: lister,
    });
    assert.deepEqual(again, { imported: [], skipped: ['alpha'], failed: [] });
});

test('an empty value is reported, not written, and the key is kept', async () => {
    const storage = fakeStorage({
        'pydle_file_blank': '',
        'pydle_file_spaces': '   \n\t',
    });
    const { writeFile, writes } = fakeWriter();

    const result = await importLegacyProjects({
        storage,
        writeFile,
        listProjects: async () => [],
    });

    assert.deepEqual(result.imported, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(
        result.failed.map((entry) => entry.name),
        ['blank', 'spaces'],
    );
    for (const entry of result.failed) {
        assert.equal(entry.reason, 'empty value');
    }
    assert.equal(storage.has('pydle_file_blank'), true);
});

test('an unusable name is reported and its key is left alone', async () => {
    const storage = fakeStorage({
        'pydle_file_!!!': 'print(1)',
        'pydle_file_ok': 'print(2)',
    });
    const { writeFile, writes } = fakeWriter();

    const result = await importLegacyProjects({
        storage,
        writeFile,
        listProjects: async () => [],
    });

    assert.deepEqual(result.imported, ['ok']);
    assert.deepEqual(result.failed, [{ name: '!!!', reason: 'unusable name' }]);
    assert.equal(storage.has('pydle_file_!!!'), true);
    assert.deepEqual(writes.map((write) => write.name), ['ok']);
});

test('a vault listing failure imports nothing rather than guessing', async () => {
    const storage = fakeStorage({ 'pydle_file_alpha': 'print(1)' });
    const { writeFile, writes } = fakeWriter();

    const result = await importLegacyProjects({
        storage,
        writeFile,
        listProjects: async () => {
            throw new Error('vault offline');
        },
    });

    assert.deepEqual(result.imported, []);
    assert.deepEqual(writes, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, 'alpha');
    assert.match(result.failed[0].reason, /vault listing failed/);
    assert.equal(storage.has('pydle_file_alpha'), true);
});

test('a missing storage or an empty mirror is a no-op, not an error', async () => {
    const empty = { imported: [], skipped: [], failed: [] };
    const { writeFile } = fakeWriter();

    assert.deepEqual(await importLegacyProjects({ storage: null, writeFile }), empty);
    assert.deepEqual(await importLegacyProjects({}), empty);
    assert.deepEqual(
        await importLegacyProjects({
            storage: fakeStorage({ 'unrelated': 'x' }),
            writeFile,
            listProjects: async () => [],
        }),
        empty,
    );
});

test('noteLegacyMismatch reports disagreement and nothing else', () => {
    const storage = fakeStorage({
        'pydle_file_alpha': 'legacy',
        'pydle_file_gone': 'orphan',
        'pydle_file_empty': '',
    });

    assert.equal(noteLegacyMismatch(storage, 'alpha', 'vault'), true);
    assert.equal(noteLegacyMismatch(storage, 'alpha', 'legacy'), false);

    // No legacy key: nothing can be out of date.
    assert.equal(noteLegacyMismatch(storage, 'missing', 'whatever'), false);

    // Legacy text with no vault counterpart is a mismatch.
    assert.equal(noteLegacyMismatch(storage, 'gone', null), true);
    assert.equal(noteLegacyMismatch(storage, 'gone', undefined), true);

    // An empty legacy value matching an empty vault value is agreement.
    assert.equal(noteLegacyMismatch(storage, 'empty', ''), false);
});

test('the exported prefix is the one the old mirror used', () => {
    assert.equal(LEGACY_PREFIX, 'pydle_file_');
});
