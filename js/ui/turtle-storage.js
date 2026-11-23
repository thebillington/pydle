/**
 * Drawings in the vault.
 *
 * A drawing is a project in the `drawings` namespace holding one file,
 * `main.py`. This module is the turtle page's whole storage surface: the page
 * never touches `js/vault/` or `localStorage` for drawings, and every call
 * through here goes to the vault, so a save is available offline and to the
 * commit dialog.
 *
 * The other job is the one-time move from the old `pydle_turtle_file_*`
 * localStorage keys. That is deliberately conservative:
 *
 * - it runs once, guarded by a flag, so a failure is not retried on every load;
 * - a key is removed only after its drawing is definitely in the vault;
 * - a vault drawing that already exists with different code is left alone and
 *   the local key is kept, because neither copy is provably the newer one.
 *
 * Nothing here commits. Reaching GitHub stays a manual action in the commit
 * dialog.
 */

import { projectSlug } from './files.js';

/** The old per-drawing localStorage prefix. */
const LEGACY_PREFIX = 'pydle_turtle_file_';

/** Set once the migration has run, however it went. */
const MIGRATION_FLAG = 'pydle_turtle_migrated_v1';

/** Every drawing holds exactly this one file. */
export const MAIN_FILE = 'main.py';

/**
 * Read one drawing's code, or null when there is nothing to open.
 *
 * @param {object} sync The `Sync` object from `js/sync.js`.
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function readDrawing(sync, name) {
    let files;
    try {
        files = await sync.readProject(name, 'drawings');
    } catch {
        return null;
    }
    if (!files || typeof files !== 'object') {
        return null;
    }
    const code = files[MAIN_FILE];
    return typeof code === 'string' ? code : null;
}

/**
 * Wrap the sync service with the drawing-shaped calls the page needs.
 *
 * @param {object} sync The `Sync` object from `js/sync.js`.
 */
export function createDrawings(sync) {
    /**
     * Drawings on this device, newest first.
     *
     * @returns {Promise<Array<{ name: string, updatedAt: number }>>}
     */
    async function list() {
        try {
            const projects = await sync.listProjects('drawings');
            if (!Array.isArray(projects)) {
                return [];
            }
            return projects
                .filter((project) => project && typeof project.name === 'string')
                .map((project) => ({
                    name: project.name,
                    updatedAt: Number.isFinite(project.updatedAt) ? project.updatedAt : 0,
                }));
        } catch {
            return [];
        }
    }

    /**
     * @param {string} name
     * @returns {Promise<string | null>}
     */
    async function read(name) {
        if (typeof name !== 'string' || name === '') {
            return null;
        }
        return readDrawing(sync, name);
    }

    /**
     * Write the open buffer to the vault. Local only: no network.
     *
     * @param {string} name
     * @param {string} code
     * @returns {Promise<void>}
     */
    async function save(name, code) {
        await sync.writeFiles(name, MAIN_FILE, code, { kind: 'drawings' });
    }

    /**
     * Remove a drawing locally, and from GitHub when it was committed.
     *
     * @param {string} name
     * @returns {Promise<void>}
     */
    async function remove(name) {
        await sync.deleteProject(name, 'drawings');
    }

    /**
     * What in this drawing differs from its last commit.
     *
     * @param {string} name
     * @returns {Promise<{ paths: Array<{ path: string, status: string }>, count: number }>}
     */
    async function dirty(name) {
        if (typeof name !== 'string' || name === '') {
            return { paths: [], count: 0 };
        }
        try {
            const report = await sync.dirty(name, 'drawings');
            return report && Number.isFinite(report.count)
                ? report
                : { paths: [], count: 0 };
        } catch {
            return { paths: [], count: 0 };
        }
    }

    /**
     * @param {string} name
     * @returns {Promise<boolean>}
     */
    async function hasUncommitted(name) {
        return (await dirty(name)).count > 0;
    }

    /**
     * Copy the old localStorage drawings into the vault, once.
     *
     * @returns {Promise<{ migrated: number, kept: number }>}
     */
    async function migrate() {
        const report = { migrated: 0, kept: 0 };

        let keys = [];
        try {
            if (localStorage.getItem(MIGRATION_FLAG) === 'done') {
                return report;
            }
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (typeof key === 'string' && key.startsWith(LEGACY_PREFIX)) {
                    keys.push(key);
                }
            }
        } catch {
            // Storage is blocked: there is nothing to migrate and nowhere to
            // record that, so leave the claim untouched rather than guess.
            return report;
        }

        for (const key of keys) {
            let code = null;
            try {
                code = localStorage.getItem(key);
            } catch {
                code = null;
            }

            const rawName = key.slice(LEGACY_PREFIX.length);
            const slug = projectSlug(rawName);

            if (typeof code !== 'string' || slug === null) {
                report.kept += 1;
                continue;
            }

            const existing = await readDrawing(sync, slug);
            if (typeof existing === 'string') {
                // Already migrated on an earlier visit: the local copy is a
                // duplicate only when the two agree.
                if (existing === code) {
                    forgetKey(key);
                    report.migrated += 1;
                } else {
                    report.kept += 1;
                }
                continue;
            }

            try {
                await save(slug, code);
            } catch {
                // The local drawing is untouched: a failed write must never
                // cost the student their code.
                report.kept += 1;
                continue;
            }

            forgetKey(key);
            report.migrated += 1;
        }

        try {
            localStorage.setItem(MIGRATION_FLAG, 'done');
        } catch {
            // Without the flag the pass runs again next load, which is safe:
            // identical copies are recognised and removed without a write.
        }

        return report;
    }

    return { list, read, save, remove, dirty, hasUncommitted, migrate };
}

