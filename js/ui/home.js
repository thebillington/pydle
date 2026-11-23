/**
 * The home screen: every project on this device, and the way back into one.
 *
 * Home is a full screen rather than a dialog, because it is the resting state
 * of the app whenever nothing is open. It owns its own project list, search and
 * naming flow; the page owns the vault and supplies `listProjects`, `onOpen`
 * and `onCreate`. Nothing here reads storage or writes files directly.
 *
 * The naming rules live at the top as pure functions so they can be tested
 * without a DOM:
 *
 *   toSnakeCase('My first project')     -> 'my_first_project'
 *   validateProjectName('1st_project')  -> { ok: false, error: '…' }
 *   toSnakeFileName('Main')             -> 'main'
 *   validateStarterFileName('Main')     -> { ok: true, name: 'main.py' }
 */

import { promptText } from './dialog.js';
import { MAX_PROJECT_NAME, normalizeProjectName } from '../vault/paths.js';

/**
 * The longest project name the vault will accept from this screen.
 *
 * Re-exported from the storage rule so the dialogue and the vault cannot drift.
 */
export { MAX_PROJECT_NAME };

/**
 * Turn typed text into the shape of a project name while it is being typed.
 *
 * This is the same rule storage applies, not a second copy of it: the vault's
 * `normalizeProjectName` is the only implementation, so what the dialogue
 * previews is exactly what the project is stored and shown as. Unusable input
 * returns an empty string rather than throwing, because a half-typed name is
 * not an error yet.
 *
 * @param {unknown} raw
 * @returns {string}
 */
/**
 * The live version of {@link toSnakeCase}, for use while typing.
 *
 * The strict version trims trailing separators, which is right on submit but wrong
 * on every keystroke: typing "my project" passes through "my ", which trimmed to
 * "my", so the space vanished and the next letter ran the words together into
 * "myproject". This keeps a trailing separator until there is a character after it.
 *
 * @param {string} raw
 * @returns {string}
 */
export function liveProjectName(raw) {
    return String(raw ?? '')
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/_+/g, '_')
        .slice(0, MAX_PROJECT_NAME);
}

/**
 * The live version of {@link toSnakeFileName}, for use while typing.
 *
 * Only lowercases and turns spaces into underscores, so a half-typed ".py" is not
 * mangled on the way in. The strict version validates on submit.
 *
 * @param {string} raw
 * @returns {string}
 */
export function liveFileName(raw) {
    return String(raw ?? '')
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_.]/g, '');
}

export function toSnakeCase(raw) {
    try {
        return normalizeProjectName(String(raw ?? ''));
    } catch {
        return '';
    }
}

/**
 * Check a project name against the classroom rules.
 *
 * The rules are deliberately narrow so a name is also a safe directory and a
 * readable GitHub path: lowercase letters, digits and single underscores, a
 * letter first, and no more than forty characters.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
/**
 * Names that cannot be used, because a directory of that name already means
 * something else inside the vault.
 */
export const RESERVED_PROJECT_NAMES = new Set(['assignments', 'feedback']);

export function validateProjectName(raw) {
    const name = String(raw ?? '').trim().toLowerCase();

    if (name === '') {
        return { ok: false, error: 'Enter a name for the project.' };
    }
    if (!/^[a-z]/.test(name)) {
        return { ok: false, error: 'Start the name with a letter.' };
    }
    if (!/^[a-z0-9_]+$/.test(name)) {
        return {
            ok: false,
            error: 'Use lowercase letters, numbers and underscores only.',
        };
    }
    if (RESERVED_PROJECT_NAMES.has(name)) {
        return {
            ok: false,
            error: 'That name is used by pydle itself. Choose another.',
        };
    }
    if (name.includes('__')) {
        return { ok: false, error: 'Use single underscores between words.' };
    }
    if (name.length > MAX_PROJECT_NAME) {
        return {
            ok: false,
            error: `Keep the name to ${MAX_PROJECT_NAME} characters or fewer.`,
        };
    }
    return { ok: true, name };
}

