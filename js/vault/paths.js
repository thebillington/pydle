/**
 * Pure path helpers for the browser vault. No I/O, no DOM, no dependencies.
 *
 * Every path that reaches storage passes through `safeJoin`, which only ever
 * returns a normalised, relative, forward-slash path. `assertInside` is the
 * second guard: it answers whether a path stays under a root once `.` and `..`
 * have been resolved, without throwing.
 */

/** Control characters, including NUL, are never valid in a vault path. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** First path segments reserved for the deferred teacher-owned layer. */
const RESERVED_ROOTS = new Set(['assignments', 'feedback']);

/** Project slugs are capped so a directory name stays reasonable. */
const MAX_PROJECT_NAME = 64;

/**
 * Describe a value for an error message without letting it blow up.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/**
 * Normalise a list of path fragments into one relative, `/`-separated path.
 *
 * Rejects (with a TypeError naming the offending input):
 * - non-string or empty fragments
 * - absolute paths (leading `/`)
 * - backslashes anywhere
 * - empty segments (`a//b`, trailing `/`)
 * - `..` traversal in any form
 * - NUL and other control characters
 *
 * A `.` segment is collapsed, so `safeJoin('a', './b')` is `'a/b'`.
 *
 * @param {...string} parts Path fragments to join.
 * @returns {string} The normalised relative path.
 * @throws {TypeError} If any fragment or the result is not a safe relative path.
 */
export function safeJoin(...parts) {
    if (parts.length === 0) {
        throw new TypeError('safeJoin: expected at least one path fragment');
    }

    const segments = [];

    for (const part of parts) {
        if (typeof part !== 'string') {
            throw new TypeError(
                `safeJoin: path fragment must be a string, got ${typeof part} (${describe(part)})`,
            );
        }
        if (part === '') {
            throw new TypeError('safeJoin: empty path fragment');
        }
        if (part.startsWith('/')) {
            throw new TypeError(`safeJoin: absolute path not allowed: ${describe(part)}`);
        }
        if (part.includes('\\')) {
            throw new TypeError(`safeJoin: backslash not allowed: ${describe(part)}`);
        }
        if (CONTROL_CHARS.test(part)) {
            throw new TypeError(`safeJoin: control character in path: ${describe(part)}`);
        }

        for (const segment of part.split('/')) {
            if (segment === '') {
                throw new TypeError(`safeJoin: empty path segment: ${describe(part)}`);
            }
            if (segment === '.') {
                continue;
            }
            if (segment === '..') {
                throw new TypeError(`safeJoin: parent traversal not allowed: ${describe(part)}`);
            }
            segments.push(segment);
        }
    }

    if (segments.length === 0) {
        throw new TypeError('safeJoin: path resolves to nothing');
    }

    return segments.join('/');
}

/**
 * Whether a path lives in a namespace reserved for the future classroom layer.
 *
 * `assignments/` and `feedback/` are reserved now, before anything writes to
 * them, so a later teacher-owned feature cannot collide with a pupil's files.
 * The check is case-insensitive and ignores leading slashes.
 *
 * @param {string} path Path to test.
 * @returns {boolean} True when the first segment is `assignments` or `feedback`.
 */
export function isReservedPath(path) {
    if (typeof path !== 'string' || path === '') {
        return false;
    }
    const first = path.replace(/^\/+/, '').split('/')[0].toLowerCase();
    return RESERVED_ROOTS.has(first);
}

/**
 * Turn a display name into a safe project slug.
 *
 * Lowercases, maps spaces and underscores to `-`, drops anything outside
 * `[a-z0-9-]`, collapses repeated hyphens, trims hyphens at both ends and
 * caps the result at 64 characters.
 *
 * @param {string} name Human-readable project name.
 * @returns {string} A slug usable as a directory name.
 * @throws {TypeError} If the name is not a string or yields an empty slug.
 */
export function normalizeProjectName(name) {
    if (typeof name !== 'string') {
        throw new TypeError(
            `normalizeProjectName: name must be a string, got ${typeof name} (${describe(name)})`,
        );
    }

    const slug = name
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_PROJECT_NAME)
        .replace(/-+$/g, '');

    if (slug === '') {
        throw new TypeError(
            `normalizeProjectName: ${describe(name)} has no usable characters`,
        );
    }

    return slug;
}

/**
 * Resolve `.` and `..` in a path, tolerating absolute paths and empty segments.
 *
 * Returns `null` when the path is unusable (not a string, contains a backslash
 * or control character, or climbs above its own starting point).
 *
 * @param {string} path
 * @returns {string[] | null} Resolved relative segments, or null.
 */
function resolveSegments(path) {
    if (typeof path !== 'string' || path.includes('\\') || CONTROL_CHARS.test(path)) {
        return null;
    }

    const segments = [];
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (segments.length === 0) {
                return null;
            }
            segments.pop();
            continue;
        }
        segments.push(segment);
    }

    return segments;
}

/**
 * Whether `path` is `root` itself or something beneath it.
 *
 * Both sides are resolved first, so `..` cannot be used to escape. Invalid
 * paths answer `false` rather than throwing.
 *
 * @param {string} root Root directory.
 * @param {string} path Candidate path.
 * @returns {boolean} True when `path` stays inside `root`.
 */
export function assertInside(root, path) {
    const base = resolveSegments(root);
    const target = resolveSegments(path);
    if (base === null || target === null || target.length < base.length) {
        return false;
    }

    return base.every((segment, index) => segment === target[index]);
}