/**
 * The question asked before throwing a drawing's local changes away.
 *
 * Kept out of the page so the wording can be tested: it is destructive, so it
 * has to say what goes, what stays, and why there is no way back. A file that
 * changed on both sides is never discarded (GitHub's copy and this device's copy
 * are both somebody's work), so it is named as left alone rather than listed.
 *
 * @param {{ name?: string, paths?: string[], conflicts?: string[] }} input
 * @returns {{ title: string, message: string }}
 */
export function discardConfirmation({ name = '', paths = [], conflicts = [] } = {}) {
    const discardable = Array.isArray(paths)
        ? paths.filter((path) => typeof path === 'string' && path !== '')
        : [];
    const blocked = Array.isArray(conflicts)
        ? conflicts.filter((path) => typeof path === 'string' && path !== '')
        : [];

    const count = discardable.length;
    const listed =
        discardable.slice(0, 6).join(', ') + (discardable.length > 6 ? ', and more' : '');
    const drawing = typeof name === 'string' && name !== '' ? name : 'this drawing';

    const leftAlone =
        blocked.length === 0
            ? ''
            : '\n\n' +
              blocked.length +
              (blocked.length === 1 ? ' file was' : ' files were') +
              ' also changed in GitHub, and ' +
              (blocked.length === 1 ? 'is' : 'are') +
              ' left alone.';

    return {
        title: 'Discard ' + count + (count === 1 ? ' change' : ' changes') + '?',
        message:
            (count === 1
                ? 'The change to \u201c' + drawing + '\u201d goes back to'
                : 'The changes to \u201c' + drawing + '\u201d go back to') +
            ' the version in GitHub: ' +
            listed +
            '. This cannot be undone, because the work is not in any commit yet.' +
            leftAlone,
    };
}

/**
 * Remove one migrated key, leaving it in place if storage refuses.
 *
 * @param {string} key
 */
function forgetKey(key) {
    try {
        localStorage.removeItem(key);
    } catch {
        // A key that cannot be removed is harmless: the flag stops the pass.
    }
}
