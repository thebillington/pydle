const PYODIDE_URL = 'vendor/pyodide/';

importScripts(PYODIDE_URL + 'pyodide.js');

let pyodide = null;
let running = false;
let __gameStep = null;
let __sleepInterrupt = null;
let animMode = false;

function setupSleep() {
    let useAsyncSleep = false;

    if (typeof SharedArrayBuffer !== 'undefined') {
        const sleepBuffer = new SharedArrayBuffer(4);
        const sleepInterrupt = new Int32Array(sleepBuffer);
        Atomics.store(sleepInterrupt, 0, 0);
        self.__sleepInterrupt = sleepInterrupt;
        self.__sleep_js = function (ms) {
            Atomics.wait(self.__sleepInterrupt, 0, 0, ms);
        };
        useAsyncSleep = true;
    }

    if (useAsyncSleep) {
        pyodide.runPython(`
import time as _time
import js

_stop_requested = False

def _browser_sleep(seconds):
    ms = int(seconds * 1000)
    if ms > 0:
        js.__sleep_js(ms)
    if _stop_requested:
        raise KeyboardInterrupt("Execution stopped")

_time.sleep = _browser_sleep
`);
    } else {
        pyodide.runPython(`
import time as _time

def _browser_sleep(seconds):
    pass

_time.sleep = _browser_sleep
`);
    }
}

async function init() {
    try {
        self.postMessage({ type: 'status', text: 'Loading Python runtime...' });

        pyodide = await loadPyodide({ indexURL: PYODIDE_URL });

        pyodide.setStdout({
            batched: (text) => self.postMessage({ type: 'stdout', text }),
        });

        self.postMessage({ type: 'status', text: 'Installing turtle module...' });

        const sources = {};
        const response = await fetch('modules/turtle.py?t=' + Date.now());
        sources['/modules/turtle.py'] = await response.text();

        for (const [path, content] of Object.entries(sources)) {
            const parts = path.split('/').filter(p => p.length > 0);
            let dir = '';
            for (let i = 0; i < parts.length - 1; i++) {
                dir += '/' + parts[i];
                try { pyodide.FS.mkdir(dir); } catch (_) {}
            }
            pyodide.FS.writeFile(path, content);
        }

        pyodide.runPython(`
import sys
sys.path.insert(0, '/modules')
import turtle as _t
_t._init(800, 700)
`);

        setupSleep();

        self.postMessage({ type: 'ready' });
    } catch (err) {
        self.postMessage({ type: 'error', message: 'Init failed: ' + err.message, traceback: err.stack });
    }
}

self.sendFrame = function (imageData) {
    self.postMessage({ type: 'frame', imageData: imageData }, [imageData.data.buffer]);
};

async function runCode(code) {
    if (running) return;
    running = true;
    animMode = false;

    pyodide.runPython(`_stop_requested = False`);
    if (self.__sleepInterrupt) {
        Atomics.store(self.__sleepInterrupt, 0, 0);
    }

    pyodide.runPython(`_t._reset()`);

    const loopMatch = code.match(/([\s\S]*?)while\s+True\s*:\s*\n((?:[ \t]+\S[\s\S]*?))(?=\n\S|\n*$)/);
    
    if (loopMatch) {
        let setupCode = loopMatch[1].trimEnd();
        let loopBody = loopMatch[2];
        
        const lines = loopBody.split('\n');
        let minIndent = Infinity;
        for (const line of lines) {
            if (line.trim().length === 0) continue;
            const leading = line.match(/^(\s*)/)[1].length;
            if (leading < minIndent) minIndent = leading;
        }
        
        const dedented = lines.map(l => l.length >= minIndent ? l.substring(minIndent) : l.trim()).join('\n');

        const escapedBody = dedented.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${');
        const wrappedCode = `
import turtle as _t

${setupCode}

def __game_step():
    exec("""${escapedBody}""", globals())
`;
        try {
            await pyodide.runPythonAsync(wrappedCode);
            __gameStep = pyodide.globals.get('__game_step');
            if (__gameStep) {
                self.postMessage({ type: 'running' });
                self.postMessage({ type: 'tick_start' });
                return;
            }
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message, traceback: err.stack || '' });
        }
        running = false;
        self.postMessage({ type: 'done' });
        return;
    }
    
    pyodide.runPython(`_t._start_anim()`);
    
    self.postMessage({ type: 'running' });
    try {
        await pyodide.runPythonAsync(code);
    } catch (err) {
        if (err.message !== 'Execution stopped') {
            self.postMessage({ type: 'error', message: err.message, traceback: err.stack || '' });
        }
        pyodide.runPython(`_t._stop_anim()`);
        running = false;
        self.postMessage({ type: 'done' });
        return;
    }

    const hasAnim = pyodide.runPython(`_t._has_anim()`);
    if (hasAnim) {
        animMode = true;
        pyodide.runPython(`__anim_step_fn = _t._anim_step`);
        __gameStep = pyodide.globals.get('__anim_step_fn');
        self.postMessage({ type: 'tick_start' });
    } else {
        pyodide.runPython(`_t._stop_anim()`);
        pyodide.runPython(`_t._flush()`);
        running = false;
        self.postMessage({ type: 'done' });
    }
}

function stopCode() {
    __gameStep = null;
    animMode = false;
    if (self.__sleepInterrupt) {
        Atomics.store(self.__sleepInterrupt, 0, 1);
        Atomics.notify(self.__sleepInterrupt, 0);
    }
    pyodide.runPython(`_stop_requested = True`);
    pyodide.runPython(`_t._stop_anim()`);
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
        case 'tick':
            if (__gameStep) {
                try {
                    const result = __gameStep();
                    if (animMode) {
                        const hasMore = result.toJs ? result.toJs() : result;
                        if (!hasMore) {
                            animMode = false;
                            __gameStep = null;
                            pyodide.runPython(`_t._stop_anim()`);
                            running = false;
                            self.postMessage({ type: 'done' });
                        }
                    }
                } catch (err) {
                    self.postMessage({ type: 'error', message: err.message, traceback: err.stack || '' });
                    running = false;
                    __gameStep = null;
                    animMode = false;
                    pyodide.runPython(`_t._stop_anim()`);
                    self.postMessage({ type: 'done' });
                }
            }
            break;
    }
};