import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

/**
 * Catch a cross-module call that was never imported.
 *
 * `js/sync.js` called `getRef()` without importing it. It parsed, the module
 * loaded, and every unit test passed, because nothing executed that path. In a
 * browser it threw `ReferenceError: getRef is not defined` inside `pull()`, which
 * the app then reported as a network problem.
 *
 * The rule is deliberately narrow, so there are no false positives: for every bare
 * function call, if that name is exported by some other module in `js/` and is not
 * imported or declared here, the file is wrong. Prose in comments, object-literal
 * method names and third-party globals are all left alone.
 */

const GLOBALS = new Set([
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON',
    'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map',
    'Set', 'WeakMap', 'Proxy', 'Reflect', 'Intl', 'Uint8Array', 'TextEncoder', 'TextDecoder',
    'URL', 'URLSearchParams', 'Blob', 'Response', 'Request', 'Headers', 'AbortController',
    'AbortSignal', 'Event', 'CustomEvent', 'KeyboardEvent', 'DOMException', 'HTMLElement',
    'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLAnchorElement',
    'HTMLDetailsElement', 'Node', 'ResizeObserver', 'IntersectionObserver',
    'queueMicrotask', 'requestAnimationFrame', 'structuredClone', 'fetch', 'crypto',
    'btoa', 'atob', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
    'decodeURIComponent', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'console', 'navigator', 'window', 'document', 'localStorage', 'indexedDB',
    'IDBKeyRange', 'location', 'performance', 'self', 'globalThis', 'importScripts',
    'postMessage', 'addEventListener', 'getComputedStyle', 'matchMedia', 'Worker',
]);

async function listModules(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listModules(full)));
        } else if (entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files.sort();
}

/** Remove block and line comments so prose cannot look like code. */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** @returns {Set<string>} */
function exportedNames(source) {
    const names = new Set();
    for (const match of source.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
    }
    for (const match of source.matchAll(/export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
    }
    return names;
}

/** @returns {Set<string>} */
function importedNames(source) {
    const names = new Set();
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const part of match[1].split(',')) {
            const pieces = part.trim().split(/\s+as\s+/);
            const name = (pieces[1] || pieces[0] || '').trim();
            if (name) names.add(name);
        }
    }
    for (const match of source.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
    }
    for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) {
        names.add(match[1]);
    }
    return names;
}

/** @returns {Set<string>} */
function declaredNames(source) {
    const names = new Set();
    for (const match of source.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        names.add(match[1]);
    }
    for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
        names.add(match[1]);
    }
    for (const match of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
    }
    return names;
}

const modules = await listModules('js');

/** Every name exported anywhere in js/. */
const exported = new Map();
for (const file of modules) {
    const source = stripComments(await readFile(file, 'utf8'));
    for (const name of exportedNames(source)) {
        exported.set(name, file);
    }
}

test('found the modules', () => {
    assert.ok(modules.length > 5, `only found ${modules.length} modules`);
    assert.ok(exported.size > 5, `only found ${exported.size} exports`);
});

for (const file of modules) {
    test(`${file} imports what it calls`, async () => {
        const source = stripComments(await readFile(file, 'utf8'));
        const known = new Set([...importedNames(source), ...declaredNames(source)]);

        const missing = new Set();
        for (const match of source.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
            const name = match[1];
            if (known.has(name) || GLOBALS.has(name)) {
                continue;
            }
            // Only complain when another module in this project defines it: that
            // means it is meant to be a real reference, not a method shorthand.
            const owner = exported.get(name);
            if (owner && owner !== file) {
                missing.add(name);
            }
        }

        assert.deepEqual(
            [...missing].sort(),
            [],
            `${file} calls ${[...missing].join(', ')} without importing it`,
        );
    });
}

test('no module calls its own exports without defining them', async () => {
    // A sanity check on the export map itself: each exported name must be declared
    // in the file the map says owns it.
    for (const [name, file] of exported) {
        const source = stripComments(await readFile(file, 'utf8'));
        assert.ok(
            declaredNames(source).has(name) || source.includes(`function ${name}`),
            `${name} is exported from ${basename(file)} but not defined there`,
        );
    }
});
