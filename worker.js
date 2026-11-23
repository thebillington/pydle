const PYODIDE_URL = 'vendor/pyodide/';

importScripts(PYODIDE_URL + 'pyodide.js');

let pyodide = null;
let running = false;

async function init() {
    try {
        self.postMessage({ type: 'status', text: 'Loading Python runtime...' });

        pyodide = await loadPyodide({ indexURL: PYODIDE_URL });

        pyodide.setStdout({
            batched: (text) => self.postMessage({ type: 'stdout', text }),
        });

        self.postMessage({ type: 'ready' });
    } catch (err) {
        self.postMessage({
            type: 'error',
            summary: 'Python could not start. Reload the page to try again.',
            detail: String(err && err.message ? err.message : err),
        });
    }
}

async function runCode(code) {
    if (running) return;
    running = true;

    self.postMessage({ type: 'running' });

    try {
        await pyodide.runPythonAsync(code);
    } catch (err) {
        if (err.message !== 'Execution stopped') {
            // `err.message` is Python's own formatted traceback. `err.stack` is
            // Pyodide's JavaScript internals: meaningless to a student, and it buried
            // the one line that matters. Pyodide's own console does the same thing,
            // formatting a syntax error with traceback.format_exception_only.
            const text = typeof err.message === 'string' ? err.message : String(err);
            const lines = text.split('\n').filter((line) => line.trim() !== '');
            const summary = lines.length > 0
                ? lines[lines.length - 1].trim()
                : 'Python stopped on an error.';
            self.postMessage({ type: 'error', summary, detail: text.trim() });
        }
    } finally {
        running = false;
        self.postMessage({ type: 'done' });
    }
}

function stopCode() {
    if (running) {
        running = false;
        self.postMessage({ type: 'done' });
    }
}

self.onmessage = async function (e) {
    const { type } = e.data;

    switch (type) {
        case 'init':
            await init();
            break;
        case 'run':
            await runCode(e.data.code);
            break;
        case 'stop':
            stopCode();
            break;
    }
};