/**
 * Turn typed text into the shape of a Python file name while it is typed.
 *
 * Dots are kept so the extension can be typed; everything else follows the
 * same rules as a project name.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function toSnakeFileName(raw) {
    const cleaned = String(raw ?? '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_')
        .replace(/-/g, '_')
        .replace(/[^a-z0-9_.]/g, '')
        .replace(/_+/g, '_')
        .replace(/\.{2,}/g, '.')
        .replace(/^_+/, '');

    const dot = cleaned.lastIndexOf('.');
    if (dot > 0) {
        const stem = cleaned
            .slice(0, dot)
            .replace(/^[._]+/, '')
            .slice(0, MAX_PROJECT_NAME);
        return stem + cleaned.slice(dot);
    }
    return cleaned.replace(/^[._]+/, '').slice(0, MAX_PROJECT_NAME);
}

/**
 * Check the first file name of a new project: snake_case, ending in `.py`.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateStarterFileName(raw) {
    let name = toSnakeFileName(raw);

    if (name === '') {
        return { ok: false, error: 'Enter a name for the file.' };
    }
    if (!name.includes('.')) {
        name += '.py';
    }
    if (!name.endsWith('.py')) {
        return { ok: false, error: 'Use a .py file name, for example main.py.' };
    }

    const stem = name.slice(0, -3);
    const check = validateProjectName(stem);
    if (!check.ok) {
        return check;
    }
    return { ok: true, name: name };
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/**
 * Subscribe to sync changes when the implementation offers it.
 *
 * @param {object | null | undefined} sync
 * @param {() => void} listener
 * @returns {() => void}
 */
function subscribe(sync, listener) {
    if (!sync || typeof sync.onStatus !== 'function') {
        return () => {};
    }
    try {
        const off = sync.onStatus(listener);
        if (typeof off === 'function') {
            return off;
        }
        if (off && typeof off.unsubscribe === 'function') {
            return () => off.unsubscribe();
        }
    } catch {
        // The screen still works from `update()`.
    }
    return () => {};
}

/**
 * A calm, human description of when a project was last edited.
 *
 * @param {number} updatedAt Milliseconds, or 0 when unknown.
 * @returns {string} An empty string when there is no date to show.
 */
export function editedLabel(updatedAt) {
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
        return '';
    }

    const then = new Date(updatedAt);
    if (Number.isNaN(then.getTime())) {
        return '';
    }

    const now = new Date();
    const startOfDay = (date) =>
        new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);

    if (days <= 0) {
        return 'today';
    }
    if (days === 1) {
        return 'yesterday';
    }
    if (days < 7) {
        return days + ' days ago';
    }
    return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    }).format(then);
}

/**
 * Flatten whatever `listProjects` returned into a sorted, deduplicated list.
 *
 * @param {unknown} value
 * @returns {Array<{ name: string, updatedAt: number, fileCount: number | null }>}
 */
function normaliseProjects(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set();
    const projects = [];

    for (const item of value) {
        let name = '';
        let updatedAt = 0;
        let fileCount = null;

        if (typeof item === 'string') {
            name = item;
        } else if (item && typeof item === 'object') {
            if (typeof item.name === 'string') {
                name = item.name;
            }
            if (Number.isFinite(item.updatedAt)) {
                updatedAt = item.updatedAt;
            }
            if (Number.isFinite(item.fileCount)) {
                fileCount = item.fileCount;
            }
        }

        name = name.trim();
        if (name === '' || seen.has(name)) {
            continue;
        }
        seen.add(name);
        projects.push({ name, updatedAt, fileCount });
    }

    // Newest first. Array.prototype.sort is stable, so equal dates keep the
    // vault's own ordering.
    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    return projects;
}

/**
 * Mount the home screen.
 *
 * @param {HTMLElement} root The container supplied by the page.
 * @param {{
 *   listProjects: () => Promise<unknown>,
 *   onOpen: (name: string) => void | Promise<void>,
 *   onCreate: (input: { project: string, file: string }) => void | Promise<void>,
 *   sync?: object | null,
 *   github?: boolean,
 * }} options
 * @returns {{ update: () => Promise<void>, focus: () => void, destroy: () => void }}
 */
