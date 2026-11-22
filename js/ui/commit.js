/**
 * The commit dialog: choose the files, write the message, commit.
 *
 * This is the only route from the editor to GitHub, and it stays deliberately
 * manual. It knows nothing about git: `sync.dirty()` says what has changed and
 * `sync.commit()` does the work, so the view is just a list, a message field and
 * one primary action.
 *
 * There is one dialog per page, mounted once. `open(project)` returns a promise
 * that resolves when the dialog closes:
 *
 *     'committed'  the commit succeeded and `onCommitted` has been told
 *     'discarded'  the user chose to leave without committing (guard mode)
 *     'cancelled'  the dialog was dismissed; nothing changed
 *
 * That promise is what lets the page guard a file or project switch: it can
 * wait for the dialog before it settles on an answer.
 *
 * Every value that comes from the vault or the network is written with
 * `textContent`, never `innerHTML`.
 */

/** Above this many files the list earns a select-all control. */
const SELECT_ALL_THRESHOLD = 4;

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
 * @param {'primary' | 'quiet' | 'danger'} variant
 * @param {() => void} onClick
 * @param {{ disabled?: boolean, ariaLabel?: string }} [options]
 * @returns {HTMLButtonElement}
 */
function button(label, variant, onClick, { disabled = false, ariaLabel } = {}) {
    const node = el('button', `sync-btn sync-btn-${variant}`, label);
    node.type = 'button';
    node.disabled = Boolean(disabled);
    if (ariaLabel) {
        node.setAttribute('aria-label', ariaLabel);
    }
    node.addEventListener('click', onClick);
    return node;
}

/**
 * Turn any thrown value into an Error without leaking a stack trace into the DOM.
 *
 * @param {unknown} value
 * @returns {Error & { kind?: string }}
 */
function toError(value) {
    if (value instanceof Error) {
        return value;
    }
    if (value && typeof value === 'object' && typeof value.message === 'string') {
        const error = new Error(value.message);
        if (typeof value.kind === 'string') {
            error.kind = value.kind;
        }
        return error;
    }
    return new Error('Something went wrong. Nothing was lost.');
}

/**
 * @param {unknown} value
 * @returns {'added' | 'modified' | 'deleted' | 'changed'}
 */
function statusLabel(value) {
    return value === 'added' || value === 'modified' || value === 'deleted' ? value : 'changed';
}

/**
 * @param {unknown} entry
 * @returns {entry is { path: string, status: string }}
 */
function isChange(entry) {
    return Boolean(entry) && typeof entry === 'object' && typeof entry.path === 'string' && entry.path !== '';
}

/**
 * The one sentence offered beneath a failed commit, chosen by `SyncError.kind`.
 *
 * @param {Error & { kind?: string }} error
 * @returns {string}
 */
function recoveryHint(error) {
    switch (error.kind) {
        case 'auth':
            return 'Reconnect in Your work, then try again.';
        case 'conflict':
            return 'Another device committed first. Nothing was lost, so try again.';
        default:
            return '';
    }
}

/**
 * Mount the commit dialog.
 *
 * @param {HTMLElement} root Container supplied by the caller. It is emptied.
 * @param {object} sync The `Sync` object from `js/sync.js`.
 * @param {{
 *   onCommitted?: (result: { sha: string, message: string, project: string, paths: string[] }) => void,
 *   onClose?: () => void,
 * }} [handlers]
 * @returns {{
 *   open: (project: string, options?: { leaving?: boolean }) => Promise<'committed' | 'discarded' | 'cancelled'>,
 *   close: () => void,
 *   destroy: () => void,
 * }}
 */
