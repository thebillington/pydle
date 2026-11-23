/*
 * What Python said, turned into something the editor can act on.
 *
 * Python already knows what went wrong and where. A SyntaxError carries `lineno`,
 * `offset` and `end_offset` as real fields, and exceptions can carry notes
 * (PEP 678), which Pyodide uses for things like a missing module. So there is no
 * need to interpret the text, and no hand-written table of advice to drift out of
 * date: the interpreter's own words are what get shown.
 *
 * The one thing kept from parsing is a fallback, for the case where no structured
 * detail came back: a traceback's own marker line still tells us the column.
 */

import { syntaxErrorSpan } from './error-span.js';

/**
 * @typedef {{ line: number, column: number, length: number }} ErrorLocation
 *   `line` is 1-based, `column` is 0-based, `length` is at least 1.
 */

/**
 * Where to put the marker, preferring Python's structured offsets.
 *
 * @param {{ structured?: any, detail?: string }} input
 * @returns {ErrorLocation | null}
 */
export function errorLocation({ structured, detail } = {}) {
    const info = structured && typeof structured === 'object' ? structured : null;

    // Only trust the structured span when Python actually gave a column. Some
    // errors carry a line but no offset, and defaulting to column 0 pointed at the
    // first character of the line instead of the fault.
    if (
        info &&
        Number.isInteger(info.line) &&
        info.line >= 1 &&
        Number.isFinite(info.column) &&
        info.column >= 1
    ) {
        const start = info.column;
        const end = Number.isFinite(info.endColumn) ? info.endColumn : start;

        // CPython reports 1-based columns, and end_offset is inclusive.
        const column = Math.max(0, start - 1);
        const length = Math.max(1, Math.round(end - start) + 1);

        return { line: info.line, column, length };
    }

    // No structured detail: fall back to the marker line in the text.
    const span = syntaxErrorSpan(typeof detail === 'string' ? detail : '');
    if (!span) {
        return null;
    }
    return { line: span.line, column: span.column, length: span.length };
}

/**
 * Notes Python attached to the exception, in its own words.
 *
 * @param {{ structured?: any }} input
 * @returns {string[]}
 */
export function errorNotes({ structured } = {}) {
    const info = structured && typeof structured === 'object' ? structured : null;
    if (!info || !Array.isArray(info.notes)) {
        return [];
    }
    return info.notes.map((note) => String(note).trim()).filter((note) => note !== '');
}

/**
 * The line to show in the console.
 *
 * Prefers the last line of the formatted traceback rather than `str(exc)`,
 * because that is the version CPython decorates with suggestions such as
 * "Did you mean: 'total'?".
 *
 * @param {{ summary?: string, structured?: any }} input
 * @returns {string}
 */
export function errorHeadline({ summary, structured } = {}) {
    if (typeof summary === 'string' && summary.trim() !== '') {
        return summary.trim();
    }

    const info = structured && typeof structured === 'object' ? structured : null;
    if (info) {
        const type = typeof info.type === 'string' ? info.type : 'Error';
        const message = typeof info.message === 'string' ? info.message : '';
        return message ? `${type}: ${message}` : type;
    }

    return 'Python stopped on an error.';
}
