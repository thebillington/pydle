/*
 * The error block shown under the console.
 *
 * Pyodide's traceback ends with the offending source line and a marker beneath it.
 * That marker is a row of `^` characters, which is precise but means nothing to a
 * student. So the same information is rendered as the line itself with the faulty
 * characters highlighted, which is the pointer without the punctuation.
 *
 * `splitAround` is pure so the slicing can be unit tested; `buildErrorBlock` is a
 * thin DOM wrapper around it.
 */

/**
 * @typedef {{ line: number, column: number, length: number }} ErrorLocation
 */

/**
 * Trim the displayed line, and move the column with it.
 *
 * Python reports `offset` from the start of the line *as it appears in the
 * traceback*, which keeps the indentation. The snippet is shown trimmed, so the
 * column has to lose the same number of characters, or the highlight lands a few
 * characters to the right of the real fault.
 *
 * @param {string} raw Line exactly as Python reported it.
 * @param {{ line: number, column: number, length: number } | null} location
 * @returns {{ sourceLine: string, location: { line: number, column: number, length: number } | null }}
 */
export function normaliseSource(raw, location) {
    const text = typeof raw === 'string' ? raw.replace(/\r?\n$/, '') : '';
    const indent = text.length - text.trimStart().length;
    const sourceLine = text.trim();

    if (!location) {
        return { sourceLine, location: null };
    }

    return {
        sourceLine,
        location: { ...location, column: Math.max(0, location.column - indent) },
    };
}

/**
 * Split a source line into the part before the fault, the fault itself, and the rest.
 *
 * Guards every way the offsets can be wrong: a negative column, a length past the
 * end of the line, or a line that has changed since the error was reported.
 *
 * @param {string} sourceLine
 * @param {ErrorLocation | null} location
 * @returns {{ before: string, marked: string, after: string }}
 */
export function splitAround(sourceLine, location) {
    const text = typeof sourceLine === 'string' ? sourceLine : '';
    if (!text || !location) {
        return { before: text, marked: '', after: '' };
    }

    const start = Math.max(0, Math.min(text.length, Math.round(location.column) || 0));
    const wanted = Math.max(1, Math.round(location.length) || 1);
    const end = Math.min(text.length, start + wanted);

    return {
        before: text.slice(0, start),
        marked: text.slice(start, end),
        after: text.slice(end),
    };
}

/**
 * Build the block: Python's sentence, then the line with the fault marked, then any
 * notes, then the traceback folded away.
 *
 * @param {{
 *   summary: string,
 *   notes?: string[],
 *   detail?: string,
 *   sourceLine?: string,
 *   location?: ErrorLocation | null,
 * }} input
 * @returns {HTMLElement}
 */
export function buildErrorBlock({ friendly, summary, notes, detail, sourceLine, location }) {
    const block = document.createElement('div');
    block.className = 'console-error';
    block.setAttribute('role', 'group');

    const explained = friendly && typeof friendly === 'object' ? friendly : null;

    const headline = document.createElement('p');
    headline.className = 'console-error-summary';

    if (explained && typeof explained.title === 'string' && explained.title !== '') {
        // The friendly explanation's own headline, which says what went wrong in
        // words rather than repeating the exception name.
        headline.textContent = explained.title;
        block.append(headline);

        if (typeof explained.summary === 'string' && explained.summary !== '') {
            const lede = document.createElement('p');
            lede.className = 'console-error-lede';
            lede.textContent = explained.summary;
            block.append(lede);
        }

        if (Array.isArray(explained.steps) && explained.steps.length > 0) {
            const steps = document.createElement('ol');
            steps.className = 'console-error-steps';
            for (const step of explained.steps) {
                const item = document.createElement('li');
                item.textContent = String(step);
                steps.append(item);
            }
            block.append(steps);
        }
    } else {
        headline.textContent =
            typeof summary === 'string' ? summary : 'Python stopped on an error.';
        block.append(headline);
    }

    const parts = splitAround(sourceLine, location);
    if (parts.before !== '' || parts.marked !== '' || parts.after !== '') {
        const row = document.createElement('p');
        row.className = 'console-error-source';

        if (location) {
            const label = document.createElement('span');
            label.className = 'console-error-line';
            label.textContent = 'line ' + location.line;
            row.append(label);
        }

        const code = document.createElement('code');
        code.append(document.createTextNode(parts.before));

        if (parts.marked !== '') {
            // The pointer: the exact characters, highlighted. Not a caret.
            const mark = document.createElement('mark');
            mark.className = 'console-error-mark';
            mark.textContent = parts.marked;
            mark.title = typeof summary === 'string' ? summary : '';
            code.append(mark);
        }

        code.append(document.createTextNode(parts.after));
        row.append(code);
        block.append(row);
    }

    for (const note of Array.isArray(notes) ? notes : []) {
        const paragraph = document.createElement('p');
        paragraph.className = 'console-error-note';
        paragraph.textContent = String(note);
        block.append(paragraph);
    }

    if (typeof detail === 'string' && detail.trim() !== '') {
        const details = document.createElement('details');
        details.className = 'console-details';

        const toggle = document.createElement('summary');
        toggle.textContent = 'Show what Python said in full';

        const body = document.createElement('pre');
        body.className = 'console-details-body';
        body.textContent = detail;

        details.append(toggle, body);
        block.append(details);
    }

    return block;
}
