/*
 * A short, plain-English hint for the errors beginners actually hit.
 *
 * Deliberately small and honest: it matches the exception Python reported and
 * explains what to look for. It never claims to fix the code, and when it does not
 * recognise an error it says nothing rather than inventing advice.
 *
 * Kept free of DOM and dependencies so it can be unit tested.
 */

/**
 * @typedef {{ hint: string, name: string | null }} ErrorHint
 *   `name` is the identifier Python mentioned, when it named one.
 */

/** @type {Array<{ test: RegExp, hint: (match: RegExpExecArray) => string }>} */
const RULES = [
    {
        test: /unterminated string literal/i,
        hint: () =>
            'A quotation mark is never closed. The caret shows where Python stopped looking for the end of the text.',
    },
    {
        test: /unterminated triple-quoted string literal/i,
        hint: () => 'A """ block is never closed. Look for the matching """ further down.',
    },
    {
        test: /expected ':'/i,
        hint: () =>
            'This line needs a colon at the end. Lines that start with if, for, while, def, class, else or try always end with one.',
    },
    {
        test: /(unexpected indent|expected an indented block|unindent does not match)/i,
        hint: () =>
            'The indentation is uneven. Lines in the same block need the same number of spaces, and a line after a colon needs more.',
    },
    {
        test: /indentationerror/i,
        hint: () => 'Python is unhappy with the indentation on this line.',
    },
    {
        // e.g. print f`...` or print "a" "b"
        test: /invalid syntax/i,
        hint: () =>
            'Python cannot read this line. Look at the caret: it usually means a missing bracket, quote or comma, or two statements run together.',
    },
    {
        test: /nameerror: name '([^']+)' is not defined/i,
        hint: (match) =>
            `"${match[1]}" has not been given a value yet. Check the spelling, or set it before this line.`,
    },
    {
        test: /nameerror/i,
        hint: () => 'A name is used before it has a value. Check the spelling.',
    },
    {
        test: /zero division error|division by zero/i,
        hint: () => 'Python cannot divide by zero. Check the number you are dividing by.',
    },
    {
        test: /zerodivisionerror/i,
        hint: () => 'Python cannot divide by zero. Check the number you are dividing by.',
    },
    {
        test: /modulenotfounderror: no module named '([^']+)'/i,
        hint: (match) =>
            `"${match[1]}" is not included in pydle. Only the Python standard library is available here.`,
    },
    {
        test: /importerror/i,
        hint: () => 'That module or name could not be imported. Check the spelling.',
    },
    {
        test: /typeerror/i,
        hint: () =>
            'A value is the wrong type for what is being done with it. A common case is adding text to a number: use str() or an f-string.',
    },
    {
        test: /valueerror/i,
        hint: () => 'The value is the right type but not allowed here. Check what was passed in.',
    },
    {
        test: /indexerror/i,
        hint: () =>
            'That position is past the end of the list. Remember the first item is 0, and the last is len(list) - 1.',
    },
    {
        test: /keyerror: (.+)/i,
        hint: (match) => `The key ${match[1].trim()} is not in the dictionary.`,
    },
    {
        test: /attributeerror/i,
        hint: () =>
            'That object does not have that attribute or method. Check the spelling and the type of the thing you are using.',
    },
    {
        test: /recursionerror/i,
        hint: () => 'A function keeps calling itself without stopping. Check the condition that should end it.',
    },
    {
        test: /syntaxerror/i,
        hint: () => 'Python could not read this line. Look at the caret for the place it gave up.',
    },
];

/**
 * A hint for a one-line Python error summary, or null when nothing matches.
 *
 * @param {string} summary e.g. "SyntaxError: invalid syntax"
 * @returns {ErrorHint | null}
 */
export function hintFor(summary) {
    if (typeof summary !== 'string' || summary.trim() === '') {
        return null;
    }

    // The summary may be followed by a caret annotation; match on the whole string.
    const text = summary.trim();

    for (const rule of RULES) {
        const match = rule.test.exec(text);
        if (match) {
            return { hint: rule.hint(match), name: match[1] ?? null };
        }
    }

    return null;
}
