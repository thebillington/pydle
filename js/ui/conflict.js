/**
 * The "which copy do you want?" dialog for files that changed in two places.
 *
 * `sync.commit()` reconciles before it commits. Most differences are safe to
 * settle on their own, but a file that moved on this device and on GitHub as
 * well cannot be guessed at. That is the one thing this dialog does: it shows
 * every such file, says in plain words what happened, and lets the student pick
 * a copy. The answer goes straight back into `sync.commit()`.
 *
 * There is no history rewriting behind any choice. Keeping the local copy is an
 * ordinary new commit; taking GitHub's copy replaces the file on this device.
 *
 * One dialog per page, mounted once:
 *
 *     const dialog = mountConflict(hostEl, {});
 *     const resolutions = await dialog.open({ project, conflicts });
 *     // resolutions is { [path]: 'local' | 'remote' }, or null when cancelled.
 *
 * Every value that comes from the vault or the network is written with
 * `textContent`, never `innerHTML`.
 */

let mountCount = 0;

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
 * A real button, so it is reachable and operable by keyboard.
 *
 * @param {string} label
 * @param {'primary' | 'quiet'} variant
 * @param {() => void} onClick
 * @param {{ disabled?: boolean }} [options]
 * @returns {HTMLButtonElement}
 */
function button(label, variant, onClick, { disabled = false } = {}) {
    const node = el('button', `sync-btn sync-btn-${variant}`, label);
    node.type = 'button';
    node.disabled = Boolean(disabled);
    node.addEventListener('click', onClick);
    return node;
}

/**
 * What happened, in words that do not assume any git knowledge.
 *
 * @param {string} kind
 * @returns {string}
 */
function explanation(kind) {
    switch (kind) {
        case 'deleted-here':
            return 'Deleted on this device, changed on GitHub.';
        case 'deleted-elsewhere':
            return 'Deleted on GitHub, changed on this device.';
        case 'both-changed':
        default:
            return 'Changed on this device and on GitHub.';
    }
}

/**
 * The label for the GitHub side of a row.
 *
 * When GitHub is the side that deleted the file, "Use GitHub's" would be
 * ambiguous, so the action says exactly what it does.
 *
 * @param {string} kind
 * @returns {string}
 */
function githubChoiceLabel(kind) {
    return kind === 'deleted-elsewhere' ? 'Delete it' : "Use GitHub's";
}

/**
 * Normalise one entry from the `conflicts` array, defensively.
 *
 * @param {unknown} value
 * @returns {{ path: string, kind: string, remoteHash: string | null } | null}
 */
function normaliseConflict(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const path = typeof value.path === 'string' ? value.path : '';
    if (path === '') {
        return null;
    }
    return {
        path,
        kind: typeof value.kind === 'string' ? value.kind : 'both-changed',
        remoteHash: typeof value.remoteHash === 'string' ? value.remoteHash : null,
    };
}

/**
 * Mount the dialog.
 *
 * @param {HTMLElement} root Container supplied by the caller. It is emptied.
 * @param {{ onClose?: () => void }} [handlers]
 * @returns {{
 *   open: (options: { project: string, conflicts: Array<{ path: string, kind: string, remoteHash: string | null }> }) => Promise<{ [path: string]: 'local' | 'remote' } | null>,
 *   close: () => void,
 *   destroy: () => void,
 * }}
 */
