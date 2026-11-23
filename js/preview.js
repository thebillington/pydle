/*
 * What the repository held when this device last looked, and whether that is
 * still current.
 *
 * The commit window needs the previous version of each changed file so it can
 * show a diff, and the count on the save button needs to know what is
 * uncommitted. Asking GitHub for those on every save is what produced one blob
 * read per changed file, and then a rate limit.
 *
 * A commit SHA identifies an immutable tree, and the snapshot taken at the last
 * successful commit already holds the content of every file at that SHA. So if
 * HEAD is still that SHA, the snapshot *is* the repository: no tree read, no
 * blob reads, no requests at all beyond asking where HEAD is. Only when HEAD has
 * moved does anything need fetching.
 *
 * Kept pure and separate so the rule can be tested without a browser.
 */

/**
 * True when the snapshot describes exactly the tree at `headSha`.
 *
 * @param {string | null} headSha
 * @param {{ sha?: string } | null} snapshot
 * @returns {boolean}
 */
export function snapshotMatchesHead(headSha, snapshot) {
    return Boolean(
        headSha &&
            snapshot &&
            typeof snapshot.sha === 'string' &&
            snapshot.sha === headSha,
    );
}

/**
 * The content the snapshot recorded, by path.
 *
 * Entries written before pydle kept contents, or written by an older build,
 * have only a hash, so they are left out rather than pretending the file was
 * empty.
 *
 * @param {{ files?: Record<string, unknown> } | null} snapshot
 * @returns {Map<string, string>}
 */
export function snapshotContents(snapshot) {
    const contents = new Map();
    const files = (snapshot && snapshot.files) || {};

    for (const [path, entry] of Object.entries(files)) {
        if (typeof entry === 'string') {
            // An older shape: the entry was the content itself.
            contents.set(path, entry);
            continue;
        }
        if (entry && typeof entry === 'object' && typeof entry.content === 'string') {
            contents.set(path, entry.content);
        }
    }

    return contents;
}

/**
 * Paths whose earlier copy cannot come from the snapshot, and so have to be
 * read from the repository when HEAD has moved.
 *
 * @param {string[]} paths
 * @param {Map<string, string>} contents
 * @returns {string[]}
 */
export function missingFromSnapshot(paths, contents) {
    return paths.filter((path) => !contents.has(path));
}
