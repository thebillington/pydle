/*
 * A line diff, for showing what is about to be committed.
 *
 * Deliberately small: a longest-common-subsequence over lines, which is plenty for
 * the handful of files a student has, and throws nothing away. Kept pure so it can
 * be tested without a browser.
 *
 * Very large inputs fall back to "everything replaced" rather than allocating a
 * table the size of the square of the line count. A file that big is unreadable in
 * a diff pane anyway.
 */

/** Above this many lines the quadratic table stops being worth it. */
const MAX_LINES = 2000;

/**
 * @typedef {{ type: 'context' | 'added' | 'removed', text: string, before: number | null, after: number | null }} DiffLine
 *   `before` and `after` are 1-based line numbers in the respective versions, null
 *   where the line does not exist on that side.
 */

/**
 * Split text into lines, without inventing a trailing empty line.
 *
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
    if (typeof text !== 'string' || text === '') {
        return [];
    }
    const normalised = text.replace(/\r\n/g, '\n');
    const lines = normalised.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/**
 * Compare two versions of a file, line by line.
 *
 * @param {string | null} before The committed version, or null for a new file.
 * @param {string | null} after The version being committed, or null if deleted.
 * @returns {DiffLine[]}
 */
export function diffLines(before, after) {
    const a = toLines(before ?? '');
    const b = toLines(after ?? '');

    if (a.length > MAX_LINES || b.length > MAX_LINES) {
        return [
            ...a.map((text, index) => ({
                type: /** @type {const} */ ('removed'),
                text,
                before: index + 1,
                after: null,
            })),
            ...b.map((text, index) => ({
                type: /** @type {const} */ ('added'),
                text,
                before: null,
                after: index + 1,
            })),
        ];
    }

    // Classic LCS table, walked backwards into a diff.
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = Array.from({ length: rows }, () => new Uint32Array(cols));

    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            table[i][j] =
                a[i] === b[j]
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    /** @type {DiffLine[]} */
    const out = [];
    let i = 0;
    let j = 0;

    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push({ type: 'context', text: a[i], before: i + 1, after: j + 1 });
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            out.push({ type: 'removed', text: a[i], before: i + 1, after: null });
            i += 1;
        } else {
            out.push({ type: 'added', text: b[j], before: null, after: j + 1 });
            j += 1;
        }
    }

    while (i < a.length) {
        out.push({ type: 'removed', text: a[i], before: i + 1, after: null });
        i += 1;
    }
    while (j < b.length) {
        out.push({ type: 'added', text: b[j], before: null, after: j + 1 });
        j += 1;
    }

    return out;
}

/**
 * How many lines were added and removed.
 *
 * For the `+3 −1` beside a filename, so the numbers always agree with the diff.
 *
 * @param {DiffLine[]} lines
 * @returns {{ added: number, removed: number }}
 */
export function diffStats(lines) {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line.type === 'added') {
            added += 1;
        } else if (line.type === 'removed') {
            removed += 1;
        }
    }
    return { added, removed };
}
