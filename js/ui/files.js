/**
 * The file rail inside the editor panel.
 *
 * A project is a directory, not a single `main.py`, so the editor needs a way
 * to show and switch between the files in it. This module owns that list and
 * the quiet actions attached to it; it does no storage work itself. Everything
 * that reads or writes the vault is a callback into the page, which keeps the
 * vault seam (`js/sync.js`) out of the view layer.
 *
 * The pure helpers at the top are the rules for a file name and for choosing a
 * default file, exported so they can be tested without a DOM:
 *
 *   normalizeFileName('helpers')        -> 'helpers.py'
 *   normalizeFileName('../secrets.py')  -> null
 *   validateFileName('a.py', ['a.py'])  -> { ok: false, error: '…' }
 *   defaultFilePath(['main.py', …])     -> 'main.py'
 */

import { isReservedPath, normalizeProjectName, safeJoin } from '../vault/paths.js';
import { confirmAction, promptText } from './dialog.js';
import { splitDeclared } from '../packages.js';

/** A file name has to stay readable in the rail and on GitHub. */
const MAX_FILE_NAME = 120;

/** Remembers whether the rail was folded away, per browser. */
const COLLAPSED_KEY = 'pydle_file_rail_collapsed';

/**
 * The Libraries section's stylesheet, which also styles the picker.
 *
 * `index.html` is not this module's to edit, so the link is attached when the
 * rail mounts. The picker does the same check, so whichever mounts first wins
 * and the page never loads it twice.
 */
const LIBRARIES_STYLESHEET = new URL('../../css/libraries.css', import.meta.url).href;

function ensureLibrariesStylesheet() {
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    for (const link of links) {
        if (link instanceof HTMLLinkElement && link.href === LIBRARIES_STYLESHEET) {
            return;
        }
    }

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = LIBRARIES_STYLESHEET;
    stylesheet.dataset.pydleLibraries = '';
    document.head.appendChild(stylesheet);
}

/**
 * Turn what someone typed into a safe single file name.
 *
 * Rules, in the order they apply:
 * - trim surrounding whitespace;
 * - a name with no dot at all gets `.py`, so `helpers` becomes `helpers.py`;
 * - it must be one path segment: no `/`, no `\`, no `.` or `..` segments;
 * - no leading dot, no `..` anywhere, no trailing dot, no control characters;
 * - the reserved classroom namespaces stay out of reach.
 *
 * @param {unknown} raw What the prompt returned.
 * @returns {string | null} A usable name, or null when it is not one.
 */
export function normalizeFileName(raw) {
    if (typeof raw !== 'string') {
        return null;
    }

    let name = raw.trim();
    if (name === '') {
        return null;
    }
    if (isReservedPath(name)) {
        return null;
    }
    if (!name.includes('.')) {
        name += '.py';
    }
    if (name.length > MAX_FILE_NAME) {
        return null;
    }

    // One segment only. safeJoin would happily return `lib/helpers.py`, but the
    // rail lists a project's files, not a directory tree.
    if (name.includes('/') || name.includes('\\')) {
        return null;
    }

    let joined;
    try {
        joined = safeJoin(name);
    } catch {
        return null;
    }

    // safeJoin normalises, so anything that did not survive unchanged was not a
    // plain single file name (a slash, `./x`, an empty segment…).
    if (joined !== name) {
        return null;
    }
    if (name.startsWith('.') || name.endsWith('.') || name.includes('..')) {
        return null;
    }

    return name;
}

