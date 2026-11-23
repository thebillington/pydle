/**
 * The commit dialog: choose the files, read the diff, write the message, commit.
 *
 * This is the only route from the editor to GitHub, and it stays deliberately
 * manual. It knows nothing about git: `sync.dirty()` says what has changed and
 * `sync.commit()` does the work, so the view is a file list, the diff for the
 * selected file, a message field and one primary action.
 *
 * The window is deliberately large: a commit is something to look at before it
 * happens, and a small modal showing only filenames hides the thing being
 * approved. The left column holds the changed files, the right pane the unified
 * diff for whichever file is selected. Ticking a file does not select it, and
 * selecting a file does not tick it: one decides what goes into the commit, the
 * other decides what is on screen.
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

import { diffLines, diffStats } from '../diff.js';
import { mountConflict } from './conflict.js';

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
 * A change from `sync.dirty()`, with its editable content kept. Snapshot entries
 * written before content was stored have no `before`, which is why a diff can be
 * unavailable for a perfectly ordinary modification.
 *
 * @typedef {{
 *   path: string,
 *   status: 'added' | 'modified' | 'deleted' | 'changed',
 *   before: string | null,
 *   after: string | null,
 * }} Change
 */

/**
 * @param {unknown} entry
 * @returns {Change | null}
 */
function normaliseChange(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    const value = /** @type {{ path?: unknown, status?: unknown, before?: unknown, after?: unknown }} */ (entry);
    if (typeof value.path !== 'string' || value.path === '') {
        return null;
    }
    return {
        path: value.path,
        status: statusLabel(value.status),
        before: typeof value.before === 'string' ? value.before : null,
        after: typeof value.after === 'string' ? value.after : null,
    };
}

/**
 * The diff for one change, or the reason it cannot be shown.
 *
 * @typedef {{
 *   available: boolean,
 *   reason: 'before-missing' | 'after-missing' | '',
 *   lines: import('../diff.js').DiffLine[],
 *   added: number,
 *   removed: number,
 *   current: string | null,
 * }} ChangeDiff
 */

/**
 * Build the diff once per changed file.
 *
 * An added file diffs from nothing and a deleted file diffs to nothing, which
 * are both genuine. A modified file with no earlier copy is not: pretending it
 * was empty would paint the whole file as new, which is a lie about what the
 * commit contains. That case is reported instead, without guessing why.
 *
 * @param {Change} change
 * @returns {ChangeDiff}
 */
