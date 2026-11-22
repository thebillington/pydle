/*
 * Pull the line number the student should look at out of a Python traceback.
 *
 * Pyodide runs the user's program as a compiled snippet, so its frames appear
 * as `<exec>`, `<string>` or a synthetic `main.py`; the stdlib and Pyodide's
 * own loader also appear and are not the student's code. The useful frame is
 * the *last* one that belongs to the user, because that is where the exception
 * was actually raised.
 *
 * Kept dependency-free and DOM-free so it can be unit tested in Node.
 */

const FRAME = /File\s+"([^"]*)",\s*line\s+(\d+)/g;

/**
 * Whether a frame's filename belongs to the stdlib, Pyodide or the interpreter
 * rather than to the program the student wrote.
 *
 * @param {string} file Filename exactly as it appears in the traceback.
 * @returns {boolean} True when the frame should be skipped.
 */
function isInternalFrame(file) {
    const name = file.trim();

    if (!name) {
        return true;
    }

    // Synthetic frames: `<exec>` and `<string>` are the user's code, but
    // `<frozen importlib._bootstrap>` and friends are interpreter plumbing.
    if (name.startsWith('<')) {
        return name.startsWith('<frozen');
    }

    const path = name.replace(/\\/g, '/');

    // /usr/lib/python3.11/..., /home/pyodide/lib/python3.11/... and friends.
    if (/(^|\/)lib\/python[0-9]/.test(path)) {
        return true;
    }
    if (/\/python3(\.[0-9]+)?\//.test(path)) {
        return true;
    }
    if (/(^|\/)(site|dist)-packages\//.test(path)) {
        return true;
    }

    // Pyodide's JavaScript loader can leak into an error stack.
    if (/pyodide[^/]*\.(js|mjs)$/i.test(path)) {
        return true;
    }

    return false;
}

/**
 * Find the line of the last user-code frame in a traceback.
 *
 * Handles ordinary tracebacks, multi-frame tracebacks (picking the deepest
 * user frame), `SyntaxError` output where the frame has no `in ...` part,
 * and chained exceptions. Returns `null` rather than throwing for anything
 * that is not a recognisable traceback.
 *
 * @param {string} text Traceback text, possibly with a leading "Error: ..." line.
 * @returns {number | null} A 1-based line number, or null when none is found.
 */
export function lineFromTraceback(text) {
    if (typeof text !== 'string' || text === '') {
        return null;
    }

    let line = null;
    let match;

    FRAME.lastIndex = 0;
    while ((match = FRAME.exec(text)) !== null) {
        const file = match[1];
        const number = Number.parseInt(match[2], 10);

        if (!Number.isInteger(number) || number < 1) {
            continue;
        }
        if (isInternalFrame(file)) {
            continue;
        }

        line = number;
    }

    return line;
}
