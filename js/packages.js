/**
 * The libraries a project may ask for, and the rules for its requirements.txt.
 *
 * `requirements.txt` is the single source of truth: one package name per line,
 * `#` comments allowed, blank lines ignored. The picker in `js/ui/libraries.js`
 * is only a view over that file, so the helpers here are pure text functions and
 * install nothing. Fetching a library for Pyodide is a separate concern.
 *
 * The catalogue is deliberately short, and every entry has to be usable inside
 * pydle. That rules out anything whose whole point is a window, a canvas, a
 * sound device or a picture in the output: pygame needs a display surface and
 * matplotlib needs somewhere to draw a figure, and pydle has neither. A package
 * that installs and then cannot do its job is worse than one that is absent,
 * because the student concludes that they are doing it wrong.
 *
 * Sizes are the real download sizes from the vendored lockfile, rounded, because
 * the first run of a project really does wait for them.
 *
 * Names are matched case-insensitively but written lowercase. A line a student
 * added by hand is never dropped, even when it is not in the catalogue: the
 * picker may not know about it, but the file still declares it.
 */

export const CATALOGUE = [
    {
        id: 'numpy',
        label: 'numpy',
        summary: 'Numbers, arrays and maths',
        size: '12 MB',
    },
    {
        id: 'sympy',
        label: 'sympy',
        summary: 'Algebra and calculus with exact symbols',
        size: '16 MB',
    },
    {
        id: 'pandas',
        label: 'pandas',
        summary: 'Tables of data, like a spreadsheet in code',
        size: '24 MB, plus numpy',
    },
    {
        id: 'scipy',
        label: 'scipy',
        summary: 'Scientific computing on top of numpy',
        size: '47 MB, plus numpy and 6 MB of maths code',
    },
];

/**
 * The package part of a requirement line.
 *
 * A line may carry a version pin, extras or an environment marker. Those stay
 * in the file untouched, but they are not part of the name for comparison:
 * `numpy==1.26.4` still counts as `numpy`. A line with no recognisable name is
 * returned as written so it can be preserved rather than guessed at.
 *
 * @param {string} line
 * @returns {string}
 */