export function mountCommit(root, sync, handlers = {}) {
    if (!root) {
        throw new TypeError('mountCommit needs a container element.');
    }

    const onCommitted = typeof handlers.onCommitted === 'function' ? handlers.onCommitted : null;
    const onClose = typeof handlers.onClose === 'function' ? handlers.onClose : null;

    const id = `commit-${++mountCount}`;
    const titleId = `${id}-title`;
    const projectId = `${id}-project`;
    const messageId = `${id}-message`;
    const filesLabelId = `${id}-files`;

    /* Shell ------------------------------------------------------------- */

    const overlay = el('div', 'overlay commit-overlay hidden');
    const backdrop = el('div', 'overlay-backdrop');

    const content = el('div', 'overlay-content commit-dialog');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('aria-labelledby', titleId);
    content.setAttribute('aria-describedby', projectId);
    content.tabIndex = -1;

    const header = el('div', 'overlay-header');
    const heading = el('div', 'commit-heading');
    const title = el('h2', '', 'Commit your work');
    title.id = titleId;
    const projectLine = el('p', 'commit-project', '');
    projectLine.id = projectId;
    heading.append(title, projectLine);

    const closeBtn = el('button', 'btn btn-close commit-close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    header.append(heading, closeBtn);

    const body = el('div', 'commit-body');
    const footer = el('div', 'commit-footer');
    content.append(header, body, footer);
    overlay.append(backdrop, content);
    root.replaceChildren(overlay);

    /* State ------------------------------------------------------------- */

    const state = {
        open: false,
        project: '',
        /** @type {'idle' | 'loading' | 'ready' | 'clean' | 'load-error'} */
        phase: 'idle',
        leaving: false,
        /** @type {Array<{ path: string, status: string }>} */
        paths: [],
        /** @type {Set<string>} */
        selected: new Set(),
        message: '',
        busy: false,
        /** @type {(Error & { kind?: string }) | null} */
        error: null,
        /** Bumped on open/close so a late `dirty()` cannot repaint a dead dialog. */
        token: 0,
    };

    /** @type {HTMLElement | null} */
    let returnFocus = null;
    /** @type {((outcome: string) => void) | null} */
    let resolveOpen = null;

    /* Rebuilt on every render; the state above holds anything worth keeping. */
    /** @type {HTMLInputElement | null} */
    let selectAllInput = null;
    /** @type {HTMLButtonElement | null} */
    let submitBtn = null;
    /** @type {HTMLTextAreaElement | null} */
    let messageInput = null;
    /** @type {Map<string, HTMLInputElement>} */
    let checkboxes = new Map();

    /* Helpers ----------------------------------------------------------- */

    /**
     * @param {number} count
     * @returns {string}
     */
    function submitLabel(count) {
        return count === 1 ? 'Commit 1 file' : `Commit ${count} files`;
    }

    function readyToSubmit() {
        return !state.busy && state.selected.size > 0 && state.message.trim() !== '';
    }

    /**
     * Keep the primary button, the select-all state and the disabled controls
     * honest without rebuilding the DOM, so typing and ticking never move the
     * caret.
     */
    function updateControls() {
        const count = state.selected.size;

        if (submitBtn) {
            submitBtn.textContent = state.busy ? 'Committing\u2026' : submitLabel(count);
            submitBtn.disabled = !readyToSubmit();
        }

        if (selectAllInput) {
            selectAllInput.checked = count > 0 && count === state.paths.length;
            selectAllInput.indeterminate = count > 0 && count < state.paths.length;
        }

        if (messageInput) {
            messageInput.disabled = state.busy;
        }
    }

    /**
     * All the controls a Tab press may land on, in DOM order.
     *
     * @returns {HTMLElement[]}
     */
    function focusables() {
        const nodes = content.querySelectorAll('button, textarea, input, a[href]');
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

    /* Rendering --------------------------------------------------------- */

    function renderLoading() {
        const note = el('p', 'commit-loading', `Looking for changes in ${state.project}\u2026`);
        note.setAttribute('aria-live', 'polite');
        body.append(note);
        footer.append(button('Cancel', 'quiet', () => finish('cancelled')));
    }

    function renderLoadError() {
        const section = el('section', 'commit-section');
        const note = el(
            'p',
            'sync-note sync-note-error',
            state.error ? state.error.message : 'The changes could not be read.',
        );
        note.setAttribute('role', 'alert');

        section.append(
            el('p', 'sync-lede', 'That did not work.'),
            note,
            el('p', 'sync-meta', 'Your work is still on this device. Nothing was lost.'),
        );
        body.append(section);

        footer.append(
            button('Cancel', 'quiet', () => finish('cancelled')),
            button('Try again', 'primary', () => {
                void load(state.project);
            }),
        );
    }

    function renderClean() {
        const section = el('section', 'commit-section commit-empty');
        section.append(
            el('p', 'sync-lede', 'Nothing to commit.'),
            el(
                'p',
                'sync-text',
                `${state.project} is already committed. There are no changes since the last commit.`,
            ),
        );
        body.append(section);
        footer.append(button('Close', 'quiet', () => finish('cancelled')));
    }

    /**
     * @param {{ path: string, status: string }} entry
     * @returns {HTMLLabelElement}
     */
    function renderFileRow(entry) {
        const label = /** @type {HTMLLabelElement} */ (el('label', 'commit-file'));
        const checkbox = /** @type {HTMLInputElement} */ (el('input', 'commit-file-check'));
        checkbox.type = 'checkbox';
        checkbox.checked = state.selected.has(entry.path);
        checkbox.disabled = state.busy;

        const path = el('span', 'commit-file-path', entry.path);
        path.title = entry.path;

        const status = statusLabel(entry.status);
        const badge = el('span', `commit-file-status commit-file-status-${status}`, status);
        badge.setAttribute('aria-label', `Status: ${status}`);

        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                state.selected.add(entry.path);
            } else {
                state.selected.delete(entry.path);
            }
            updateControls();
        });

        checkboxes.set(entry.path, checkbox);
        label.append(checkbox, path, badge);
        return label;
    }

    function renderReady() {
        if (state.leaving) {
            // The escape hatch is inline rather than a red footer button: leaving
            // without committing deletes nothing, so it should not be styled as a
            // destructive action.
            const guard = el('p', 'commit-guard');
            guard.append(
                document.createTextNode(
                    `You have uncommitted changes in ${state.project}. Commit them before you go, or `,
                ),
            );
            const leave = el('button', 'commit-guard-link', 'leave without committing');
            leave.type = 'button';
            leave.disabled = Boolean(state.busy);
            leave.title = 'Your files stay on this device. Nothing is deleted.';
            leave.setAttribute(
                'aria-label',
                'Leave without committing. Your files stay on this device.',
            );
            leave.addEventListener('click', () => finish('discarded'));
            guard.append(leave, document.createTextNode(' and carry on.'));
            body.append(guard);
        }

        if (state.error) {
            const section = el('section', 'commit-section commit-section-error');
            const note = el('p', 'sync-note sync-note-error', state.error.message);
            note.setAttribute('role', 'alert');
            section.append(note);

            const hint = recoveryHint(state.error);
            if (hint) {
                section.append(el('p', 'sync-meta', hint));
            }
            body.append(section);
        }

        const filesSection = el('section', 'commit-section commit-section-files');
        const head = el('div', 'commit-section-head');
        const filesLabel = el('h3', 'sync-section-label', 'Files');
        filesLabel.id = filesLabelId;
        head.append(filesLabel);

        if (state.paths.length > SELECT_ALL_THRESHOLD) {
            const selectAllLabel = el('label', 'commit-select-all');
            selectAllInput = /** @type {HTMLInputElement} */ (el('input', 'commit-select-all-box'));
            selectAllInput.type = 'checkbox';
            selectAllInput.disabled = state.busy;
            selectAllInput.addEventListener('change', () => {
                state.selected = new Set(
                    selectAllInput && selectAllInput.checked ? state.paths.map((entry) => entry.path) : [],
                );
                for (const [path, box] of checkboxes) {
                    box.checked = state.selected.has(path);
                }
                updateControls();
            });
            selectAllLabel.append(selectAllInput, document.createTextNode('Select all'));
            head.append(selectAllLabel);
        }

        filesSection.append(head);

        const list = el('div', 'commit-file-list');
        list.setAttribute('role', 'group');
        list.setAttribute('aria-labelledby', filesLabelId);
        for (const entry of state.paths) {
            list.append(renderFileRow(entry));
        }
        filesSection.append(list);
        body.append(filesSection);

        const messageSection = el('section', 'commit-section commit-section-message');
        const messageLabel = el('label', 'sync-section-label commit-message-label', 'Message');
        messageLabel.setAttribute('for', messageId);

        messageInput = /** @type {HTMLTextAreaElement} */ (el('textarea', 'commit-message'));
        messageInput.id = messageId;
        messageInput.rows = 3;
        messageInput.value = state.message;
        messageInput.disabled = state.busy;
        messageInput.setAttribute('aria-required', 'true');
        messageInput.addEventListener('input', () => {
            state.message = messageInput ? messageInput.value : '';
            updateControls();
        });

        messageSection.append(
            messageLabel,
            messageInput,
            el('p', 'commit-hint', 'A short note about what changed, and why.'),
        );
        body.append(messageSection);

        footer.append(
            button('Cancel', 'quiet', () => finish('cancelled'), { disabled: state.busy }),
            (() => {
                submitBtn = button(submitLabel(state.selected.size), 'primary', () => {
                    void submit();
                });
                return submitBtn;
            })(),
        );

        updateControls();
    }

    function render() {
        projectLine.textContent = state.project || 'This project';
        content.setAttribute('aria-busy', state.busy ? 'true' : 'false');
        closeBtn.disabled = state.busy;

        body.replaceChildren();
        footer.replaceChildren();
        messageInput = null;
        selectAllInput = null;
        submitBtn = null;
        checkboxes = new Map();

        if (state.phase === 'loading') {
            renderLoading();
        } else if (state.phase === 'load-error') {
            renderLoadError();
        } else if (state.phase === 'clean') {
            renderClean();
        } else if (state.phase === 'ready') {
            renderReady();
        }
    }

    /* Lifecycle --------------------------------------------------------- */

    /**
     * Hide the dialog and settle the promise `open()` handed out.
     *
     * @param {'committed' | 'discarded' | 'cancelled'} outcome
     * @param {{ sha?: string, message?: string, project?: string, paths?: string[] } | null} [result]
     */
    function finish(outcome, result = null) {
        if (!state.open) {
            return;
        }

        state.open = false;
        state.token += 1;
        state.busy = false;
        state.phase = 'idle';
        state.error = null;

        overlay.classList.add('hidden');
        content.setAttribute('aria-busy', 'false');
        closeBtn.disabled = false;
        body.replaceChildren();
        footer.replaceChildren();

        const resolve = resolveOpen;
        resolveOpen = null;
        const focus = returnFocus;
        returnFocus = null;

        if (focus && focus.isConnected && typeof focus.focus === 'function') {
            focus.focus({ preventScroll: true });
        }

        if (result && onCommitted) {
            try {
                onCommitted({
                    sha: result.sha || '',
                    message: result.message || '',
                    project: result.project || state.project,
                    paths: Array.isArray(result.paths) ? result.paths : [],
                });
            } catch {
                // A broken handler must not leave the dialog half-open.
            }
        } else if (!result && onClose) {
            try {
                onClose();
            } catch {
                // Same: the dialog is already closed.
            }
        }

        if (resolve) {
            resolve(outcome);
        }
    }

    /**
     * Read what has changed and build the list.
     *
     * @param {string} project
     */
    async function load(project) {
        const token = ++state.token;
        state.project = project;
        state.phase = 'loading';
        state.error = null;
        state.paths = [];
        state.selected = new Set();
        render();
        content.focus({ preventScroll: true });

        let report;
        try {
            report = await sync.dirty(project);
        } catch (error) {
            if (!state.open || token !== state.token) {
                return;
            }
            state.error = toError(error);
            state.phase = 'load-error';
            render();
            focusFirstAction();
            return;
        }

        if (!state.open || token !== state.token) {
            return;
        }

        const entries = Array.isArray(report && report.paths) ? report.paths.filter(isChange) : [];
        state.paths = entries.map((entry) => ({
            path: entry.path,
            status: statusLabel(entry.status),
        }));
        state.selected = new Set(state.paths.map((entry) => entry.path));
        state.phase = state.paths.length === 0 ? 'clean' : 'ready';
        render();

        if (state.phase === 'ready' && messageInput) {
            messageInput.focus({ preventScroll: true });
        } else {
            focusFirstAction();
        }
    }

    /** Put the keyboard on the first real control, never on a dead dialog. */
    function focusFirstAction() {
        const target =
            footer.querySelector('.sync-btn-primary') ||
            footer.querySelector('button') ||
            focusables()[0];
        if (target instanceof HTMLElement) {
            target.focus({ preventScroll: true });
        } else {
            content.focus({ preventScroll: true });
        }
    }

    /** Commit the ticked files. */
    async function submit() {
        if (state.busy || !state.open || !readyToSubmit()) {
            return;
        }

        const project = state.project;
        const paths = state.paths
            .map((entry) => entry.path)
            .filter((path) => state.selected.has(path));
        const message = state.message.trim();

        state.busy = true;
        state.error = null;
        render();
        content.focus({ preventScroll: true });

        let result;
        try {
            result = await sync.commit({ project, paths, message });
        } catch (error) {
            if (!state.open) {
                return;
            }
            state.busy = false;
            state.error = toError(error);
            render();
            if (submitBtn) {
                submitBtn.focus({ preventScroll: true });
            } else {
                content.focus({ preventScroll: true });
            }
            return;
        }

        if (!state.open) {
            return;
        }

        finish('committed', {
            sha: result && result.sha ? result.sha : '',
            message: result && result.message ? result.message : message,
            project,
            paths,
        });
    }

    /* Interaction ------------------------------------------------------- */

    /**
     * Escape closes, Tab stays inside the dialog.
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
            if (!state.busy) {
                finish('cancelled');
            }
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

    closeBtn.addEventListener('click', () => finish('cancelled'));

    overlay.addEventListener('click', (event) => {
        if (state.busy) {
            return;
        }
        if (event.target === overlay || event.target === backdrop) {
            finish('cancelled');
        }
    });

    /* Public API -------------------------------------------------------- */

    /**
     * Open the dialog for a project.
     *
     * @param {string} project
     * @param {{ leaving?: boolean }} [options] `leaving` adds the guard mode:
     *   a note and a Discard action, for when the dialog is holding up a switch.
     * @returns {Promise<'committed' | 'discarded' | 'cancelled'>}
     */
    function open(project, options = {}) {
        const name = typeof project === 'string' ? project.trim() : '';
        if (name === '') {
            return Promise.resolve('cancelled');
        }

        if (state.open) {
            finish('cancelled');
        }

        state.open = true;
        state.project = name;
        state.leaving = options.leaving === true;
        state.message = '';
        state.busy = false;
        state.error = null;
        state.paths = [];
        state.selected = new Set();
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        overlay.classList.remove('hidden');

        const promise = new Promise((resolve) => {
            resolveOpen = resolve;
        });

        void load(name);
        return promise;
    }

    function close() {
        finish('cancelled');
    }

    function destroy() {
        state.open = false;
        state.token += 1;
        resolveOpen = null;
        overlay.remove();
    }

    return { open, close, destroy };
}