export function mountHome(root, options) {
    if (!root) {
        throw new TypeError('mountHome needs a container element.');
    }

    const listProjects = typeof options?.listProjects === 'function'
        ? options.listProjects
        : async () => [];
    const onOpen = typeof options?.onOpen === 'function' ? options.onOpen : null;
    const onCreate = typeof options?.onCreate === 'function' ? options.onCreate : null;
    const sync = options?.sync || null;
    const showGithub = options?.github !== false;
    /** @type {((name: string) => Promise<void>) | undefined} */
    const onDelete = typeof options?.onDelete === 'function' ? options.onDelete : undefined;

    let destroyed = false;
    let projects = [];
    let query = '';
    let loading = true;
    let loadError = false;
    let creating = false;
    let loadToken = 0;

    /* Shell ------------------------------------------------------------- */

    root.classList.add('home-screen');
    root.textContent = '';

    const inner = el('div', 'home-inner');
    const head = el('div', 'home-head');
    const title = el('h1', 'home-title', 'Your work');
    const lede = el(
        'p',
        'home-lede',
        'Everything you write is kept on this device. Choose a project to carry on, or start a new one.',
    );
    head.append(title, lede);

    const toolbar = el('div', 'home-toolbar');
    const searchWrap = el('div', 'home-search');
    const searchLabel = el('label', 'home-label', 'Search projects');
    searchLabel.htmlFor = 'home-search-input';
    const search = el('input', 'home-search-input');
    search.type = 'search';
    search.id = 'home-search-input';
    search.placeholder = 'Search projects';
    search.autocomplete = 'off';
    search.spellcheck = false;
    searchWrap.append(searchLabel, search);

    const newBtn = el('button', 'home-primary', 'New project');
    newBtn.type = 'button';
    toolbar.append(searchWrap, newBtn);

    const panel = el('div', 'home-panel');
    const list = el('ul', 'home-list');
    list.setAttribute('aria-label', 'Projects');
    panel.appendChild(list);

    const githubRow = el('div', 'home-github');
    const githubDot = el('span', 'home-github-dot');
    githubDot.setAttribute('aria-hidden', 'true');
    const githubText = el('p', 'home-github-text');
    const githubBtn = el('button', 'home-github-btn', 'Connect GitHub');
    githubBtn.type = 'button';
    githubRow.append(githubDot, githubText, githubBtn);
    if (!showGithub) {
        githubRow.hidden = true;
    }

    const footer = el('div', 'home-foot');
    footer.appendChild(githubRow);

    inner.append(head, toolbar, panel, footer);
    root.appendChild(inner);

    /* Rendering --------------------------------------------------------- */

    function matches(project) {
        return query === '' || project.name.toLowerCase().includes(query);
    }

    function projectMeta(project) {
        const parts = [];
        const edited = editedLabel(project.updatedAt);
        if (edited !== '') {
            parts.push('Edited ' + edited);
        }
        if (project.fileCount !== null) {
            parts.push(
                project.fileCount === 1 ? '1 file' : project.fileCount + ' files',
            );
        }
        return parts.join(' · ');
    }

    function renderList() {
        list.textContent = '';

        if (loading) {
            const item = el('li', 'home-panel-note', 'Loading projects…');
            item.setAttribute('aria-live', 'polite');
            list.appendChild(item);
            return;
        }

        if (loadError) {
            const item = el(
                'li',
                'home-panel-note',
                'Projects could not be loaded. Your work is still on this device.',
            );
            item.setAttribute('role', 'alert');
            list.appendChild(item);
            return;
        }

        if (projects.length === 0) {
            const item = el('li', 'home-empty');
            const heading = el('h2', 'home-empty-title', 'Start with a project');
            const copy = el(
                'p',
                'home-empty-text',
                'A project holds the files for one piece of work. Create one and pydle opens its first file for you.',
            );
            const start = el('button', 'home-primary', 'Create your first project');
            start.type = 'button';
            start.addEventListener('click', () => { void startCreate(); });
            item.append(heading, copy, start);
            list.appendChild(item);
            return;
        }

        const visible = projects.filter(matches);
        if (visible.length === 0) {
            const item = el('li', 'home-empty home-empty-search');
            const text = el(
                'p',
                'home-empty-text',
                'No projects match “' + query + '”.',
            );
            const clear = el('button', 'home-quiet', 'Clear search');
            clear.type = 'button';
            clear.addEventListener('click', () => {
                search.value = '';
                query = '';
                renderList();
                search.focus({ preventScroll: true });
            });
            item.append(text, clear);
            list.appendChild(item);
            return;
        }

        for (const project of visible) {
            const item = el('li', 'home-item');
            const row = el('button', 'home-project');
            row.type = 'button';
            row.title = 'Open ' + project.name;
            row.setAttribute('aria-label', 'Open ' + project.name);

            const name = el('span', 'home-project-name', project.name);
            const meta = el('span', 'home-project-meta', projectMeta(project));
            row.append(name);
            if (meta.textContent !== '') {
                row.appendChild(meta);
            }

            row.addEventListener('click', () => {
                if (!onOpen) {
                    return;
                }
                row.disabled = true;
                try {
                    const result = onOpen(project.name);
                    if (result && typeof result.catch === 'function') {
                        result.catch(() => {
                            row.disabled = false;
                        });
                    }
                } catch {
                    row.disabled = false;
                }
            });

            const remove = el('button', 'home-project-delete', 'Delete');
            remove.type = 'button';
            remove.title = 'Delete ' + project.name;
            remove.setAttribute('aria-label', 'Delete ' + project.name);

            remove.addEventListener('click', async () => {
                if (!onDelete) {
                    return;
                }
                remove.disabled = true;
                remove.textContent = 'Deleting…';
                try {
                    await onDelete(project.name);
                } catch {
                    // The page reports why; the list is left as it was.
                } finally {
                    remove.disabled = false;
                    remove.textContent = 'Delete';
                    await update();
                }
            });

            item.appendChild(row);
            item.appendChild(remove);
            list.appendChild(item);
        }
    }

    function renderToolbar() {
        // With no projects at all, the empty state owns the primary action, so
        // the whole toolbar would be a second, competing one.
        const empty = !loadError && projects.length === 0;
        toolbar.hidden = empty;
        newBtn.hidden = empty;
        searchWrap.hidden = empty;
    }

    function renderGithub() {
        if (!showGithub) {
            return;
        }

        const status = typeof sync?.status === 'string' ? sync.status : 'signed-out';
        const login = typeof sync?.identity?.login === 'string' ? sync.identity.login : '';

        githubDot.dataset.state = status;

        let text = 'Not connected to GitHub. Projects are kept on this device.';
        let action = 'Connect GitHub';
        if (status === 'connecting') {
            text = 'Connecting to GitHub…';
            action = 'GitHub settings';
        } else if (status === 'connected') {
            text = login
                ? `Signed in as ${login}. Your work is also saved to GitHub.`
                : 'Signed in to GitHub. Your work is also saved to GitHub.';
            action = 'Manage GitHub';
        } else if (status === 'offline') {
            text = login
                ? `Offline as ${login}. Your work is saved on this device.`
                : 'Offline. Your work is saved on this device.';
            action = 'Manage GitHub';
        } else if (status === 'error') {
            text = 'Not connected to GitHub. Your work is safe on this device.';
            action = 'GitHub settings';
        }

        githubText.textContent = text;
        githubBtn.textContent = action;
    }

    function render() {
        if (destroyed) {
            return;
        }
        renderToolbar();
        renderList();
        renderGithub();
    }

    /* Naming ------------------------------------------------------------ */

    /**
     * Ask for a project name, then its first file, and hand both to the page.
     * One flow: cancelling either step creates nothing.
     */
    async function startCreate() {
        if (creating || !onCreate) {
            return;
        }

        creating = true;
        newBtn.disabled = true;

        try {
            const taken = new Set(projects.map((project) => project.name));
            const suggested = projects.length === 0 ? 'my_first_project' : '';

            const projectRaw = await promptText({
                title: 'New project',
                label: 'Project name',
                value: suggested,
                confirmLabel: 'Continue',
                hint: 'Lowercase letters, numbers and underscores, for example my_first_project.',
                transform: liveProjectName,
                preview: (value) => {
                    const check = validateProjectName(value);
                    return check.ok ? 'Project: ' + check.name : '';
                },
                validate: (value) => {
                    const check = validateProjectName(value);
                    if (!check.ok) {
                        return check.error;
                    }
                    if (taken.has(check.name)) {
                        return 'There is already a project called “' + check.name + '”.';
                    }
                    return null;
                },
            });
            if (projectRaw === null) {
                return;
            }
            const project = validateProjectName(projectRaw);
            if (!project.ok) {
                return;
            }

            const fileRaw = await promptText({
                title: 'First file',
                label: 'File name',
                value: 'main.py',
                confirmLabel: 'Create project',
                hint: 'Snake case, ending in .py. The first file starts with a small example.',
                transform: liveFileName,
                preview: (value) => {
                    const check = validateStarterFileName(value);
                    return check.ok ? 'File: ' + check.name : '';
                },
                validate: (value) => {
                    const check = validateStarterFileName(value);
                    return check.ok ? null : check.error;
                },
            });
            if (fileRaw === null) {
                return;
            }
            const file = validateStarterFileName(fileRaw);
            if (!file.ok) {
                return;
            }

            await onCreate({ project: project.name, file: file.name });
            await update();
        } finally {
            creating = false;
            newBtn.disabled = false;
            renderToolbar();
        }
    }

    /* Wiring ------------------------------------------------------------ */

    search.addEventListener('input', () => {
        query = search.value.trim().toLowerCase();
        renderList();
    });

    newBtn.addEventListener('click', () => { void startCreate(); });
    githubBtn.addEventListener('click', () => {
        root.dispatchEvent(new CustomEvent('pydle:open-sync', { bubbles: true }));
    });

    const unsubscribe = subscribe(sync, () => {
        renderGithub();
    });

    /**
     * Re-read the project list and repaint.
     *
     * @returns {Promise<void>}
     */
    async function update() {
        if (destroyed) {
            return;
        }
        const token = ++loadToken;
        loading = true;
        loadError = false;
        render();

        let value = [];
        let failed = false;
        try {
            value = await listProjects();
        } catch {
            failed = true;
        }

        if (destroyed || token !== loadToken) {
            return;
        }
        projects = failed ? [] : normaliseProjects(value);
        loading = false;
        loadError = failed;
        render();
    }

    function focus() {
        if (projects.length === 0) {
            const primary = root.querySelector('.home-primary');
            if (primary instanceof HTMLElement) {
                primary.focus({ preventScroll: true });
            }
            return;
        }
        search.focus({ preventScroll: true });
    }

    render();

    return {
        update,
        focus,
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            loadToken += 1;
            unsubscribe();
            root.textContent = '';
        },
    };
}
