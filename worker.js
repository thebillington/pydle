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

/**
 * Where the project's files are written inside Pyodide's virtual filesystem.
 *
 * Python can only import a module that exists on disk, and until now the only thing
 * on disk was the string handed to `runPythonAsync`. A project with `person.py`
 * therefore could not `import person`, which is the whole point of a multi-file
 * project.
 */
const WORK_ROOT = '/home/pyodide/work';

/**
 * Cache of package details, read once from the vendored lockfile: the wheel
 * filename and what it depends on.
 *
 * @type {Map<string, { file: string, depends: string[] }> | null}
 */
let packageInfo = null;

/**
 * Read the lockfile into the cache, once.
 *
 * @returns {Promise<Map<string, { file: string, depends: string[] }>>}
 */
async function readPackageInfo() {
    if (packageInfo !== null) {
        return packageInfo;
    }
    packageInfo = new Map();
    try {
        const response = await fetch(PYODIDE_URL + 'pyodide-lock.json');
        if (response.ok) {
            const lock = await response.json();
            for (const [key, value] of Object.entries(lock.packages || {})) {
                if (value && typeof value.file_name === 'string') {
                    packageInfo.set(key, {
                        file: value.file_name,
                        depends: Array.isArray(value.depends) ? value.depends : [],
                    });
                }
            }
        }
    } catch {
        // No lockfile: nothing can be resolved.
    }
    return packageInfo;
}

/**
 * Where to fetch a wheel from.
 *
 * The bundled copy comes first because it works offline and is the same origin,
 * which is what a school deployment needs. The Pyodide CDN is the fallback so the
 * feature works in a build that has not vendored that wheel yet.
 *
 * @param {string} file
 * @returns {Promise<{ url: string, bundled: boolean }>}
 */
async function wheelUrl(file) {
    const local = PYODIDE_URL + file;
    try {
        const probe = await fetch(local, { method: 'HEAD' });
        if (probe.ok) {
            return { url: local, bundled: true };
        }
    } catch {
        // Fall through to the CDN.
    }
    const version = pyodide.version || '0.26.4';
    return { url: 'https://cdn.jsdelivr.net/pyodide/v' + version + '/full/' + file, bundled: false };
}

/**
 * Install one package, and whatever it depends on, before returning.
 *
 * The wheel is resolved explicitly rather than passing the bare name, because
 * `loadPackage('numpy')` resolves even when the wheel cannot be fetched. That
 * silent success is what left packages uninstalled and turned a missing download
 * into a confusing ImportError later on.
 *
 * @param {string} name
 * @param {Set<string>} [seen]
 * @returns {Promise<boolean>}
 */
async function loadOne(name, seen = new Set()) {
    if (pyodide.loadedPackages && pyodide.loadedPackages[name]) {
        return true;
    }
    if (seen.has(name)) {
        return true;
    }
    seen.add(name);

    const info = await readPackageInfo();
    const entry = info.get(name);
    if (!entry) {
        self.postMessage({
            type: 'status',
            text: name + ' is not available in this build of pydle.',
        });
        return false;
    }

    for (const dependency of entry.depends) {
        await loadOne(dependency, seen);
    }

    const { url, bundled } = await wheelUrl(entry.file);
    try {
        await pyodide.loadPackage(url);
    } catch {
        // Reported below; the check after the call is what decides.
    }

    if (pyodide.loadedPackages && pyodide.loadedPackages[name]) {
        return true;
    }

    self.postMessage({
        type: 'status',
        text:
            name +
            (bundled
                ? ' could not be loaded from this copy of pydle.'
                : '. Check your connection and try again.'),
    });
    return false;
}

/**
 * Install the libraries the project declares in `requirements.txt`.
 *
 * @param {string[]} packages
 */
async function loadPackages(packages) {
    const list = Array.isArray(packages) ? packages : [];
    for (const name of list) {
        if (typeof name !== 'string' || name === '') {
            continue;
        }
        if (pyodide.loadedPackages && pyodide.loadedPackages[name]) {
            continue;
        }
        self.postMessage({ type: 'status', text: 'Getting ' + name + ' ready\u2026' });
        await loadOne(name);
    }
}

/**
 * Write the project's files where Python can import them.
 *
 * The directory is emptied every run so an edited module is picked up rather than a
 * cached one, and any module previously imported from it is dropped from
 * `sys.modules` for the same reason.
 *
 * @param {Record<string, string>} files Path relative to the project, to text.
 */
function prepareFiles(files) {
    pyodide.runPython(`
import os, shutil, sys
_root = '${WORK_ROOT}'
for _name in [n for n, m in list(sys.modules.items())
              if getattr(m, '__file__', None) and str(m.__file__).startswith(_root)]:
    del sys.modules[_name]
shutil.rmtree(_root, ignore_errors=True)
os.makedirs(_root, exist_ok=True)
`);

    const entries = [];
    const directories = new Set();

    for (const [path, content] of Object.entries(files || {})) {
        const segments = String(path).split('/').filter(Boolean);
        if (segments.length === 0) {
            continue;
        }
        if (segments.length > 1) {
            directories.add([WORK_ROOT, ...segments.slice(0, -1)].join('/'));
        }
        entries.push([`${WORK_ROOT}/${segments.join('/')}`, String(content ?? '')]);
    }

    // Directories first, through Python, because that is the API proven to work here.
    if (directories.size > 0) {
        pyodide.runPython(`
import os
for _dir in ${JSON.stringify([...directories])}:
    os.makedirs(_dir, exist_ok=True)
`);
    }

    for (const [fullPath, content] of entries) {
        pyodide.FS.writeFile(fullPath, content, { encoding: 'utf8' });
    }

    pyodide.runPython(`
import os, sys, importlib
_root = '${WORK_ROOT}'
os.chdir(_root)
if _root not in sys.path:
    sys.path.insert(0, _root)
importlib.invalidate_caches()
`);
}

async function runCode(code, files, packages) {
    if (running) return;
    running = true;

    self.postMessage({ type: 'running' });

    try {
        prepareFiles(files);
        await loadPackages(packages);
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

            // Python knows exactly what went wrong and where. Ask it, instead of
            // guessing from the text: SyntaxError carries lineno, offset,
            // end_offset and the offending source line, and exceptions can carry
            // notes (PEP 678) such as the hint Pyodide adds for a missing module.
            // The last line of the traceback also keeps Python's own "did you
            // mean" suggestion, which `str(exc)` alone does not include.
            let structured = null;
            try {
                structured = JSON.parse(
                    pyodide.runPython(`
import json, sys
exc = getattr(sys, 'last_exc', None) or getattr(sys, 'last_value', None)
if exc is None:
    payload = None
else:
    payload = {
        'type': type(exc).__name__,
        'message': getattr(exc, 'msg', None) or str(exc),
        'line': getattr(exc, 'lineno', None),
        'column': getattr(exc, 'offset', None),
        'endColumn': getattr(exc, 'end_offset', None),
        'source': getattr(exc, 'text', None),
        'notes': list(getattr(exc, '__notes__', [])),
    }
json.dumps(payload)
`),
                );
            } catch (extractFailure) {
                // If this fires, the page has no line or column to work with.
                console.warn('[pydle] worker: could not read sys.last_exc', extractFailure);
                structured = null;
            }

            console.info(
                '[pydle] worker: error ' +
                    JSON.stringify({
                        summary,
                        structured,
                    }),
            );

            self.postMessage({ type: 'error', summary, detail: text.trim(), structured });
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
            await runCode(e.data.code, e.data.files, e.data.packages);
            break;
        case 'stop':
            stopCode();
            break;
    }
};