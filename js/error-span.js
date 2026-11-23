/*
 * Where exactly did Python point?
 *
 * A SyntaxError traceback carries the offending source line and a caret line
 * beneath it, which is the single most useful piece of information in the whole
 * output and is easy to throw away:
 *
 *       File "<exec>", line 6
 *         print f`Hi {name}! You're invited to my birthday party!`
 *                               ^
 *     SyntaxError: unterminated string literal (detected at line 6)
 *
 * CPython 3.11 and later may mark a range with several carets, so the span can be
 * longer than one character.
 *
 * Pure and DOM-free, so it can be tested without a browser.
 */

/**
 * @typedef {{ line: number, column: number, length: number, sourceLine: string }} ErrorSpan
 *   `line` is 1-based, `column` is 0-based, `length` is at least 1.
 */

/**
 * Find the caret span from a syntax-error traceback.
 *
 * Returns null when the traceback has no caret, which is the case for runtime
 * errors: a NameError tells you a line but not a column.
 *
 * @param {string} text The formatted traceback.
 * @returns {ErrorSpan | null}
 */
export function syntaxErrorSpan(text) {
    if (typeof text !== 'string' || text === '') {
        return null;
    }

    const lines = text.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
        const caretLine = lines[index];
        const first = caretLine.indexOf('^');

        if (first === -1) {
            continue;
        }

        // A caret line contains nothing but whitespace and carets.
        if (caretLine.trim().replace(/\^/g, '') !== '') {
            continue;
        }

        const length = (caretLine.match(/\^+/g) || ['^'])[0].length;

        // The source line is the one above, indented to line up with the carets.
        let source = '';
        if (index > 0) {
            source = lines[index - 1];
        }

        // If the source line is absent, this is not a caret we can place.
        if (source.trim() === '') {
            continue;
        }

        // Walk back for the nearest frame header to get the line number.
        let lineNumber = null;
        for (let back = index - 1; back >= 0; back -= 1) {
            const match = /line\s+(\d+)/.exec(lines[back]);
            if (match) {
                lineNumber = Number(match[1]);
                break;
            }
        }

        if (!Number.isInteger(lineNumber) || lineNumber < 1) {
            continue;
        }

        // The traceback indents both the source and the carets by the same amount,
        // so remove the leading indent from both and compare.
        const indent = source.length - source.trimStart().length;
        const column = Math.max(0, first - indent);

        return {
            line: lineNumber,
            column,
            length: Math.max(1, length),
            sourceLine: source.trim(),
        };
    }

    return null;
}