export function mountConflict(root, handlers = {}) {
    if (!root) {
        throw new TypeError('mountConflict needs a container element.');
    }

    const onClose = typeof handlers.onClose === 'function' ? handlers.onClose : null;

    const id = `conflict-${++mountCount}`;
    const titleId = `${id}-title`;
    const projectId = `${id}-project`;
    const ledeId = `${id}-lede`;
    const listLabelId = `${id}-list-label`;
    const consequenceId = `${id}-consequence`;

    /* Shell ------------------------------------------------------------- */

    const overlay = el('div', 'overlay conflict-overlay hidden');
    const backdrop = el('div', 'overlay-backdrop');

    const content = el('div', 'overlay-content conflict-dialog');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('aria-labelledby', titleId);
    content.setAttribute('aria-describedby', `${ledeId} ${consequenceId}`);
    content.tabIndex = -1;

    const header = el('div', 'overlay-header conflict-header');
    const heading = el('div', 'conflict-heading');
    const title = el('h2', '', 'Pick which version to keep');
    title.id = titleId;
    const projectLine = el('p', 'conflict-project', '');
    projectLine.id = projectId;
    heading.append(title, projectLine);

    const closeBtn = el('button', 'btn btn-close conflict-close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close without choosing');
    header.append(heading, closeBtn);

    const body = el('div', 'conflict-body');
    const footer = el('div', 'conflict-footer');
    content.append(header, body, footer);
    overlay.append(backdrop, content);
    root.replaceChildren(overlay);

    /* State ------------------------------------------------------------- */

    const state = {
        open: false,
        project: '',
        /** @type {Array<{ path: string, kind: string, remoteHash: string | null }>} */
        conflicts: [],
        /** @type {Map<string, 'local' | 'remote'>} */
        choices: new Map(),
    };

    /** @type {HTMLElement | null} */
    let returnFocus = null;
    /** @type {((value: { [path: string]: 'local' | 'remote' } | null) => void) | null} */
    let resolveOpen = null;

    /** @type {HTMLButtonElement | null} */
    let confirmBtn = null;
    /** @type {HTMLParagraphElement | null} */
    let completenessNote = null;
    /** @type {Map<string, HTMLElement>} */
    let choiceCards = new Map();

    /* Helpers ----------------------------------------------------------- */

    /**
     * @param {number} count
     * @returns {string}
     */
    function ledeText(count) {
        if (count === 1) {
            return 'This file changed in two places. Choose which copy to keep.';
        }
        return 'These files changed in two places. Choose which copy to keep for each one.';
    }

    /**
     * @param {number} missing
     * @returns {string}
     */
    function completenessText(missing) {
        if (missing === 0) {
            return 'Every file has a choice. Nothing has been changed yet.';
        }
        if (missing === 1) {
            return '1 file still needs a choice.';
        }
        return `${missing} files still need a choice.`;
    }

    function updateControls() {
        const missing = state.conflicts.filter((conflict) => !state.choices.has(conflict.path)).length;

        if (confirmBtn) {
            confirmBtn.disabled = missing > 0;
        }
        if (completenessNote) {
            completenessNote.textContent = completenessText(missing);
        }
    }

    /**
     * Paint the selected state onto a row's two cards.
     *
     * @param {string} path
     */
    function paintRow(path) {
        const cards = choiceCards.get(path);
        if (!cards) {
            return;
        }
        const chosen = state.choices.get(path);
        const local = cards.querySelector('[data-choice="local"]');
        const remote = cards.querySelector('[data-choice="remote"]');
        if (local) {
            local.classList.toggle('is-chosen', chosen === 'local');
        }
        if (remote) {
            remote.classList.toggle('is-chosen', chosen === 'remote');
        }
    }

    /**
     * Record a choice for one row without rebuilding the DOM.
     *
     * @param {string} path
     * @param {'local' | 'remote'} choice
     */
    function choose(path, choice) {
        state.choices.set(path, choice);
        paintRow(path);
        updateControls();
    }

    /**
     * @param {'local' | 'remote'} choice
     */
    function chooseAll(choice) {
        for (const conflict of state.conflicts) {
            state.choices.set(conflict.path, choice);
            const row = choiceCards.get(conflict.path);
            if (row) {
                const input = row.querySelector(`input[value="${choice}"]`);
                if (input instanceof HTMLInputElement) {
                    input.checked = true;
                }
            }
            paintRow(conflict.path);
        }
        updateControls();
    }

    /* Rendering --------------------------------------------------------- */

    /**
     * One file: what happened, then two clearly labelled choices.
     *
     * @param {{ path: string, kind: string }} conflict
     * @param {number} index
     * @returns {HTMLElement}
     */
    function renderRow(conflict, index) {
        const row = el('div', 'conflict-row');
        const pathId = `${id}-path-${index}`;
        const explainId = `${id}-explain-${index}`;
        const groupName = `${id}-choice-${index}`;

        const path = el('code', 'conflict-path', conflict.path);
        path.id = pathId;
        path.title = conflict.path;

        const explain = el('p', 'conflict-explain', explanation(conflict.kind));
        explain.id = explainId;

        const choices = el('div', 'conflict-choices');
        choices.setAttribute('role', 'radiogroup');
        choices.setAttribute('aria-labelledby', `${pathId} ${explainId}`);

        /**
         * @param {'local' | 'remote'} value
         * @param {string} label
         * @returns {HTMLLabelElement}
         */
        function option(value, label) {
            const card = /** @type {HTMLLabelElement} */ (el('label', 'conflict-choice'));
            card.dataset.choice = value;

            const input = /** @type {HTMLInputElement} */ (el('input', 'conflict-choice-input'));
            input.type = 'radio';
            input.name = groupName;
            input.value = value;
            input.checked = state.choices.get(conflict.path) === value;
            input.addEventListener('change', () => {
                if (input.checked) {
                    choose(conflict.path, value);
                }
            });

            card.append(input, el('span', 'conflict-choice-label', label));
            return card;
        }

        choices.append(option('local', 'Keep mine'), option('remote', githubChoiceLabel(conflict.kind)));

        row.append(path, explain, choices);
        choiceCards.set(conflict.path, choices);
        return row;
    }

    function render() {
        projectLine.textContent = state.project || 'This project';
        body.replaceChildren();
        footer.replaceChildren();
        confirmBtn = null;
        completenessNote = null;
        choiceCards = new Map();

        const lede = el('p', 'conflict-lede', ledeText(state.conflicts.length));
        lede.id = ledeId;

        const shortcuts = el('div', 'conflict-shortcuts');
        const shortcutLabel = el('span', 'conflict-shortcuts-label', 'All files at once:');
        const keepAll = button('Keep all mine', 'quiet', () => chooseAll('local'));
        const useAll = button('Use all from GitHub', 'quiet', () => chooseAll('remote'));
        keepAll.classList.add('sync-btn-small');
        useAll.classList.add('sync-btn-small');
        shortcuts.append(shortcutLabel, keepAll, useAll);

        const list = el('div', 'conflict-list');
        list.setAttribute('role', 'group');
        list.setAttribute('aria-labelledby', listLabelId);

        const listLabel = el('h3', 'sync-section-label conflict-list-label', 'Files changed in two places');
        listLabel.id = listLabelId;

        state.conflicts.forEach((conflict, index) => {
            list.append(renderRow(conflict, index));
        });

        const consequence = el(
            'p',
            'conflict-consequence',
            'Keeping your copy saves it as a new change. Using GitHub\'s replaces the copy on this device. Nothing already saved in your history is changed.',
        );
        consequence.id = consequenceId;

        body.append(lede, shortcuts, listLabel, list, consequence);

        completenessNote = el('p', 'conflict-completeness');
        completenessNote.setAttribute('aria-live', 'polite');

        const cancel = button('Cancel', 'quiet', () => finish(null));
        confirmBtn = button('Use these choices', 'primary', () => finish(collected()));

        footer.append(completenessNote, cancel, confirmBtn);

        updateControls();

        const first = list.querySelector('input[type="radio"]');
        if (first instanceof HTMLElement) {
            first.focus({ preventScroll: true });
        } else {
            content.focus({ preventScroll: true });
        }
    }

    /**
     * The answer, in the shape `sync.commit({ resolutions })` expects.
     *
     * @returns {{ [path: string]: 'local' | 'remote' }}
     */
    function collected() {
        /** @type {{ [path: string]: 'local' | 'remote' }} */
        const result = {};
        for (const conflict of state.conflicts) {
            const choice = state.choices.get(conflict.path);
            if (choice === 'local' || choice === 'remote') {
                result[conflict.path] = choice;
            }
        }
        return result;
    }

    /* Lifecycle --------------------------------------------------------- */

    /**
     * @param {{ [path: string]: 'local' | 'remote' } | null} value
     */
    function finish(value) {
        if (!state.open) {
            return;
        }

        state.open = false;

        overlay.classList.add('hidden');
        body.replaceChildren();
        footer.replaceChildren();
        confirmBtn = null;
        completenessNote = null;
        choiceCards = new Map();

        const resolve = resolveOpen;
        resolveOpen = null;
        const focus = returnFocus;
        returnFocus = null;

        if (focus && focus.isConnected && typeof focus.focus === 'function') {
            focus.focus({ preventScroll: true });
        }

        if (value === null && onClose) {
            try {
                onClose();
            } catch {
                // The dialog is already closed.
            }
        }

        if (resolve) {
            resolve(value);
        }
    }

    /* Interaction ------------------------------------------------------- */

    /**
     * All the controls a Tab press may land on, in DOM order.
     *
     * @returns {HTMLElement[]}
     */
    function focusables() {
        const nodes = content.querySelectorAll('button, input, a[href]');
        return [...nodes].filter((node) => {
            if (!(node instanceof HTMLElement)) {
                return false;
            }
            if (node.hasAttribute('disabled')) {
                return false;
            }
            return node.offsetParent !== null;
        });
    }

    /**
     * Escape cancels, Tab stays inside the dialog.
     *
     * @param {KeyboardEvent} event
     */
    function onKeydown(event) {
        if (!state.open) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(null);
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const items = focusables();
        if (items.length === 0) {
            event.preventDefault();
            content.focus({ preventScroll: true });
            return;
        }

        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;

        if (event.shiftKey) {
            if (active === first || !content.contains(active)) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            }
        } else if (active === last || !content.contains(active)) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }

    overlay.addEventListener('keydown', onKeydown);

    closeBtn.addEventListener('click', () => finish(null));

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target === backdrop) {
            finish(null);
        }
    });

    /* Public API -------------------------------------------------------- */

    /**
     * Show the dialog for one project.
     *
     * @param {{ project: string, conflicts: Array<{ path: string, kind: string, remoteHash: string | null }> }} options
     * @returns {Promise<{ [path: string]: 'local' | 'remote' } | null>}
     */
    function open({ project, conflicts } = {}) {
        const list = Array.isArray(conflicts)
            ? conflicts.map(normaliseConflict).filter(Boolean)
            : [];

        if (list.length === 0) {
            return Promise.resolve({});
        }

        if (state.open) {
            finish(null);
        }

        state.open = true;
        state.project = typeof project === 'string' ? project.trim() : '';
        state.conflicts = list;
        state.choices = new Map();
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        overlay.classList.remove('hidden');
        render();

        const promise = new Promise((resolve) => {
            resolveOpen = resolve;
        });
        return promise;
    }

    function close() {
        finish(null);
    }

    function destroy() {
        state.open = false;
        resolveOpen = null;
        overlay.remove();
    }

    return { open, close, destroy };
}
