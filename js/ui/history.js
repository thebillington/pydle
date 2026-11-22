/**
 * The history modal: commits that touched one project, newest first.
 *
 * A two-pane viewer: the commit list on the left, the selected commit and its
 * per-file patches on the right. History is read from GitHub, not kept locally,
 * so this needs a connection; the modal itself is presentational and asks
 * `sync` for everything it shows.
 *
 * It never writes to GitHub and never touches the editor or the vault. Loading
 * an earlier version is a hand-off: `onLoadVersion` receives the content and
 * decides what to do with it. If the caller supplies no callback, the action is
 * not rendered at all rather than leaving a dead button in the file header.
 *
 * There is deliberately no revert, reset, checkout or restore-to-head here.
 * The only way work reaches the repository is a new commit made elsewhere.
 */

/** Added once per page, from the module's own location. */
const STYLESHEET_ID = 'pydle-history-styles';

/**
 * Add css/history.css if it is not on the page yet.
 *
 * The modal owns its stylesheet so `mountHistory` works in the page and in the
 * visual fixture without either one having to remember a <link>.
 */
function ensureStylesheet() {
    if (typeof document === 'undefined' || document.getElementById(STYLESHEET_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = new URL('../../css/history.css', import.meta.url).href;
    document.head.appendChild(link);
}

/**
 * A commit SHA shortened for display.
 *
 * @param {unknown} sha
 * @returns {string}
 */
export function shortSha(sha) {
    return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

/**
 * The first line of a commit message.
 *
 * @param {unknown} message
 * @returns {string}
 */
export function summaryLine(message) {
    if (typeof message !== 'string') {
        return '';
    }
    const line = message.split('\n')[0].trim();
    return line === '' ? 'Untitled commit' : line;
}

/**
 * A commit date in the reader's locale, or an empty string when unknown.
 *
 * @param {unknown} iso
 * @returns {string}
 */
export function formatCommitDate(iso) {
    if (typeof iso !== 'string' || iso === '') {
        return '';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A file's status as one word for its badge.
 *
 * @param {unknown} status
 * @returns {string}
 */
export function fileStatusLabel(status) {
    switch (status) {
        case 'added':
            return 'Added';
        case 'removed':
            return 'Deleted';
        case 'modified':
            return 'Changed';
        case 'renamed':
            return 'Renamed';
        case 'copied':
            return 'Copied';
        default:
            return typeof status === 'string' && status !== '' ? status : 'Changed';
    }
}

/**
 * Split a unified patch into lines with a class for each kind.
 *
 * `+++`/`---` are file headers, not added/removed lines, so they are kept
 * separate; likewise `@@` hunk headers and `\ No newline` notes.
 *
 * @param {unknown} patch
 * @returns {Array<{ kind: 'add' | 'del' | 'hunk' | 'meta' | 'context', text: string }>}
 */
export function patchLines(patch) {
    if (typeof patch !== 'string' || patch === '') {
        return [];
    }

    return patch.split('\n').map((text) => {
        let kind = 'context';
        if (text.startsWith('@@')) {
            kind = 'hunk';
        } else if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('\\')) {
            kind = 'meta';
        } else if (text.startsWith('+')) {
            kind = 'add';
        } else if (text.startsWith('-')) {
            kind = 'del';
        }
        return { kind, text };
    });
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
 * Turn anything thrown into a sentence.
 *
 * @param {unknown} error
 * @param {string} fallback
 * @returns {string}
 */
function messageFor(error, fallback) {
    if (error && typeof error.message === 'string' && error.message.trim() !== '') {
        return error.message.trim();
    }
    return fallback;
}

/**
 * Mount the history modal.
 *
 * Call `open(project)` to show it. The caller owns the container; this function
 * fills it with the overlay and leaves it hidden until then.
 *
 * @param {HTMLElement} root Empty container for the modal.
 * @param {{ listCommits: Function, getCommit: Function, fileAt: Function }} sync
 * @param {{ onLoadVersion?: (version: { project: string, path: string, sha: string, content: string, date: string | null, message: string }) => void | Promise<void> }} [options]
 * @returns {{ open: (project: string) => void, close: () => void, reload: () => void, destroy: () => void }}
 */
export function mountHistory(root, sync, { onLoadVersion } = {}) {
    if (!root) {
        throw new TypeError('mountHistory needs a container element.');
    }
    if (!sync) {
        throw new TypeError('mountHistory needs a sync object.');
    }

    ensureStylesheet();

    const loadVersion = typeof onLoadVersion === 'function' ? onLoadVersion : null;

    root.classList.add('overlay', 'history-overlay', 'hidden');
    root.textContent = '';

    /** @type {string | null} */
    let project = null;
    /** @type {Array<{ sha: string, message: string, date: string | null, author: string }>} */
    let commits = [];
    let loading = false;
    let listError = '';
    /** @type {string | null} */
    let selectedSha = null;
    /** Ignore responses from a project or reload that is no longer shown. */
    let requestToken = 0;

    /** @type {Map<string, { status: 'loading' | 'ready' | 'error', files?: Array<any>, message?: string }>} */
    const details = new Map();
    /** Per file section, keyed by commit and path. */
    /** @type {Map<string, { status: 'idle' | 'loading' | 'loaded' | 'unavailable' | 'error', message?: string }>} */
    const fileStates = new Map();

    /* DOM ------------------------------------------------------------- */

    const backdrop = el('div', 'overlay-backdrop');
    const content = el('div', 'overlay-content');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('aria-labelledby', 'history-title');

    const header = el('div', 'overlay-header');
    const heading = el('h2');
    heading.id = 'history-title';
    const subject = el('span', 'history-title-project');
    heading.append('History ', subject);
    const closeBtn = el('button', 'btn btn-close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close history');
    closeBtn.title = 'Close history';
    header.append(heading, closeBtn);

    const body = el('div', 'history-body');
    const commitsPane = el('div', 'history-commits');
    const list = el('ul', 'history-list');
    list.setAttribute('aria-label', 'Commits for this project');
    commitsPane.appendChild(list);
    const detailPane = el('div', 'history-detail');
    body.append(commitsPane, detailPane);
    content.append(header, body);
    root.append(backdrop, content);

    /* Helpers --------------------------------------------------------- */

    /**
     * @param {string} commitSha
     * @param {string} path
     * @returns {string}
     */
    function fileKey(commitSha, path) {
        return `${commitSha}\u0000${path}`;
    }

    /**
     * @returns {any | null}
     */
    function selectedCommit() {
        return commits.find((commit) => commit.sha === selectedSha) || null;
    }

    /**
     * A state paragraph for a pane.
     *
     * @param {string} className
     * @param {string} text
     * @returns {HTMLElement}
     */
    function stateLine(className, text) {
        return el('p', className, text);
    }

    /**
     * An error with a retry action, used in either pane.
     *
     * @param {string} message
     * @param {() => void} retry
     * @returns {HTMLElement}
     */
    function errorBlock(message, retry) {
        const box = el('div', 'history-error');
        const text = el('p', 'history-error-text', message);
        text.setAttribute('role', 'alert');
        const button = el('button', 'history-retry', 'Try again');
        button.type = 'button';
        button.addEventListener('click', retry);
        box.append(text, button);
        return box;
    }

    /* Commits ---------------------------------------------------------- */

    /** Fetch the commit list for the open project. */
    async function loadCommits() {
        if (!project) {
            return;
        }

        const token = ++requestToken;
        loading = true;
        listError = '';
        commits = [];
        selectedSha = null;
        details.clear();
        fileStates.clear();
        render();

        if (typeof sync.listCommits !== 'function') {
            if (token === requestToken) {
                loading = false;
                listError = 'History is not available in this build.';
                render();
            }
            return;
        }

        try {
            const result = await sync.listCommits(project, { limit: 30 });
            if (token !== requestToken) {
                return;
            }
            commits = Array.isArray(result) ? result : [];
        } catch (error) {
            if (token !== requestToken) {
                return;
            }
            listError = messageFor(error, 'Could not load history.');
        }

        if (token !== requestToken) {
            return;
        }

        loading = false;
        render();

        // Opening the newest commit gives the reader something to look at
        // without another click, and the list stays the place to choose.
        if (commits.length > 0) {
            selectCommit(commits[0].sha);
        }
    }

    /**
     * Select a commit and fetch its file list once.
     *
     * @param {string} sha
     */
    function selectCommit(sha) {
        selectedSha = sha;
        renderCommits();

        if (!details.has(sha)) {
            void loadDetail(sha);
        } else {
            renderDetail();
        }
    }

    /**
     * @param {string} sha
     */
    async function loadDetail(sha) {
        if (typeof sync.getCommit !== 'function') {
            details.set(sha, { status: 'error', message: 'History is not available in this build.' });
            renderDetail();
            return;
        }

        details.set(sha, { status: 'loading' });
        renderDetail();

        const token = requestToken;
        try {
            const detail = await sync.getCommit(sha);
            if (token !== requestToken) {
                return;
            }
            details.set(sha, {
                status: 'ready',
                files: Array.isArray(detail && detail.files) ? detail.files : [],
            });
        } catch (error) {
            if (token !== requestToken) {
                return;
            }
            details.set(sha, {
                status: 'error',
                message: messageFor(error, 'Could not load that commit.'),
            });
        }
        renderDetail();
    }

    /* Rendering -------------------------------------------------------- */

    function render() {
        subject.textContent = project || '';
        subject.title = project || '';
        renderCommits();
        renderDetail();
    }

    function renderCommits() {
        list.textContent = '';

        if (loading) {
            const item = el('li');
            item.appendChild(stateLine('history-state', 'Loading commits\u2026'));
            list.appendChild(item);
            return;
        }

        if (listError) {
            const item = el('li');
            item.appendChild(errorBlock(listError, () => void loadCommits()));
            list.appendChild(item);
            return;
        }

        if (commits.length === 0) {
            const item = el('li');
            item.appendChild(
                stateLine(
                    'history-empty',
                    project
                        ? 'No commits yet. Commit this project to start its history.'
                        : 'Open a project to see its history.',
                ),
            );
            list.appendChild(item);
            return;
        }

        for (const commit of commits) {
            const item = el('li', 'history-commit');
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            item.setAttribute('aria-label', `${summaryLine(commit.message)}, ${shortSha(commit.sha)}`);
            item.classList.toggle('history-commit-selected', commit.sha === selectedSha);
            if (commit.sha === selectedSha) {
                item.setAttribute('aria-current', 'true');
            }

            const message = el('div', 'history-commit-message', summaryLine(commit.message));
            message.title = commit.message || message.textContent;

            const meta = el('div', 'history-commit-meta');
            const date = el('span', 'history-commit-date', formatCommitDate(commit.date));
            const sep = el('span', 'history-commit-sep', '\u00b7');
            const sha = el('span', 'history-commit-sha', shortSha(commit.sha));
            meta.append(date, sep, sha);

            item.append(message, meta);
            item.addEventListener('click', () => selectCommit(commit.sha));
            item.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectCommit(commit.sha);
                }
            });

            list.appendChild(item);
        }
    }

    function renderDetail() {
        detailPane.textContent = '';

        if (listError) {
            detailPane.appendChild(stateLine('history-placeholder', 'History could not be loaded.'));
            return;
        }

        const commit = selectedCommit();
        if (!commit) {
            detailPane.appendChild(
                stateLine(
                    'history-placeholder',
                    commits.length === 0
                        ? 'Commits will appear here.'
                        : 'Select a commit to see the files it changed.',
                ),
            );
            return;
        }

        const detail = details.get(commit.sha);

        if (!detail || detail.status === 'loading') {
            detailPane.appendChild(stateLine('history-state', 'Loading this commit\u2026'));
            return;
        }

        if (detail.status === 'error') {
            detailPane.appendChild(
                errorBlock(detail.message || 'Could not load that commit.', () => {
                    details.delete(commit.sha);
                    void loadDetail(commit.sha);
                }),
            );
            return;
        }

        const head = el('div', 'history-commit-head');
        const full = el('div', 'history-commit-full', String(commit.message || '').trim() || summaryLine(commit.message));
        const byline = el('div', 'history-commit-byline');

        if (commit.author) {
            byline.append(el('span', 'history-author', commit.author), el('span', 'history-byline-sep', '\u00b7'));
        }
        byline.append(
            el('span', 'history-commit-date', formatCommitDate(commit.date)),
            el('span', 'history-byline-sep', '\u00b7'),
            el('span', 'history-sha', commit.sha),
        );
        head.append(full, byline);
        detailPane.appendChild(head);

        const files = detail.files || [];
        detailPane.appendChild(el('div', 'history-files-label', `Files changed (${files.length})`));

        if (files.length === 0) {
            detailPane.appendChild(stateLine('history-placeholder', 'This commit did not record any file changes.'));
            return;
        }

        const filesBox = el('div', 'history-files');
        for (const file of files) {
            filesBox.appendChild(renderFile(file, commit));
        }
        detailPane.appendChild(filesBox);
    }

    /**
     * One file: a summary row with the patch inside it.
     *
     * @param {{ path: string, status: string, additions: number, deletions: number, patch: string }} file
     * @param {{ sha: string, message: string, date: string | null }} commit
     * @returns {HTMLElement}
     */
    function renderFile(file, commit) {
        const section = el('details', 'history-file');
        // A changed file is why the commit was opened; show it, not a row of
        // collapsed names.
        section.open = true;

        const head = el('summary', 'history-file-head');

        const path = el('span', 'history-file-path', file.path);
        path.title = file.path;

        const stats = el('span', 'history-stats');
        const added = el('span', 'history-stat-add', `+${file.additions || 0}`);
        added.title = `${file.additions || 0} lines added`;
        const removed = el('span', 'history-stat-del', `\u2212${file.deletions || 0}`);
        removed.title = `${file.deletions || 0} lines removed`;
        stats.append(added, removed);

        const badge = el(
            'span',
            `history-badge history-badge-${file.status || 'modified'}`,
            fileStatusLabel(file.status),
        );

        head.append(path, stats, badge);

        const key = fileKey(commit.sha, file.path);
        const note = el('p', 'history-file-note');
        note.setAttribute('role', 'status');
        note.setAttribute('aria-live', 'polite');

        /**
         * Update the note and remember the state so folding the file does not
         * lose it.
         *
         * @param {{ status: string, message?: string }} next
         */
        function paint(next) {
            fileStates.set(key, next);
            note.classList.remove('is-error', 'is-ok');
            if (next.status === 'loading') {
                note.textContent = 'Loading this version\u2026';
            } else if (next.status === 'unavailable') {
                note.textContent = 'That version is not available.';
            } else if (next.status === 'error') {
                note.classList.add('is-error');
                note.textContent = next.message || 'Could not load that version.';
            } else if (next.status === 'loaded') {
                note.classList.add('is-ok');
                note.textContent = 'Loaded into the editor. Nothing in your history was changed.';
            } else {
                note.textContent = '';
            }
            note.hidden = note.textContent === '';
            if (!note.hidden) {
                // The action lives in the summary, so make sure its answer is
                // visible even if the reader had folded the patch away.
                section.open = true;
            }
        }

        const record = fileStates.get(key) || { status: 'idle' };

        if (loadVersion) {
            const loadBtn = el('button', 'history-load-btn', 'Load this version');
            loadBtn.type = 'button';
            loadBtn.title = 'Loads this version into the editor. Nothing is overwritten in your history.';

            // The summary toggles the patch when clicked. The button is a
            // different action, so keep the click from reaching the summary.
            loadBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void beginLoad();
            });
            loadBtn.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                }
            });

            /**
             * Fetch this version and hand it to the caller.
             */
            async function beginLoad() {
                if (loadBtn.disabled) {
                    return;
                }
                loadBtn.disabled = true;
                loadBtn.setAttribute('aria-busy', 'true');
                loadBtn.textContent = 'Loading\u2026';
                paint({ status: 'loading' });

                try {
                    if (typeof sync.fileAt !== 'function') {
                        paint({ status: 'error', message: 'History is not available in this build.' });
                        return;
                    }

                    const content = await sync.fileAt(project, file.path, commit.sha);
                    if (content === null || content === undefined) {
                        paint({ status: 'unavailable' });
                        return;
                    }

                    try {
                        await loadVersion({
                            project,
                            path: file.path,
                            sha: commit.sha,
                            content,
                            date: commit.date,
                            message: commit.message,
                        });
                    } catch (error) {
                        paint({
                            status: 'error',
                            message: messageFor(error, 'Could not load that version.'),
                        });
                        return;
                    }

                    paint({ status: 'loaded' });
                } catch (error) {
                    paint({
                        status: 'error',
                        message: messageFor(error, 'Could not load that version.'),
                    });
                } finally {
                    loadBtn.disabled = false;
                    loadBtn.removeAttribute('aria-busy');
                    loadBtn.textContent = 'Load this version';
                }
            }

            head.insertBefore(loadBtn, badge);
        }

        section.appendChild(head);
        section.appendChild(note);
        paint(record);

        const lines = patchLines(file.patch);
        if (lines.length === 0) {
            section.appendChild(el('p', 'history-patch-empty', 'No text changes to show for this file.'));
        } else {
            const patch = el('div', 'history-patch');
            patch.setAttribute('aria-label', `Changes to ${file.path}`);
            for (const line of lines) {
                patch.appendChild(
                    el('div', `history-line history-line-${line.kind}`, line.text === '' ? ' ' : line.text),
                );
            }
            section.appendChild(patch);
        }

        return section;
    }

    /* Open and close --------------------------------------------------- */

    /**
     * Show history for a project.
     *
     * @param {string} name
     */
    function open(name) {
        if (typeof name !== 'string' || name.trim() === '') {
            return;
        }

        project = name.trim();
        commits = [];
        listError = '';
        loading = false;
        selectedSha = null;
        details.clear();
        fileStates.clear();
        requestToken += 1;

        render();
        root.classList.remove('hidden');
        closeBtn.focus({ preventScroll: true });

        void loadCommits();
    }

    /** Hide the modal. The caller's editor and vault are untouched. */
    function close() {
        root.classList.add('hidden');
        requestToken += 1;
    }

    /** Reload the open project's commits. */
    function reload() {
        if (project && !root.classList.contains('hidden')) {
            void loadCommits();
        }
    }

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !root.classList.contains('hidden')) {
            event.stopPropagation();
            close();
        }
    });

    render();

    return {
        open,
        close,
        reload,
        destroy() {
            close();
            root.textContent = '';
        },
    };
}
