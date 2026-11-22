import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Guards against deleting a helper while editing.
 *
 * An edit once removed `walkFiles`, `pruneEmptyDirs`, `removeTree`, `idbReadFile`
 * and `idbReadProject` from `js/vault/fs.js`. The file still parsed, and every
 * unit test still passed, because those are browser paths that tests never reach.
 * It would have failed on the first save in a real browser.
 *
 * So: every internal helper in these modules must have a definition. Cheap, and
 * it fails loudly at the point the mistake is made.
 */

const MODULES = {
    'js/vault/fs.js': [
        'db', 'ask', 'run', 'idbGet', 'idbPut', 'idbDelete', 'prefixRange',
        'idbEntries', 'idbDeletePrefix', 'touchProject', 'projectUpdatedAt',
        'requireProject', 'requirePath', 'isMissing', 'hasOpfs', 'vaultRoot',
        'kindRoot', 'projectDir', 'walkFiles', 'pruneEmptyDirs', 'removeTree',
        'idbReadFile', 'idbReadProject', 'kindDir', 'keyPrefix',
    ],
    'js/sync.js': [
        'asSyncError', 'decodeBase64', 'identityFor', 'contentHashGuard',
    ],
    'js/ui/dialog.js': [
        'el', 'enqueue', 'createShell',
    ],
    'js/reconcile.js': [
        'conflictKind', 'valueAt',
    ],
};

/**
 * @param {string} source
 * @param {string} name
 * @returns {boolean}
 */
function isDefined(source, name) {
    const patterns = [
        new RegExp(`function\\s*\\*?\\s*${name}\\s*\\(`),
        new RegExp(`const\\s+${name}\\s*=`),
        new RegExp(`let\\s+${name}\\s*=`),
    ];
    return patterns.some((pattern) => pattern.test(source));
}

for (const [file, helpers] of Object.entries(MODULES)) {
    test(`${file} defines its internal helpers`, async () => {
        const source = await readFile(file, 'utf8');
        const missing = helpers.filter((name) => name !== 'contentHashGuard' && !isDefined(source, name));
        assert.deepEqual(missing, [], `${file} is missing: ${missing.join(', ')}`);
    });
}

test('no module calls a helper that does not exist in it', async () => {
    // A narrower version of the above: catch a call to a name that other modules
    // define but this one does not, which is how a cross-file deletion shows up.
    const source = await readFile('js/vault/fs.js', 'utf8');
    // A leading dot means a method call on a handle (dir.removeEntry), not a local
    // helper, so exclude those.
    const called = new Set(
        [...source.matchAll(/(?<![.\w])(walkFiles|pruneEmptyDirs|removeTree|idb[A-Z]\w*)\s*\(/g)]
            .map((match) => match[1]),
    );
    for (const name of called) {
        assert.ok(isDefined(source, name), `js/vault/fs.js calls ${name}() but never defines it`);
    }
});
