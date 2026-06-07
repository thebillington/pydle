const PYODIDE_URL = 'vendor/pyodide/';

importScripts(PYODIDE_URL + 'pyodide.js');

let pyodide = null;
let running = false;
let __gameStep = null;

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

    const loopMatch = code.match(/([\s\S]*?)while\s+True\s*:\s*\n((?:[ \t]+\S[\s\S]*?))(?=\n\S|\n*$)/);
    
    if (loopMatch) {
        let setupCode = loopMatch[1].trimEnd();
        let loopBody = loopMatch[2];
        
        const indentMatch = loopBody.match(/^(\s+)/);
        const indent = indentMatch ? indentMatch[1].length : 0;
        
        const dedented = loopBody.split('\n').map(l => l.substring(indent)).join('\n');
        const cleanedBody = dedented.split('\n').filter(l => !l.trim().match(/^sleep\s*\(/)).join('\n');

        const escapedBody = cleanedBody.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${');
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
    
    self.postMessage({ type: 'running' });
    try {
        await pyodide.runPythonAsync(code);
    } catch (err) {
        if (err.message !== 'Execution stopped') {
            self.postMessage({ type: 'error', message: err.message, traceback: err.stack || '' });
        }
    } finally {
        running = false;
        self.postMessage({ type: 'done' });
    }
}

function stopCode() {
    __gameStep = null;
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
                    __gameStep();
                } catch (err) {
                    self.postMessage({ type: 'error', message: err.message, traceback: err.stack || '' });
                    running = false;
                    __gameStep = null;
                    self.postMessage({ type: 'done' });
                }
            }
            break;
    }
};