/**
 * Validate a proposed file name against the project's existing files.
 *
 * Comparison is case-insensitive: `Helpers.py` next to `helpers.py` is a
 * support question, not a second file. The caller renaming a file should pass
 * the list with the old name removed.
 *
 * @param {unknown} raw What the prompt returned.
 * @param {Iterable<string>} [existing] Names already in the project.
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateFileName(raw, existing = []) {
    const name = normalizeFileName(raw);
    if (name === null) {
        return {
            ok: false,
            error: 'Use a single file name, with no slashes, "..", or leading dot.',
        };
    }

    const taken = new Set();
    for (const file of existing) {
        taken.add(String(file).toLowerCase());
    }
    if (taken.has(name.toLowerCase())) {
        return { ok: false, error: `"${name}" is already in this project.` };
    }

    return { ok: true, name };
}

/**
 * Compare two paths by code point, for a stable alphabetical order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function comparePaths(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Which file to open when a project is opened.
 *
 * `main.py` is the entrypoint every existing project has, so it wins. Without
 * one, the alphabetically first Python file is a better guess than a README,
 * and only then does the first file of any kind do.
 *
 * @param {Iterable<string> | null | undefined} files File paths in the project.
 * @returns {string | null} The path to select, or null for an empty project.
 */
export function defaultFilePath(files) {
    if (!files) {
        return null;
    }

    const names = [...files].filter((name) => typeof name === 'string' && name !== '');
    if (names.length === 0) {
        return null;
    }
    if (names.includes('main.py')) {
        return 'main.py';
    }

    const python = names
        .filter((name) => name.toLowerCase().endsWith('.py'))
        .sort(comparePaths);
    if (python.length > 0) {
        return python[0];
    }

    return names.slice().sort(comparePaths)[0];
}

/**
 * Turn what someone typed at the save prompt into a project slug.
 *
 * The page does not import from the vault directly, so the one rule it needs
 * lives here beside the file-name rules.
 *
 * @param {unknown} raw
 * @returns {string | null} A slug, or null when nothing usable remains.
 */
export function projectSlug(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    try {
        return normalizeProjectName(raw);
    } catch {
        return null;
    }
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
 * A small inline chevron.
 *
 * @param {string} path SVG path data.
 * @returns {SVGElement}
 */
function chevron(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path);
    svg.appendChild(shape);
    return svg;
}

/**
 * Read the stored fold state, falling back to unfolded.
 *
 * @returns {boolean}
 */
