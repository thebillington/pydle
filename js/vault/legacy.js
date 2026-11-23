/**
 * One-time import of the pre-vault storage into the vault.
 *
 * Before the vault existed, every saved program lived in `localStorage` under
 * one flat key per project: `pydle_file_<name>` held the text that is now
 * `<project>/main.py`. The vault keeps a real tree, and it is authoritative:
 * the mirror is a second source of truth that can disagree, which is how a
 * project called `names.py` came to look like it contained `main.py`.
 *
 * The rules here are deliberately conservative:
 *
 * - A project already in the vault is skipped, never overwritten.
 * - A legacy key is removed only after the vault write has resolved.
 * - Nothing throws. A failed import must not stop the app from starting.
 *
 * This module is pure with respect to the world it is given: no console calls,
 * no globals beyond the `storage` argument. The caller logs the results.
 */

import { normalizeProjectName } from './paths.js';

/** Key prefix used by the legacy mirror. */
export const LEGACY_PREFIX = 'pydle_file_';

/** The single file a legacy project becomes. */
const ENTRY_FILE = 'main.py';

/**
 * Read one value from storage without letting an exception escape.
 *
 * @param {Storage} storage
 * @param {string} key
 * @returns {string | null}
 */
function rawGet(storage, key) {
    try {
        const value = storage.getItem(key);
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

/**
 * Every key currently in storage, tolerating a hostile implementation.
 *
 * @param {Storage} storage
 * @returns {string[]}
 */
function storageKeys(storage) {
    const keys = [];
    let length = 0;
    try {
        length = Number(storage.length);
    } catch {
        return keys;
    }
    if (!Number.isFinite(length) || length <= 0) {
        return keys;
    }

    for (let index = 0; index < length; index += 1) {
        try {
            const key = storage.key(index);
            if (typeof key === 'string') {
                keys.push(key);
            }
        } catch {
            // One unreadable slot does not make the rest unreadable.
        }
    }

    return keys;
}

/**
 * Whether a value looks like storage at all.
 *
 * @param {unknown} storage
 * @returns {boolean}
 */
function usableStorage(storage) {
    return (
        storage !== null &&
        typeof storage === 'object' &&
        typeof storage.getItem === 'function'
    );
}

/**
 * Project names found under the legacy prefix, oldest key order.
 *
 * Names are returned raw: normalising one to a vault slug is the caller's
 * decision, and an unusable name is still a key worth reporting. A key whose
 * suffix is empty (`pydle_file_`) carries no name and is ignored.
 *
 * @param {Storage} storage
 * @param {string} [prefix]
 * @returns {string[]} Names, without the prefix.
 */
export function listLegacyProjects(storage, prefix = LEGACY_PREFIX) {
    if (!usableStorage(storage) || typeof prefix !== 'string') {
        return [];
    }

    const names = new Set();
    for (const key of storageKeys(storage)) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        const name = key.slice(prefix.length);
        if (name !== '') {
            names.add(name);
        }
    }

    // Deterministic, so a report reads the same way twice.
    return [...names].sort();
}

/**
 * The text stored for one legacy project.
 *
 * @param {Storage} storage
 * @param {string} name Project name as it appears after the prefix.
 * @param {string} [prefix]
 * @returns {string | null} The stored text, or null when there is none.
 */
export function readLegacyProject(storage, name, prefix = LEGACY_PREFIX) {
    if (!usableStorage(storage) || typeof name !== 'string') {
        return null;
    }
    return rawGet(storage, prefix + name);
}

/**
 * Turn whatever `listProjects()` returned into a set of vault project slugs.
 *
 * `sync.listProjects` answers `[{ name, updatedAt }]`; a plain array of names is
 * accepted too so the importer is easy to drive from tests and other callers.
 *
 * @param {unknown} listing
 * @returns {Set<string>}
 */
function vaultProjectSet(listing) {
    const projects = new Set();
    if (!Array.isArray(listing)) {
        return projects;
    }

    for (const entry of listing) {
        let name;
        if (typeof entry === 'string') {
            name = entry;
        } else if (entry !== null && typeof entry === 'object' && typeof entry.name === 'string') {
            name = entry.name;
        } else {
            continue;
        }

        try {
            projects.add(normalizeProjectName(name));
        } catch {
            // A name the vault listed but we cannot normalise is still not a
            // name we would write over.
            projects.add(name);
        }
    }

    return projects;
}

/**
 * Remove one legacy key, ignoring a storage that refuses.
 *
 * @param {Storage} storage
 * @param {string} key
 * @returns {void}
 */
function removeKey(storage, key) {
    try {
        if (typeof storage.removeItem !== 'function') {
            return;
        }
        storage.removeItem(key);
    } catch {
        // The vault now holds the text; a key left behind is only tidying debt.
        // The next run skips the project rather than importing it again.
    }
}

/**
 * Import every legacy project into the vault, once.
 *
 * For each name under the prefix:
 *
 * - an unusable name is reported in `failed` and its key is left alone;
 * - an empty value is reported in `failed` and its key is left alone;
 * - a project the vault already holds is reported in `skipped` and its key is
 *   left alone, because the vault is authoritative and the key is the thing
 *   `noteLegacyMismatch` exists to describe;
 * - otherwise `main.py` is written with the legacy text, and the key is removed
 *   **after** that write has resolved. If the write rejects, the key stays and
 *   the project is reported in `failed`.
 *
 * A project imported earlier in the same run counts as existing, so two legacy
 * keys that normalise to the same slug cannot overwrite each other.
 *
 * Never rejects, whatever storage, vault or callbacks are handed to it.
 *
 * @param {object} options
 * @param {Storage} options.storage localStorage, or anything shaped like it.
 * @param {(name: string, path: string, content: string) => Promise<unknown>} options.writeFile
 *        Vault writer, normally `sync.writeFiles`.
 * @param {() => Promise<Array<{ name: string, updatedAt: number }> | string[]>} options.listProjects
 *        Vault lister, normally `sync.listProjects`.
 * @param {string} [options.legacyPrefix]
 * @returns {Promise<{ imported: string[], skipped: string[], failed: Array<{ name: string, reason: string }> }>}
 */
export async function importLegacyProjects({
    storage,
    writeFile: writeVaultFile,
    listProjects: listVaultProjects,
    legacyPrefix = LEGACY_PREFIX,
} = {}) {
    /** @type {{ imported: string[], skipped: string[], failed: Array<{ name: string, reason: string }> }} */
    const result = { imported: [], skipped: [], failed: [] };

    const names = listLegacyProjects(storage, legacyPrefix);
    if (names.length === 0) {
        return result;
    }

    let existing;
    try {
        if (typeof listVaultProjects !== 'function') {
            throw new TypeError('no vault project lister');
        }
        existing = vaultProjectSet(await listVaultProjects());
    } catch (error) {
        // Without knowing what the vault holds we cannot promise not to
        // overwrite it, so import nothing and say why.
        const reason = `vault listing failed: ${errorMessage(error)}`;
        for (const name of names) {
            result.failed.push({ name, reason });
        }
        return result;
    }

    for (const name of names) {
        let slug;
        try {
            slug = normalizeProjectName(name.trim());
        } catch {
            result.failed.push({ name, reason: 'unusable name' });
            continue;
        }

        const text = readLegacyProject(storage, name, legacyPrefix);
        if (text === null || text.trim() === '') {
            result.failed.push({ name, reason: 'empty value' });
            continue;
        }

        if (existing.has(slug)) {
            result.skipped.push(slug);
            continue;
        }

        try {
            await writeVaultFile(slug, ENTRY_FILE, text);
        } catch (error) {
            // The key stays: the text is still only in legacy storage.
            result.failed.push({ name, reason: `write failed: ${errorMessage(error)}` });
            continue;
        }

        // The vault write resolved, so the legacy copy is now redundant.
        existing.add(slug);
        removeKey(storage, legacyPrefix + name);
        result.imported.push(slug);
    }

    return result;
}

/**
 * Whether a legacy key still disagrees with the vault copy.
 *
 * Diagnostics only: the caller decides what to log. Answers `false` when there
 * is no legacy key, since a missing mirror cannot be out of date.
 *
 * @param {Storage} storage
 * @param {string} name Project name as it appears after the prefix.
 * @param {string | null | undefined} vaultText What the vault holds now.
 * @param {string} [prefix]
 * @returns {boolean}
 */
export function noteLegacyMismatch(storage, name, vaultText, prefix = LEGACY_PREFIX) {
    const legacy = readLegacyProject(storage, name, prefix);
    if (legacy === null) {
        return false;
    }

    // A legacy copy with no vault counterpart is the loudest mismatch there is.
    if (typeof vaultText !== 'string') {
        return true;
    }

    return legacy !== vaultText;
}

/**
 * Describe an error without trusting it to be an Error.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
    if (error instanceof Error && typeof error.message === 'string') {
        return error.message;
    }
    try {
        return String(error);
    } catch {
        return 'unknown error';
    }
}