function packageName(line) {
    const body = line.replace(/#.*/, '').trim();
    const match = body.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
    return match ? match[0] : body;
}

/**
 * Split requirements text into leading comments and the entries beneath them.
 *
 * Comments are full lines, trimmed at the edges and kept in the order they
 * appeared. Blank lines are dropped. Entries keep their original spelling and
 * any inline comment so rewriting the file does not quietly edit them.
 *
 * @param {unknown} text
 * @returns {{ comments: string[], entries: Array<{ raw: string, name: string, key: string }> }}
 */
function readRequirements(text) {
    const source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
    /** @type {string[]} */
    const comments = [];
    /** @type {Array<{ raw: string, name: string, key: string }>} */
    const entries = [];

    for (const rawLine of source.split('\n')) {
        const trimmed = rawLine.trim();
        if (trimmed === '') {
            continue;
        }
        if (trimmed.startsWith('#')) {
            comments.push(trimmed);
            continue;
        }

        const name = packageName(trimmed);
        if (name === '') {
            continue;
        }
        entries.push({ raw: trimmed, name, key: name.toLowerCase() });
    }

    return { comments, entries };
}

/**
 * Put the pieces back into readable requirements text.
 *
 * Comments come first, above the names, so a rewritten file keeps its notes in
 * the one place a reader looks for them. A non-empty file ends with a newline;
 * an empty one is the empty string, not a stray blank line.
 *
 * @param {string[]} comments
 * @param {Array<{ raw: string }>} entries
 * @returns {string}
 */
function compose(comments, entries) {
    const lines = [...comments, ...entries.map((entry) => entry.raw)];
    if (lines.length === 0) {
        return '';
    }
    return `${lines.join('\n')}\n`;
}

/**
 * The package names a requirements.txt declares.
 *
 * Deduplicated case-insensitively, in the order they first appear. A version
 * pin is left out of the name, so `pandas==2.2.3` is reported as `pandas`.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function parseRequirements(text) {
    const { entries } = readRequirements(text);
    const seen = new Set();
    const names = [];

    for (const entry of entries) {
        if (seen.has(entry.key)) {
            continue;
        }
        seen.add(entry.key);
        names.push(entry.name);
    }

    return names;
}

/**
 * Add a package to requirements text.
 *
 * The name is normalised to lowercase. Adding something already present, in any
 * case, returns the text exactly as it was: no reordering, no reformatting.
 *
 * @param {unknown} text
 * @param {unknown} name
 * @returns {string}
 */
export function addPackage(text, name) {
    const source = typeof text === 'string' ? text : '';
    const target = packageName(String(name === undefined || name === null ? '' : name).trim()).toLowerCase();
    if (target === '') {
        return source;
    }

    const { comments, entries } = readRequirements(source);
    if (entries.some((entry) => entry.key === target)) {
        return source;
    }

    entries.push({ raw: target, name: target, key: target });
    return compose(comments, entries);
}

/**
 * Remove a package from requirements text.
 *
 * Matching ignores case and any version pin. Removing the last entry with no
 * comments above it leaves the empty string. Removing something absent returns
 * the text unchanged, so an unknown line is never collateral damage.
 *
 * @param {unknown} text
 * @param {unknown} name
 * @returns {string}
 */
export function removePackage(text, name) {
    const source = typeof text === 'string' ? text : '';
    const target = packageName(String(name === undefined || name === null ? '' : name).trim()).toLowerCase();
    if (target === '') {
        return source;
    }

    const { comments, entries } = readRequirements(source);
    const kept = entries.filter((entry) => entry.key !== target);
    if (kept.length === entries.length) {
        return source;
    }

    return compose(comments, kept);
}

/**
 * Whether requirements text declares a package.
 *
 * @param {unknown} text
 * @param {unknown} name
 * @returns {boolean}
 */
export function hasPackage(text, name) {
    const target = packageName(String(name === undefined || name === null ? '' : name).trim()).toLowerCase();
    if (target === '') {
        return false;
    }
    const { entries } = readRequirements(text);
    return entries.some((entry) => entry.key === target);
}

/**
 * The names pydle will actually load.
 *
 * This is the catalogue and nothing else. `requirements.txt` is editable, so a
 * student can type any of Pyodide's 310 packages into it; the picker offering a
 * short list while the loader accepted everything would make the list advisory
 * rather than real.
 *
 * @type {Set<string>}
 */
export const OFFERED = new Set(CATALOGUE.map((entry) => entry.id.toLowerCase()));

/**
 * Names refused even if a list says otherwise.
 *
 * `micropip` installs whatever is on PyPI at the time, which turns any allowlist
 * into "the whole internet" in two lines. It is refused by name so that adding
 * it to the catalogue, or to a deployment's list, cannot reintroduce that.
 *
 * @type {Set<string>}
 */
const ALWAYS_REFUSED = new Set(['micropip']);

/**
 * Split declared names into what will be loaded and what will be refused.
 *
 * Names are compared case-insensitively, because `requirements.txt` accepts
 * `NumPy` and pip treats it as `numpy`. The names returned are the ones from
 * the file, so the caller can quote what the student actually wrote.
 *
 * @param {string[]} names
 * @param {Set<string>} [offered] Override for a deployment that offers more.
 * @returns {{ allowed: string[], refused: string[] }}
 */
export function splitDeclared(names, offered = OFFERED) {
    const allowed = [];
    const refused = [];

    for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== 'string' || name.trim() === '') {
            continue;
        }
        const key = name.trim().toLowerCase();
        if (ALWAYS_REFUSED.has(key) || !offered.has(key)) {
            refused.push(name);
        } else {
            allowed.push(name);
        }
    }

    return { allowed, refused };
}