function readCollapsed() {
    try {
        return window.localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * @param {boolean} collapsed
 */
function storeCollapsed(collapsed) {
    try {
        window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
        // A blocked storage partition just means the rail forgets.
    }
}

/**
 * Mount the file rail.
 *
 * The page supplies the behaviour; the rail supplies the list, the selection
 * and the prompts for names. Callbacks may return a promise; a rejection is
 * shown as a quiet note in the rail rather than an unhandled error.
 *
 * @param {HTMLElement} root Empty container for the rail.
 * @param {{
 *   onSelect?: (path: string) => void,
 *   onCreate?: (name: string) => void | Promise<void>,
 *   onRename?: (from: string, to: string) => void | Promise<void>,
 *   onDelete?: (path: string) => void | Promise<void>,
 *   onHome?: () => void,
 *   onAddLibrary?: () => void,
 * }} [handlers]
 */
export function mountFileRail(root, handlers = {}) {
    ensureLibrariesStylesheet();

    const state = {
        project: null,
        files: [],
        current: null,
        collapsed: readCollapsed(),
        libraries: [],
        hasRequirements: false,
        /** Files changed since the last commit, for the footer action. */
        uncommitted: 0,
        /** False when there is no repository to commit to. */
        canCommit: false,
    };

    root.classList.add('file-rail');
    root.textContent = '';

    /* Header ------------------------------------------------------------- */

    const head = el('div', 'file-rail-head');
    const projectLabel = el('button', 'file-rail-project', 'no project');
    projectLabel.type = 'button';
    projectLabel.addEventListener('click', () => {
        if (state.project !== null && typeof handlers.onHome === 'function') {
            handlers.onHome();
        }
    });
    const collapseBtn = el('button', 'file-rail-collapse');
    collapseBtn.type = 'button';
    collapseBtn.setAttribute('aria-controls', 'file-rail-body');
    collapseBtn.appendChild(chevron('M15 18l-6-6 6-6'));
    head.append(projectLabel, collapseBtn);

    /* List --------------------------------------------------------------- */

    const body = el('div', 'file-rail-body');
    body.id = 'file-rail-body';
    const list = el('ul', 'file-rail-list');
    list.setAttribute('aria-label', 'Files in this project');
    body.appendChild(list);

    /* Libraries ---------------------------------------------------------- */
    //
    // The list reports what requirements.txt declares. Choosing what goes into
    // that file is the picker's job; the page mounts it and hands it over through
    // onAddLibrary, so this module still does no storage work.

    const libraries = el('section', 'file-rail-libraries');
    const librariesHead = el('div', 'file-rail-libraries-head');
    const librariesTitle = el('h2', 'file-rail-section', 'Libraries');
    const addLibraryBtn = el('button', 'file-rail-add-library', 'Add');
    addLibraryBtn.type = 'button';
    addLibraryBtn.title = 'Add a library to this project';
    addLibraryBtn.addEventListener('click', () => {
        run(() => handlers.onAddLibrary && handlers.onAddLibrary());
    });
    librariesHead.append(librariesTitle, addLibraryBtn);

    const librariesList = el('ul', 'file-rail-library-list');
    librariesList.setAttribute('aria-label', 'Libraries in this project');
    const librariesEmpty = el('p', 'file-rail-library-empty', 'No libraries in this project');
    const librariesNote = el('p', 'file-rail-library-note', 'Use Add to choose a library for this project.');
    libraries.append(librariesHead, librariesList, librariesEmpty, librariesNote);

    const notice = el('p', 'file-rail-notice');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    /* Footer ------------------------------------------------------------- */

    const foot = el('div', 'file-rail-foot');
    const newBtn = el('button', 'file-rail-new');
    newBtn.type = 'button';
    newBtn.title = 'New file in this project';
    newBtn.append(
        el('span', 'file-rail-plus', '+'),
        el('span', 'file-rail-new-label', 'New file'),
    );
    const commitBtn = el('button', 'file-rail-commit');
    commitBtn.type = 'button';
    commitBtn.title = 'Put this project\u2019s changes in GitHub';
    commitBtn.append(
        el('span', 'file-rail-commit-label', 'Commit'),
        el('span', 'file-rail-commit-count'),
    );
    commitBtn.hidden = true;

    // Beside Commit, and shown under the same conditions: throwing work away is
    // only meaningful when there is work that could be committed.
    const discardBtn = el('button', 'file-rail-discard', 'Discard');
    discardBtn.type = 'button';
    discardBtn.hidden = true;
    discardBtn.title = 'Throw away changes that are not in GitHub';
    discardBtn.addEventListener('click', () => {
        if (typeof handlers.onDiscard === 'function') {
            run(() => handlers.onDiscard());
        }
    });
    commitBtn.addEventListener('click', () => {
        if (typeof handlers.onCommit === 'function') {
            run(() => handlers.onCommit());
        }
    });
    foot.append(discardBtn, commitBtn);

    // Under the files it adds to, so the two read as one thing.
    body.appendChild(newBtn);

    root.append(head, body, libraries, notice, foot);

    /* Overflow menu ------------------------------------------------------ */

    const menu = el('div', 'file-rail-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const renameItem = el('button', 'file-rail-menu-item', 'Rename');
    renameItem.type = 'button';
    renameItem.setAttribute('role', 'menuitem');
    const deleteItem = el('button', 'file-rail-menu-item file-rail-menu-danger', 'Delete');
    deleteItem.type = 'button';
    deleteItem.setAttribute('role', 'menuitem');
    menu.append(renameItem, deleteItem);
    document.body.appendChild(menu);

    /** @type {{ path: string, anchor: HTMLElement } | null} */
    let openMenu = null;

    function closeMenu() {
        if (!openMenu) {
            return;
        }
        menu.hidden = true;
        openMenu.anchor.setAttribute('aria-expanded', 'false');
        openMenu = null;
        document.removeEventListener('pointerdown', onOutside, true);
        window.removeEventListener('resize', closeMenu);
        window.removeEventListener('scroll', onScroll, true);
        document.removeEventListener('keydown', onMenuKey, true);
    }

    /**
     * A scroll only invalidates the menu when it moves the row it is pinned to.
     *
     * @param {Event} event
     */
    function onScroll(event) {
        if (!openMenu) {
            return;
        }
        const target = event.target;
        const anchor = openMenu.anchor;
        if (
            target === document ||
            target === window ||
            (target instanceof Element && target.contains(anchor))
        ) {
            closeMenu();
        }
    }

    /** @param {PointerEvent} event */
    function onOutside(event) {
        if (!openMenu) {
            return;
        }
        if (menu.contains(/** @type {Node} */ (event.target))) {
            return;
        }
        if (openMenu.anchor.contains(/** @type {Node} */ (event.target))) {
            return;
        }
        closeMenu();
    }

    /** @param {KeyboardEvent} event */
    function onMenuKey(event) {
        if (event.key !== 'Escape' || !openMenu) {
            return;
        }
        const anchor = openMenu.anchor;
        event.stopPropagation();
        closeMenu();
        anchor.focus({ preventScroll: true });
    }

    /**
     * @param {string} path
     * @param {HTMLElement} anchor
     */
    function showMenu(path, anchor) {
        closeMenu();
        openMenu = { path, anchor };
        menu.hidden = false;
        anchor.setAttribute('aria-expanded', 'true');

        const rect = anchor.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
        const below = rect.bottom + 4;
        const top = below + height > window.innerHeight - 8 ? rect.top - height - 4 : below;
        menu.style.left = `${left}px`;
        menu.style.top = `${Math.max(8, top)}px`;

        renameItem.focus({ preventScroll: true });
        document.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('resize', closeMenu);
        window.addEventListener('scroll', onScroll, true);
        document.addEventListener('keydown', onMenuKey, true);
    }

    /* Notices ------------------------------------------------------------ */

    /** @param {string} text */
    function setNotice(text) {
        notice.textContent = text;
    }

    /**
     * Run a handler, surfacing a failure in the rail.
     *
     * @param {(() => void | Promise<void>) | undefined} fn
     */
    function run(fn) {
        if (typeof fn !== 'function') {
            return;
        }
        setNotice('');
        try {
            const result = fn();
            if (result && typeof result.then === 'function') {
                result.catch((error) => {
                    setNotice(error && error.message ? error.message : 'That did not work.');
                });
            }
        } catch (error) {
            setNotice(error && error.message ? error.message : 'That did not work.');
        }
    }

    /* Actions ------------------------------------------------------------ */

    async function promptNew() {
        const raw = await promptText({
            title: 'New file',
            label: 'File name',
            value: 'helpers.py',
            confirmLabel: 'Create file',
            hint: 'One file name, no slashes. A name without a dot gets .py.',
            validate: (value) => {
                const check = validateFileName(value, state.files);
                return check.ok ? null : check.error;
            },
        });
        if (raw === null) {
            return;
        }
        const result = validateFileName(raw, state.files);
        if (!result.ok) {
            // The dialog already showed this inline; keep the rail quiet.
            return;
        }
        run(() => handlers.onCreate && handlers.onCreate(result.name));
    }

    /** @param {string} path */
    async function promptRename(path) {
        const others = state.files.filter((file) => file !== path);
        const raw = await promptText({
            title: 'Rename file',
            label: 'File name',
            value: path,
            confirmLabel: 'Rename',
            hint: 'One file name, with no slashes.',
            validate: (value) => {
                const check = validateFileName(value, others);
                return check.ok ? null : check.error;
            },
        });
        if (raw === null) {
            return;
        }
        const result = validateFileName(raw, others);
        if (!result.ok) {
            return;
        }
        if (result.name === path) {
            setNotice('');
            return;
        }
        run(() => handlers.onRename && handlers.onRename(path, result.name));
    }

    /** @param {string} path */
    async function askDelete(path) {
        if (state.files.length <= 1) {
            setNotice('A project needs at least one file. Delete the project instead.');
            return;
        }
        const ok = await confirmAction({
            title: 'Delete this file?',
            message: `“${path}” will be deleted from ${state.project || 'this project'}. This cannot be undone.`,
            confirmLabel: 'Delete file',
            danger: true,
        });
        if (!ok) {
            return;
        }
        run(() => handlers.onDelete && handlers.onDelete(path));
    }

    /* Rendering ---------------------------------------------------------- */

    /**
     * The footer's commit action.
     *
     * Hidden when there is nothing to commit or nowhere to commit to, so it reads as
     * an offer rather than a permanent button that does nothing.
     */
    function renderCommit() {
        const count = state.uncommitted;
        // Nothing to commit, or nowhere to commit to: no button, and no
        // explanation of a button that is not there.
        const show = state.canCommit && count > 0 && state.project !== null;
        commitBtn.hidden = !show;
        discardBtn.hidden = !show;
        if (!show) {
            return;
        }

        const label = `Commit ${count} ${count === 1 ? 'file' : 'files'} to GitHub`;
        commitBtn.title = label;
        commitBtn.setAttribute('aria-label', label);
        commitBtn.querySelector('.file-rail-commit-count').textContent = String(count);
    }

    function renderCollapsed() {
        root.classList.toggle('is-collapsed', state.collapsed);
        collapseBtn.title = state.collapsed ? 'Show files' : 'Hide files';
        collapseBtn.setAttribute('aria-label', collapseBtn.title);
        collapseBtn.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true');
    }

    function render() {
        projectLabel.textContent = state.project || 'no project';
        projectLabel.disabled = state.project === null;
        projectLabel.title = state.project ? 'Back to your work' : 'No project open';
        projectLabel.setAttribute(
            'aria-label',
            state.project ? 'Back to your work. Close ' + state.project + '.' : 'No project open',
        );

        renderCommit();

        list.textContent = '';
        for (const path of state.files) {
            const item = el('li', 'file-rail-item');
            item.dataset.path = path;
            item.classList.toggle('is-current', path === state.current);

            const fileBtn = el('button', 'file-rail-file');
            fileBtn.type = 'button';
            fileBtn.title = path;
            if (path === state.current) {
                fileBtn.setAttribute('aria-current', 'true');
            }
            fileBtn.appendChild(el('span', 'file-rail-name', path));
            fileBtn.addEventListener('click', () => {
                closeMenu();
                setNotice('');
                if (path !== state.current) {
                    run(() => handlers.onSelect && handlers.onSelect(path));
                }
            });

            const moreBtn = el('button', 'file-rail-more', '\u22ef');
            moreBtn.type = 'button';
            moreBtn.title = `Actions for ${path}`;
            moreBtn.setAttribute('aria-label', `Actions for ${path}`);
            moreBtn.setAttribute('aria-haspopup', 'menu');
            moreBtn.setAttribute('aria-expanded', 'false');
            moreBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                if (openMenu && openMenu.path === path) {
                    closeMenu();
                } else {
                    showMenu(path, moreBtn);
                }
            });

            item.append(fileBtn, moreBtn);
            list.appendChild(item);
        }

        if (state.files.length === 0) {
            const empty = el('li', 'file-rail-empty');
            empty.textContent = state.project
                ? 'No files yet.'
                : 'No project open. Pick one from the list to start writing Python.';
            list.appendChild(empty);
        }

        newBtn.disabled = state.project === null;
        newBtn.title = state.project
            ? 'New file in this project'
            : 'Open a project to add files';

        libraries.hidden = state.project === null;
        librariesList.textContent = '';
        // The same rule the loader uses, so the rail cannot claim a library is
        // available when the worker will refuse it.
        const refusedNames = new Set(splitDeclared(state.libraries).refused);
        for (const library of state.libraries) {
            const item = el('li', 'file-rail-library');
            item.append(el('span', 'file-rail-library-name', library));

            // A name written into requirements.txt by hand that is not offered.
            // Saying so here as well as in the console, because this is where the
            // student will look to see what the project depends on.
            if (refusedNames.has(library)) {
                item.classList.add('is-unavailable');
                item.append(el('span', 'file-rail-library-flag', 'not available'));
                item.title =
                    library +
                    ' is not one of the libraries pydle offers, so it is not loaded.';
            }

            librariesList.appendChild(item);
        }
        const declared = state.libraries.length > 0;
        librariesList.hidden = !declared;
        librariesEmpty.hidden = !state.project || declared;
        librariesEmpty.textContent = state.hasRequirements
            ? 'No libraries declared yet'
            : 'No libraries in this project';
        librariesNote.hidden = !state.project || declared;

        renderCollapsed();
    }

    collapseBtn.addEventListener('click', () => {
        state.collapsed = !state.collapsed;
        storeCollapsed(state.collapsed);
        renderCollapsed();
        if (!state.collapsed) {
            const current = list.querySelector('.file-rail-item.is-current .file-rail-file');
            if (current instanceof HTMLElement) {
                current.focus({ preventScroll: true });
            }
        }
    });

    newBtn.addEventListener('click', () => { void promptNew(); });
    renameItem.addEventListener('click', () => {
        if (!openMenu) return;
        const path = openMenu.path;
        const anchor = openMenu.anchor;
        closeMenu();
        // The menu is hidden, so return focus to the row's own button first:
        // that is what the dialog should hand focus back to on close.
        anchor.focus({ preventScroll: true });
        void promptRename(path);
    });
    deleteItem.addEventListener('click', () => {
        if (!openMenu) return;
        const path = openMenu.path;
        const anchor = openMenu.anchor;
        closeMenu();
        anchor.focus({ preventScroll: true });
        void askDelete(path);
    });

    render();

    /**
     * Replace what the rail shows.
     *
     * @param {{
     *   project?: string | null,
     *   files?: string[],
     *   current?: string | null,
     *   libraries?: string[],
     *   hasRequirements?: boolean,
     * }} next
     */
    function setState({
        project,
        files,
        current,
        libraries: nextLibraries,
        hasRequirements,
        uncommitted,
        canCommit,
    } = {}) {
        if (project !== undefined) {
            state.project = project;
        }
        if (files !== undefined) {
            state.files = Array.isArray(files) ? files.slice() : [];
        }
        if (current !== undefined) {
            state.current = current;
        }
        if (uncommitted !== undefined) {
            state.uncommitted = Number.isFinite(uncommitted) ? Math.max(0, uncommitted) : 0;
        }
        if (canCommit !== undefined) {
            state.canCommit = Boolean(canCommit);
        }
        if (nextLibraries !== undefined) {
            state.libraries = Array.isArray(nextLibraries) ? nextLibraries.slice() : [];
        }
        if (hasRequirements !== undefined) {
            state.hasRequirements = Boolean(hasRequirements);
        }
        setNotice('');
        render();
    }

    return {
        setState,
        /** @param {string | null} path */
        setCurrent(path) {
            setState({ current: path });
        },
        /** @param {boolean} collapsed */
        setCollapsed(collapsed) {
            state.collapsed = Boolean(collapsed);
            storeCollapsed(state.collapsed);
            renderCollapsed();
        },
        getCollapsed() {
            return state.collapsed;
        },
        focus() {
            const current = list.querySelector('.file-rail-item.is-current .file-rail-file');
            if (current instanceof HTMLElement) {
                current.focus({ preventScroll: true });
            }
        },
        destroy() {
            closeMenu();
            menu.remove();
            root.textContent = '';
        },
    };
}
