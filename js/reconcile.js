/**
 * Three-way reconciliation for one project, given only content hashes.
 *
 * Three states per file, none of which needs a diff:
 *
 *   base    what was committed when this device last synced
 *   local   what is in the vault now
 *   remote  what the repository has now
 *
 * Hashes are enough to decide, which matters because this runs before a commit and
 * must not download the repository to find out whether it needs to.
 *
 * Pure on purpose: no network, no storage, no DOM. The rule that a stale commit
 * must never silently overwrite someone else's work lives here, so it can be tested
 * exhaustively.
 */

/**
 * @typedef {{ [path: string]: string | null }} FileHashes
 *   Path relative to the project, mapped to a content hash, or null when the file
 *   is absent on that side.
 */

/**
 * @typedef {{ path: string, remoteHash: string | null, kind: string }} Conflict
 */

/**
 * Work out what to do with each file.
 *
 * The precedence is deliberate:
 *
 * 1. Both sides already agree: nothing to do. This covers the common case of two
 *    devices having committed identical content, and the case where a file is
 *    absent from both.
 * 2. Only the remote moved: take it. The local copy is untouched, so there is
 *    nothing to lose.
 * 3. Only the local moved: keep it. It will go into the next commit.
 * 4. Both moved, differently: a real conflict. Never guessed at.
 *
 * @param {FileHashes} base
 * @param {FileHashes} local
 * @param {FileHashes} remote
 * @returns {{
 *   apply: Array<{ path: string, remoteHash: string | null, kind: 'updated' | 'deleted' }>,
 *   keep: string[],
 *   conflicts: Conflict[],
 *   converged: string[]
 * }}
 */
export function planMerge(base, local, remote) {
    const paths = new Set([
        ...Object.keys(base || {}),
        ...Object.keys(local || {}),
        ...Object.keys(remote || {}),
    ]);

    const apply = [];
    const keep = [];
    const conflicts = [];
    const converged = [];

    for (const path of [...paths].sort()) {
        const b = valueAt(base, path);
        const l = valueAt(local, path);
        const r = valueAt(remote, path);

        if (l === r) {
            converged.push(path);
            continue;
        }

        if (l === b) {
            // Local is untouched, so following the remote cannot lose local work.
            apply.push({
                path,
                remoteHash: r,
                kind: r === null ? 'deleted' : 'updated',
            });
            continue;
        }

        if (r === b) {
            // Remote is untouched: this device is the only one that changed it.
            keep.push(path);
            continue;
        }

        conflicts.push({ path, remoteHash: r, kind: conflictKind(b, l, r) });
    }

    return { apply, keep, conflicts, converged };
}

/**
 * Describe a conflict in terms a person can act on, rather than "both modified".
 *
 * @param {string | null} base
 * @param {string | null} local
 * @param {string | null} remote
 * @returns {'both-changed' | 'deleted-here' | 'deleted-elsewhere'}
 */
function conflictKind(base, local, remote) {
    if (local === null && base !== null && remote !== null) {
        return 'deleted-here';
    }
    if (remote === null && base !== null && local !== null) {
        return 'deleted-elsewhere';
    }
    return 'both-changed';
}

/**
 * Read a path from a hash map, treating absence as null.
 *
 * @param {FileHashes} hashes
 * @param {string} path
 * @returns {string | null}
 */
function valueAt(hashes, path) {
    if (!hashes || !Object.prototype.hasOwnProperty.call(hashes, path)) {
        return null;
    }
    const value = hashes[path];
    return typeof value === 'string' ? value : null;
}

/**
 * Apply a resolution choice to a plan, for the conflict dialog.
 *
 * Choosing `remote` means "take theirs"; choosing `local` means "keep mine". Either
 * way the result is an ordinary file state that the next commit records. Nothing
 * here rewrites history.
 *
 * @param {ReturnType<typeof planMerge>} plan
 * @param {{ [path: string]: 'local' | 'remote' }} choices
 * @returns {{ apply: typeof plan.apply, unresolved: Conflict[] }}
 */
export function resolveConflicts(plan, choices) {
    const apply = [...plan.apply];
    const unresolved = [];

    for (const conflict of plan.conflicts) {
        const choice = choices && choices[conflict.path];
        if (choice === 'remote') {
            apply.push({
                path: conflict.path,
                remoteHash: conflict.remoteHash,
                kind: conflict.remoteHash === null ? 'deleted' : 'updated',
            });
        } else if (choice !== 'local') {
            unresolved.push(conflict);
        }
    }

    return { apply, unresolved };
}
