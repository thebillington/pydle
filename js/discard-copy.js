/*
 * What to say before local changes are thrown away.
 *
 * "Goes back to the version in GitHub" is only true when GitHub has a version.
 * A file that was never committed is *deleted*, and telling someone it will be
 * restored is the wrong thing to say immediately before an action that cannot be
 * undone.
 *
 * Both the REPL and the turtle editor discard through this, so the wording
 * cannot drift between them, and the rule is testable without a browser.
 */

/**
 * @typedef {{ path: string, status?: string }} DiscardEntry
 */

/**
 * @param {string | DiscardEntry} entry
 * @returns {DiscardEntry | null}
 */
function normalise(entry) {
    if (typeof entry === 'string') {
        return entry === '' ? null : { path: entry, status: '' };
    }
    if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path !== '') {
        return { path: entry.path, status: typeof entry.status === 'string' ? entry.status : '' };
    }
    return null;
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function plural(count, one, many) {
    return count === 1 ? one : many;
}

/**
 * The confirmation shown before discarding.
 *
 * @param {{
 *   paths?: Array<string | DiscardEntry>,
 *   conflicts?: Array<string | DiscardEntry>,
 *   subject?: string,
 * }} [input]
 * @returns {{ title: string, message: string, paths: string[], removed: string[], restored: string[] }}
 */
export function discardCopy({ paths = [], conflicts = [], subject = '' } = {}) {
    const blocked = new Set(
        (Array.isArray(conflicts) ? conflicts : [])
            .map(normalise)
            .filter(Boolean)
            .map((entry) => entry.path),
    );

    const entries = (Array.isArray(paths) ? paths : [])
        .map(normalise)
        .filter(Boolean)
        .filter((entry) => !blocked.has(entry.path));

    const removed = entries.filter((entry) => entry.status === 'added').map((entry) => entry.path);
    const restored = entries.filter((entry) => entry.status !== 'added').map((entry) => entry.path);

    const all = entries.map((entry) => entry.path);
    const listed = all.slice(0, 6).join(', ') + (all.length > 6 ? ', and more' : '');
    const name = typeof subject === 'string' && subject !== '' ? subject : '';

    let what;
    if (removed.length === 0) {
        what =
            plural(restored.length, '1 file goes back to', restored.length + ' files go back to') +
            ' the version in GitHub: ' +
            listed;
    } else if (restored.length === 0) {
        what =
            plural(removed.length, '1 file is', removed.length + ' files are') +
            ' not in GitHub, so ' +
            plural(removed.length, 'it will be removed', 'they will be removed') +
            ': ' +
            listed;
    } else {
        what =
            plural(restored.length, '1 file goes back to', restored.length + ' files go back to') +
            ' the version in GitHub and ' +
            nowRemoved(removed.length) +
            ': ' +
            listed;
    }

    const tail = ' This cannot be undone, because the work is not in any commit yet.';
    const leftAlone =
        blocked.size === 0
            ? ''
            : '\n\n' +
              plural(blocked.size, '1 file was', blocked.size + ' files were') +
              ' also changed in GitHub, and ' +
              plural(blocked.size, 'is', 'are') +
              ' left alone.';

    return {
        // The subject belongs in the title: naming it there reads naturally,
        // while prefixing the sentence produces "The change to "spiral" 1 file...".
        title:
            'Discard ' +
            plural(all.length, '1 change', all.length + ' changes') +
            (name ? ' in \u201c' + name + '\u201d' : '') +
            '?',
        message: what.replace(/^./, (c) => c.toUpperCase()) + '.' + tail + leftAlone,
        paths: all,
        removed,
        restored,
    };
}

/**
 * "1 file is not in GitHub, so it will be removed".
 *
 * @param {number} count
 * @returns {string}
 */
function nowRemoved(count) {
    return plural(count, '1 file is', count + ' files are') +
        ' not in GitHub, so ' +
        plural(count, 'it will be removed', 'they will be removed');
}