function buildDiff(change) {
    if (change.status === 'added') {
        const lines = diffLines(null, change.after);
        const stats = diffStats(lines);
        return {
            available: true,
            reason: '',
            lines,
            added: stats.added,
            removed: stats.removed,
            current: null,
        };
    }

    if (change.before === null) {
        return {
            available: false,
            reason: 'before-missing',
            lines: [],
            added: 0,
            removed: 0,
            current: change.status === 'deleted' ? null : change.after,
        };
    }

    if (change.status !== 'deleted' && change.after === null) {
        return {
            available: false,
            reason: 'after-missing',
            lines: [],
            added: 0,
            removed: 0,
            current: null,
        };
    }

    const lines = diffLines(change.before, change.status === 'deleted' ? null : change.after);
    const stats = diffStats(lines);
    return {
        available: true,
        reason: '',
        lines,
        added: stats.added,
        removed: stats.removed,
        current: null,
    };
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
    const diffLabelId = `${id}-diff-label`;
    const countId = `${id}-count`;

    /* Shell ------------------------------------------------------------- */

    const overlay = el('div', 'overlay commit-overlay hidden');
    const backdrop = el('div', 'overlay-backdrop');

    const content = el('div', 'overlay-content commit-dialog');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('aria-labelledby', titleId);
    content.setAttribute('aria-describedby', projectId);
    content.tabIndex = -1;

    const header = el('div', 'overlay-header commit-header');
    const heading = el('div', 'commit-heading');
    const title = el('h2', '', 'Save to GitHub');
    title.id = titleId;
    const projectLine = el('p', 'commit-project', '');
    projectLine.id = projectId;
    heading.append(title, projectLine);

    const closeBtn = el('button', 'btn btn-close commit-close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    header.append(heading, closeBtn);

    const body = el('div', 'commit-body');
    /** Repository news, above the file list: what was pulled, what clashes. */
    const banner = el('div', 'commit-banner');
    banner.hidden = true;
    const footer = el('div', 'commit-footer');
    content.append(header, banner, body, footer);
    overlay.append(backdrop, content);
    root.replaceChildren(overlay);

    /* State ------------------------------------------------------------- */

    const state = {
        open: false,
        project: '',
        /** @type {'idle' | 'loading' | 'ready' | 'clean' | 'load-error'} */
        phase: 'idle',
        leaving: false,
        /** @type {Change[]} */
        paths: [],
        /** @type {Map<string, ChangeDiff>} */
        diffs: new Map(),
        /** Files pulled from the repository because only it had changed. */
        /** @type {string[]} */
        pulled: [],
        /** Files changed on both sides, needing a decision. */
        /** @type {Array<{ path: string, kind: string, remoteHash: string | null }>} */
        conflicts: [],
        /** True when GitHub could not be read, so this is not a current view. */
        unverified: false,
        /** Files that will go into the commit. */
        /** @type {Set<string>} */
        selected: new Set(),
        /** The file whose diff is on screen. */
        active: /** @type {string | null} */ (null),
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

    /**
     * The "which copy?" dialog, mounted on first need. It lives in its own
     * element on `document.body` so that showing it does not destroy this
     * dialog underneath.
     *
     * @type {ReturnType<typeof mountConflict> | null}
     */
    let conflictDialog = null;
    /** @type {HTMLElement | null} */
    let conflictHost = null;

    /* Rebuilt on every render; the state above holds anything worth keeping. */
    /** @type {HTMLInputElement | null} */
    let selectAllInput = null;
    /** @type {HTMLButtonElement | null} */
    let submitBtn = null;
    /** @type {HTMLTextAreaElement | null} */
    let messageInput = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let loadingHint = null;
    /** @type {Map<string, HTMLInputElement>} */
    let checkboxes = new Map();
    /** @type {Map<string, HTMLElement>} */
    let rows = new Map();
    /** @type {HTMLElement | null} */
    let diffPanel = null;
    /** @type {HTMLElement | null} */
    let countLive = null;

    /* Helpers ----------------------------------------------------------- */

    /**
     * @param {number} count
     * @returns {string}
     */
    function submitLabel(count) {
        return count === 1 ? 'Save 1 file' : `Save ${count} files`;
    }

    function readyToSubmit() {
        return !state.busy && state.selected.size > 0 && state.message.trim() !== '';
    }

    /**
     * @param {string} path
     * @returns {Change | null}
     */
    function changeFor(path) {
        return state.paths.find((entry) => entry.path === path) || null;
    }

    /**
     * Keep the primary button, the select-all state, the live count and the
     * disabled controls honest without rebuilding the DOM, so typing and
     * ticking never move the caret.
     */
    function updateControls() {
        const count = state.selected.size;

        if (submitBtn) {
            submitBtn.textContent = state.busy ? 'Saving\u2026' : submitLabel(count);
            submitBtn.disabled = !readyToSubmit();
        }

        if (selectAllInput) {
            selectAllInput.checked = count > 0 && count === state.paths.length;
            selectAllInput.indeterminate = count > 0 && count < state.paths.length;
            selectAllInput.disabled = state.busy;
        }

        if (messageInput) {
            messageInput.disabled = state.busy;
        }

        if (countLive) {
            const total = state.paths.length;
            countLive.textContent =
                total === 0
                    ? ''
                    : `${count} of ${total} ${total === 1 ? 'file' : 'files'} ticked for this commit.`;
        }
    }

    /**
     * All the controls a Tab press may land on, in DOM order.
     *
     * @returns {HTMLElement[]}
     */
    function focusables() {
        const nodes = content.querySelectorAll(
            'button, textarea, input, a[href], [tabindex]:not([tabindex="-1"])',
        );
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

    /**
     * The project name, presented so it cannot be mistaken for a word in the
     * sentence: quoted, and in monospace.
     *
     * @returns {HTMLElement}
     */
    function projectName() {
        return el('code', 'commit-project-name', state.project || 'this project');
    }

    /**
     * Compose a sentence around the project name without interpolating it into a
     * preposition.
     *
     * @param {string} before
     * @param {string} after
     * @returns {DocumentFragment}
     */
    function aroundProjectName(before, after) {
        const fragment = document.createDocumentFragment();
        fragment.append(
            document.createTextNode(before),
            document.createTextNode('\u201c'),
            projectName(),
            document.createTextNode('\u201d'),
            document.createTextNode(after),
        );
        return fragment;
    }

    /**
     * Footer buttons live in their own group so the message field can take the
     * rest of the bar.
     *
     * @param {HTMLElement[]} nodes
     * @returns {HTMLElement}
     */
    function actions(...nodes) {
        const group = el('div', 'commit-actions');
        group.append(...nodes);
        return group;
    }

    function renderLoading() {
        const note = el('p', 'commit-loading');
        note.append(aroundProjectName('Checking ', ' for changes\u2026'));
        note.setAttribute('aria-live', 'polite');

        // Ask GitHub about each changed file, so a big project is slow rather than
        // instant. Say so instead of leaving the same sentence there for a minute.
        if (loadingHint !== null) {
            clearTimeout(loadingHint);
        }
        loadingHint = setTimeout(() => {
            loadingHint = null;
            if (state.phase !== 'loading' || !note.isConnected) {
                return;
            }
            note.textContent = '';
            note.append(
                aroundProjectName('Still checking ', '. A project with many files takes a moment.'),
            );
        }, 7000);

        body.append(note);
        footer.append(actions(button('Cancel', 'quiet', () => finish('cancelled'))));
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
            actions(
                button('Cancel', 'quiet', () => finish('cancelled')),
                button('Try again', 'primary', () => {
                    void load(state.project);
                }),
            ),
        );
    }

    function renderClean() {
        const section = el('section', 'commit-section commit-empty');
        section.append(
            el('p', 'sync-lede', 'Nothing to save.'),
            (() => {
                const line = el('p', 'sync-text');
                line.append(aroundProjectName('', ' has no uncommitted changes.'));
                return line;
            })(),
        );
        body.append(section);
        footer.append(actions(button('Close', 'quiet', () => finish('cancelled'))));
    }

    /* Diff pane --------------------------------------------------------- */

    /**
     * One line of unified output: line numbers from both sides in a narrow
     * gutter, then the marker and the text. The text never wraps; the pane
     * scrolls sideways instead.
     *
     * @param {import('../diff.js').DiffLine} line
     * @param {'diff' | 'current'} mode
     * @returns {HTMLElement}
     */
    function renderDiffLine(line, mode = 'diff') {
        const type = mode === 'current' ? 'context' : line.type;
        const row = el('div', `commit-diff-line commit-diff-line-${type}`);

        const beforeNumber = line.before === null ? '' : String(line.before);
        const afterNumber = line.after === null ? '' : String(line.after);

        const before = el('span', 'commit-diff-num', beforeNumber);
        before.setAttribute('aria-hidden', 'true');
        const after = el('span', 'commit-diff-num', afterNumber);
        after.setAttribute('aria-hidden', 'true');

        let mark = ' ';
        if (type === 'added') {
            mark = '+';
        } else if (type === 'removed') {
            mark = '\u2212';
        }
        const marker = el('span', 'commit-diff-mark', mark);
        marker.setAttribute('aria-hidden', 'true');

        // Tabs are expanded so a Python file's indentation is visible rather
        // than a variable-width gap. `textContent` keeps the line inert.
        const text = el('span', 'commit-diff-text', line.text.replace(/\t/g, '    '));
        row.append(before, after, marker, text);
        return row;
    }

    /**
     * @param {import('../diff.js').DiffLine[]} lines
     * @param {'diff' | 'current'} mode
     * @returns {HTMLElement}
     */
    function renderDiffLines(lines, mode) {
        const block = el(
            'div',
            mode === 'current' ? 'commit-diff-lines commit-diff-lines-current' : 'commit-diff-lines',
        );
        for (const line of lines) {
            block.append(renderDiffLine(line, mode));
        }
        return block;
    }

    /**
     * A full-width explanatory line inside the diff pane.
     *
     * @param {string} message
     * @returns {HTMLElement}
     */
    function diffNote(message) {
        return el('p', 'commit-diff-note', message);
    }

    /**
     * Paint the right-hand pane for the selected file.
     *
     * Only the selected file is diffed, and only on demand: the cached result
     * built at load time is used here, never recomputed while a caret moves.
     */
    function paintDiff() {
        if (!diffPanel) {
            return;
        }

        diffPanel.replaceChildren();
        diffPanel.removeAttribute('aria-labelledby');

        const entry = state.active ? changeFor(state.active) : null;
        if (!entry) {
            diffPanel.append(el('p', 'commit-diff-empty', 'Select a file to see what will be saved.'));
            return;
        }

        const diff = state.diffs.get(entry.path) || buildDiff(entry);

        const headNode = el('div', 'commit-diff-head');
        const headMain = el('div', 'commit-diff-head-main');
        const path = el('code', 'commit-diff-path', entry.path);
        path.id = diffLabelId;
        path.title = entry.path;
        diffPanel.setAttribute('aria-labelledby', diffLabelId);

        const meta = el('div', 'commit-diff-meta');
        const status = el(
            'span',
            `commit-diff-status commit-diff-status-${entry.status}`,
            entry.status,
        );
        meta.append(status);

        const counts = el('div', 'commit-diff-counts');
        if (diff.available) {
            counts.append(
                el('span', 'commit-diff-added', `+${diff.added}`),
                el('span', 'commit-diff-removed', `\u2212${diff.removed}`),
            );
            counts.setAttribute(
                'aria-label',
                `${diff.added} ${diff.added === 1 ? 'line' : 'lines'} added, ` +
                    `${diff.removed} ${diff.removed === 1 ? 'line' : 'lines'} removed`,
            );
        } else {
            counts.append(
                el(
                    'span',
                    'commit-diff-unavailable',
                    diff.reason === 'before-missing' ? 'No earlier copy' : 'No current copy',
                ),
            );
        }

        headMain.append(path, meta);
        headNode.append(headMain, counts);

        const scroll = el('div', 'commit-diff-scroll');

        if (!diff.available) {
            const reason =
                diff.reason === 'before-missing'
                    ? 'The earlier copy of this file could not be read, so there is nothing ' +
                      'to compare it with here.' +
                      (entry.status === 'deleted'
                          ? ' It will still be deleted when you save.'
                          : ' The version below is what will be saved.')
                    : 'The current copy of this file could not be read, so there is no diff to show.';
            scroll.append(diffNote(reason));

            if (typeof diff.current === 'string') {
                scroll.append(el('p', 'commit-diff-subhead', 'Current version'));
                const currentLines = diffLines(null, diff.current).map((line) => ({
                    ...line,
                    type: /** @type {const} */ ('context'),
                }));
                if (currentLines.length === 0) {
                    scroll.append(diffNote('This file is empty.'));
                } else {
                    scroll.append(renderDiffLines(currentLines, 'current'));
                }
            }
        } else if (diff.lines.length === 0) {
            scroll.append(diffNote('This file has no text lines to show.'));
        } else {
            scroll.append(renderDiffLines(diff.lines, 'diff'));
        }

        diffPanel.append(headNode, scroll);
    }

    /* File list --------------------------------------------------------- */

    /**
     * @param {Change} entry
     * @returns {HTMLElement}
     */
    function renderFileRow(entry) {
        const diff = state.diffs.get(entry.path) || buildDiff(entry);
        const ticked = state.selected.has(entry.path);
        const active = state.active === entry.path;

        const row = el('div', 'commit-file');
        row.dataset.path = entry.path;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', active ? 'true' : 'false');
        row.setAttribute('aria-disabled', state.busy ? 'true' : 'false');
        if (active) {
            row.classList.add('is-active');
        }
        row.tabIndex = active && !state.busy ? 0 : -1;

        const checkbox = /** @type {HTMLInputElement} */ (el('input', 'commit-file-check'));
        checkbox.type = 'checkbox';
        checkbox.checked = ticked;
        checkbox.disabled = state.busy;
        checkbox.setAttribute(
            'aria-label',
            `${ticked ? 'Leave out' : 'Include'} ${entry.path} in this save`,
        );
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                state.selected.add(entry.path);
            } else {
                state.selected.delete(entry.path);
            }
            checkbox.setAttribute(
                'aria-label',
                `${checkbox.checked ? 'Leave out' : 'Include'} ${entry.path} in this save`,
            );
            updateControls();
        });

        const main = el('div', 'commit-file-main');
        const path = el('span', 'commit-file-path', entry.path);
        path.title = entry.path;

        const meta = el('div', 'commit-file-meta');
        const status = el('span', `commit-file-status commit-file-status-${entry.status}`, entry.status);
        meta.append(status);

        if (diff.available) {
            const stats = el('span', 'commit-file-stats');
            stats.append(
                el('span', 'commit-file-added', `+${diff.added}`),
                document.createTextNode(' '),
                el('span', 'commit-file-removed', `\u2212${diff.removed}`),
            );
            stats.setAttribute(
                'aria-label',
                `${diff.added} added, ${diff.removed} removed`,
            );
            meta.append(stats);
        } else {
            const stats = el('span', 'commit-file-stats commit-file-stats-none', 'no diff');
            stats.title =
                diff.reason === 'before-missing'
                    ? 'The earlier copy could not be read.'
                    : 'The current copy could not be read.';
            meta.append(stats);
        }

        main.append(path, meta);
        row.append(checkbox, main);

        row.addEventListener('click', () => {
            select(entry.path);
        });

        row.addEventListener('keydown', (event) => {
            if (event.target instanceof HTMLInputElement) {
                return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select(entry.path);
                return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return;
            }
            event.preventDefault();
            const index = state.paths.findIndex((item) => item.path === entry.path);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            const next = state.paths[index + step];
            if (!next) {
                return;
            }
            select(next.path);
            const nextRow = rows.get(next.path);
            if (nextRow) {
                nextRow.focus({ preventScroll: true });
                nextRow.scrollIntoView({ block: 'nearest' });
            }
        });

        checkboxes.set(entry.path, checkbox);
        rows.set(entry.path, row);
        return row;
    }

    /**
     * Select a file for the diff pane. Ticking is a separate decision, so this
     * never touches `state.selected`.
     *
     * @param {string} path
     */
    function select(path) {
        if (state.busy || !state.open || state.active === path || !changeFor(path)) {
            return;
        }
        state.active = path;

        for (const [rowPath, row] of rows) {
            const isActive = rowPath === path;
            row.classList.toggle('is-active', isActive);
            row.setAttribute('aria-selected', isActive ? 'true' : 'false');
            row.tabIndex = isActive && !state.busy ? 0 : -1;
        }

        paintDiff();
    }

    /* Ready state ------------------------------------------------------- */

    function renderGuard() {
        // The escape hatch is inline rather than a red footer button: leaving
        // without committing deletes nothing, so it should not be styled as a
        // destructive action.
        const guard = el('p', 'commit-guard');
        guard.append(
            aroundProjectName('', ' has changes that are not in GitHub yet. Save them before you go, or '),
        );
        const leave = el('button', 'commit-guard-link', 'leave without committing');
        leave.type = 'button';
        leave.disabled = Boolean(state.busy);
        leave.title = 'Your files stay on this device. Nothing is deleted.';
        leave.setAttribute(
            'aria-label',
            'Leave without committing. Your files stay saved on this device.',
        );
        leave.addEventListener('click', () => finish('discarded'));
        guard.append(leave, document.createTextNode(' and carry on.'));
        body.append(guard);
    }

    function renderCommitError() {
        if (!state.error) {
            return;
        }
        const banner = el('section', 'commit-alert');
        const note = el('p', 'sync-note sync-note-error', state.error.message);
        note.setAttribute('role', 'alert');
        banner.append(note);

        const hint = recoveryHint(state.error);
        if (hint) {
            banner.append(el('p', 'sync-meta', hint));
        }
        body.append(banner);
    }

    /**
     * News about the repository, above the file list.
     *
     * Two things belong here and nowhere else: files pulled in because only the
     * repository had changed them, and files both sides changed, which the student
     * has to settle before choosing what to commit.
     */
    function renderBanner() {
        banner.textContent = '';
        banner.hidden = true;
        banner.className = 'commit-banner';

        if (state.phase !== 'ready') {
            return;
        }

        const conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
        const pulled = Array.isArray(state.pulled) ? state.pulled : [];

        if (state.unverified) {
            banner.hidden = false;
            banner.classList.add('commit-banner-attention');
            banner.append(
                el(
                    'p',
                    'commit-banner-text',
                    'GitHub could not be reached, so this is compared with the last commit saved ' +
                        'on this device. Saving will fail until the connection is back, and nothing ' +
                        'here is lost meanwhile.',
                ),
            );
            return;
        }

        if (conflicts.length > 0) {
            banner.hidden = false;
            banner.classList.add('commit-banner-attention');
            banner.setAttribute('role', 'alert');

            const text = el(
                'p',
                'commit-banner-text',
                conflicts.length +
                    (conflicts.length === 1 ? ' file was' : ' files were') +
                    ' changed on GitHub as well. Decide which copy to keep before saving.',
            );

            const decide = el('button', 'sync-btn sync-btn-primary commit-banner-action', 'Decide');
            decide.type = 'button';
            decide.addEventListener('click', () => {
                void settleConflicts();
            });

            banner.append(text, decide);
            return;
        }

        if (pulled.length > 0) {
            banner.hidden = false;
            const text = el(
                'p',
                'commit-banner-text',
                pulled.length +
                    (pulled.length === 1 ? ' file was' : ' files were') +
                    ' updated from GitHub first, so you are looking at the current version.',
            );
            banner.append(text);
        }
    }

    /**
     * Settle the conflicts, then re-read so the list reflects the decision.
     */
    async function settleConflicts() {
        const project = state.project;
        const resolutions = await ensureConflictDialog().open({
            project,
            conflicts: state.conflicts,
        });

        if (resolutions === null || !state.open || state.project !== project) {
            return;
        }

        await load(project, resolutions);
    }

    function renderReady() {
        if (state.leaving) {
            renderGuard();
        }
        renderCommitError();

        if (!state.active || !changeFor(state.active)) {
            state.active = state.paths.length > 0 ? state.paths[0].path : null;
        }

        const main = el('div', 'commit-main');

        /* Left column: the changed files. */
        const filesPanel = el('section', 'commit-files-panel');
        const filesHead = el('div', 'commit-panel-head');
        const filesLabel = el('h3', 'sync-section-label commit-files-label', 'Files');
        filesLabel.id = filesLabelId;
        filesHead.append(filesLabel);

        if (state.paths.length > SELECT_ALL_THRESHOLD) {
            const selectAllLabel = el('label', 'commit-select-all');
            selectAllInput = /** @type {HTMLInputElement} */ (el('input', 'commit-select-all-box'));
            selectAllInput.type = 'checkbox';
            selectAllInput.disabled = state.busy;
            selectAllInput.addEventListener('change', () => {
                state.selected = new Set(
                    selectAllInput && selectAllInput.checked
                        ? state.paths.map((entry) => entry.path)
                        : [],
                );
                for (const [path, box] of checkboxes) {
                    box.checked = state.selected.has(path);
                    box.setAttribute(
                        'aria-label',
                        `${box.checked ? 'Leave out' : 'Include'} ${path} in this save`,
                    );
                }
                updateControls();
            });
            selectAllLabel.append(selectAllInput, document.createTextNode('Select all'));
            filesHead.append(selectAllLabel);
        }

        const list = el('div', 'commit-file-list');
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-labelledby', filesLabelId);
        list.setAttribute('aria-multiselectable', 'true');
        for (const entry of state.paths) {
            list.append(renderFileRow(entry));
        }

        countLive = el('p', 'commit-live');
        countLive.id = countId;
        countLive.setAttribute('aria-live', 'polite');
        countLive.setAttribute('aria-atomic', 'true');

        filesPanel.append(filesHead, list, countLive);

        /* Right pane: the selected file's diff. */
        diffPanel = el('section', 'commit-diff-panel');
        diffPanel.setAttribute('role', 'region');

        main.append(filesPanel, diffPanel);
        body.append(main);

        /* What a commit is, as a disclosure rather than an icon. It answers the
           question in the place where the question is asked. */
        const help = el('details', 'commit-help');
        const helpSummary = el('summary', 'commit-help-summary', 'What does committing do?');
        const helpBody = el('div', 'commit-help-body');
        helpBody.append(
            el(
                'p',
                'commit-help-text',
                'A commit copies the ticked files into your GitHub repository, with the message you write. It becomes a version you can return to later.',
            ),
            el(
                'p',
                'commit-help-text',
                'Saving keeps your work on this device only, so nothing is lost if the connection drops. Committing is the separate step that puts a copy in GitHub.',
            ),
            el(
                'p',
                'commit-help-text',
                'Unticked files stay on this device. You can commit again later for the rest.',
            ),
        );
        help.append(helpSummary, helpBody);

        /* Bottom bar: the message, then the actions. */
        const messageField = el('div', 'commit-message-field');
        const messageLabel = el('label', 'sync-section-label commit-message-label', 'Message');
        messageLabel.setAttribute('for', messageId);

        messageInput = /** @type {HTMLTextAreaElement} */ (el('textarea', 'commit-message'));
        messageInput.id = messageId;
        messageInput.rows = 2;
        messageInput.value = state.message;
        messageInput.disabled = state.busy;
        messageInput.setAttribute('aria-required', 'true');
        messageInput.placeholder = 'What changed, and why?';
        messageInput.addEventListener('input', () => {
            state.message = messageInput ? messageInput.value : '';
            updateControls();
        });

        messageField.append(
            messageLabel,
            messageInput,
            el(
                'p',
                'commit-hint',
                'A short note about what changed, and why. This becomes one commit in your repository.',
            ),
        );

        submitBtn = button(submitLabel(state.selected.size), 'primary', () => {
            void submit();
        });

        const footerRow = el('div', 'commit-footer-main');
        footerRow.append(
            messageField,
            actions(button('Cancel', 'quiet', () => finish('cancelled'), { disabled: state.busy }), submitBtn),
        );
        footer.append(help, footerRow);

        paintDiff();
        updateControls();
    }

    function render() {
        if (loadingHint !== null && state.phase !== 'loading') {
            clearTimeout(loadingHint);
            loadingHint = null;
        }
        renderBanner();
        projectLine.textContent = state.project || 'This project';
        content.setAttribute('aria-busy', state.busy ? 'true' : 'false');
        closeBtn.disabled = state.busy;
        // A working window needs the room; a single sentence does not.
        content.classList.toggle('is-compact', state.phase !== 'ready');

        body.replaceChildren();
        footer.replaceChildren();
        messageInput = null;
        selectAllInput = null;
        submitBtn = null;
        countLive = null;
        diffPanel = null;
        checkboxes = new Map();
        rows = new Map();

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
     * The diff for a changed file is built here, once, so selecting a file is
     * instant and opening the dialog does not run the comparison repeatedly.
     * Unchanged files never reach this point: `dirty()` has already filtered
     * them out.
     *
     * @param {string} project
     */
    async function load(project, resolutions = {}) {
        const token = ++state.token;
        state.project = project;
        state.phase = 'loading';
        state.error = null;
        state.paths = [];
        state.diffs = new Map();
        state.selected = new Set();
        state.active = null;
        render();
        content.focus({ preventScroll: true });

        let report;
        try {
            // `previewCommit` reconciles with the repository first and diffs against
            // what GitHub actually holds. `dirty` alone sees only this device.
            report = typeof sync.previewCommit === 'function'
                ? await sync.previewCommit(project, 'work', resolutions)
                : await sync.dirty(project);
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

        state.pulled = Array.isArray(report && report.pulled) ? report.pulled : [];
        state.conflicts = Array.isArray(report && report.conflicts) ? report.conflicts : [];
        state.unverified = Boolean(report && report.unverified);

        const entries = Array.isArray(report && report.paths)
            ? report.paths.map(normaliseChange).filter(Boolean)
            : [];

        state.paths = /** @type {Change[]} */ (entries);
        state.diffs = new Map();
        for (const entry of state.paths) {
            state.diffs.set(entry.path, buildDiff(entry));
        }
        state.selected = new Set(state.paths.map((entry) => entry.path));
        state.active = state.paths.length > 0 ? state.paths[0].path : null;
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

    /**
     * Mount the conflict dialog outside this dialog's container, once.
     *
     * @returns {ReturnType<typeof mountConflict>}
     */
    function ensureConflictDialog() {
        if (conflictDialog) {
            return conflictDialog;
        }
        conflictHost = el('div', 'conflict-root');
        document.body.appendChild(conflictHost);
        conflictDialog = mountConflict(conflictHost, {});
        return conflictDialog;
    }

    /**
     * Restore the commit dialog's controls after an error or a cancelled
     * conflict prompt, with the caret on the primary action.
     */
    function focusAfterProblem() {
        if (submitBtn) {
            submitBtn.focus({ preventScroll: true });
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

            const problem = toError(error);
            const conflicts = Array.isArray(problem.conflicts) ? problem.conflicts : [];

            if (problem.kind === 'conflict' && conflicts.length > 0) {
                // Reconciliation found files that moved on both sides. Ask for
                // a choice, then retry the same commit once with the answer.
                state.busy = false;
                state.error = null;
                render();

                const dialog = ensureConflictDialog();
                const resolutions = await dialog.open({ project, conflicts });

                if (!state.open) {
                    return;
                }

                if (resolutions === null) {
                    // Cancelling changes nothing: the selection and message are
                    // still here, so the commit can be attempted again later.
                    focusAfterProblem();
                    return;
                }

                state.busy = true;
                state.error = null;
                render();
                content.focus({ preventScroll: true });

                try {
                    result = await sync.commit({ project, paths, message, resolutions });
                } catch (retryError) {
                    if (!state.open) {
                        return;
                    }
                    // One retry only. A second block is reported inline, so the
                    // dialog cannot reopen itself in a loop.
                    state.busy = false;
                    state.error = toError(retryError);
                    render();
                    focusAfterProblem();
                    return;
                }
            } else {
                state.busy = false;
                state.error = problem;
                render();
                focusAfterProblem();
                return;
            }
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
     *   a note and a way to leave without committing, for when the dialog is
     *   holding up a switch.
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
        state.diffs = new Map();
        state.selected = new Set();
        state.active = null;
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
        if (conflictDialog) {
            conflictDialog.destroy();
            conflictDialog = null;
        }
        if (conflictHost) {
            conflictHost.remove();
            conflictHost = null;
        }
        overlay.remove();
    }

    return { open, close, destroy };
}
