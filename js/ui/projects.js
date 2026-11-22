/**
 * Project list.
 *
 * Presentational only: the vault belongs to whoever supplies `sync`, so this
 * reads `sync.projects` when it is an array, or awaits `sync.listProjects()` when
 * that exists. Project names and sync states are treated as untrusted text.
 */

const STATE_LABELS = {
    saved: { label: 'Saved to GitHub', tone: 'ok' },
    synced: { label: 'Saved to GitHub', tone: 'ok' },
    syncing: { label: 'Saving…', tone: 'busy' },
    pending: { label: 'Waiting to save', tone: 'busy' },
    queued: { label: 'Waiting to save', tone: 'busy' },
    local: { label: 'On this device', tone: 'local' },
    offline: { label: 'Saved on this device', tone: 'local' },
    error: { label: 'Could not save', tone: 'error' },
};

/**
 * Subscribe to sync status changes when the implementation offers it.
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
        // The list still works from `update()`.
    }

    return () => {};
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
 * @param {string} label
 * @param {'quiet' | 'danger'} variant
 * @param {() => void} onClick
 * @param {{ disabled?: boolean, ariaLabel?: string }} [options]
 * @returns {HTMLButtonElement}
 */
function button(label, variant, onClick, { disabled = false, ariaLabel } = {}) {
    const node = el('button', `sync-btn sync-btn-${variant} sync-btn-small`, label);
    node.type = 'button';
    node.disabled = Boolean(disabled);
    if (ariaLabel) {
        node.setAttribute('aria-label', ariaLabel);
    }
    node.addEventListener('click', onClick);
    return node;
}

/**
 * Read a string field without trusting its type.
 *
 * @param {...unknown} values
 * @returns {string}
 */
function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim() !== '') {
            return value.trim();
        }
    }
    return '';
}

/**
 * Turn whatever the sync object exposes into a flat, deduplicated list.
 *
 * @param {unknown} value
 * @returns {{ name: string, state: string }[]}
 */
function normalizeProjects(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set();
    const projects = [];

    for (const item of value) {
        let name = '';
        let state = '';

        if (typeof item === 'string') {
            name = item;
        } else if (item && typeof item === 'object') {
            name = firstString(item.name);
            state = firstString(item.syncState, item.state, item.sync && item.sync.state);
        }

        name = name.trim();
        if (!name || seen.has(name)) {
            continue;
        }

        seen.add(name);
        projects.push({ name, state });
    }

    return projects;
}

/**
 * Mount the project list.
 *
 * @param {HTMLElement} element Container supplied by the caller.
 * @param {object} sync The `Sync` object from `js/sync.js`.
 * @param {{ onDelete?: (name: string) => unknown, onOpen?: (name: string) => unknown, onStart?: () => unknown }} [options]
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function mountProjects(element, sync, options = {}) {
    if (!element) {
        throw new TypeError('mountProjects needs a container element.');
    }

    const onDelete = typeof options?.onDelete === 'function' ? options.onDelete : null;
    const onOpen = typeof options?.onOpen === 'function' ? options.onOpen : null;
    const onStart = typeof options?.onStart === 'function' ? options.onStart : null;

    const root = document.createElement('div');
    root.className = 'sync-projects';
    element.replaceChildren(root);

    let destroyed = false;
    let projects = [];
    let loading = false;
    let actionError = '';
    let loadToken = 0;
    const deleting = new Set();

    function render() {
        if (destroyed) {
            return;
        }

        root.replaceChildren();

        if (actionError) {
            const message = el('p', 'sync-small sync-error', actionError);
            message.setAttribute('role', 'alert');
            message.setAttribute('aria-live', 'polite');
            root.append(message);
        }

        if (loading) {
            const message = el('p', 'sync-empty', 'Loading projects…');
            message.setAttribute('aria-live', 'polite');
            root.append(message);
            return;
        }

        if (projects.length === 0) {
            const empty = el('div', 'sync-empty');
            empty.append(
                el('p', 'sync-empty-text', 'Nothing saved on this device yet.'),
                el(
                    'p',
                    'sync-meta',
                    'Projects you save in pydle are kept here, so they open without a connection.',
                ),
                button('Open the editor', 'quiet', startEditor, {
                    ariaLabel: 'Close this dialog and open the editor',
                }),
            );
            root.append(empty);
            return;
        }

        const list = el('ul', 'sync-project-list');
        list.setAttribute('aria-label', 'Projects');

        for (const project of projects) {
            list.append(renderRow(project));
        }

        root.append(list);
    }

    /**
     * @param {{ name: string, state: string }} project
     * @returns {HTMLLIElement}
     */
    function renderRow(project) {
        const row = el('li', 'sync-project');
        const main = el('div', 'sync-project-main');
        main.append(el('span', 'sync-project-name', project.name));

        const known = STATE_LABELS[project.state];
        if (known) {
            const state = el(
                'span',
                `sync-project-state sync-project-state-${known.tone}`,
                known.label,
            );
            main.append(state);
        } else if (sync?.status === 'offline') {
            main.append(
                el('span', 'sync-project-state sync-project-state-local', 'Saved on this device'),
            );
        }

        row.append(main);

        if (onOpen || onDelete) {
            const actions = el('div', 'sync-project-actions');

            if (onOpen) {
                actions.append(
                    button('Open', 'quiet', () => openProject(project.name), {
                        ariaLabel: `Open ${project.name}`,
                    }),
                );
            }

            if (onDelete) {
                const isDeleting = deleting.has(project.name);
                actions.append(
                    button(isDeleting ? 'Deleting…' : 'Delete', 'danger', () => {
                        removeProject(project.name);
                    }, {
                        disabled: isDeleting,
                        ariaLabel: `Delete ${project.name}`,
                    }),
                );
            }

            row.append(actions);
        }

        return row;
    }

    /**
     * Leave the dialog and put the cursor in the editor.
     */
    function startEditor() {
        if (onStart) {
            try {
                onStart();
                return;
            } catch {
                // Fall through to the plain page behaviour.
            }
        }
        const overlay = root.closest('.overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
        const editor = document.getElementById('code-editor');
        if (editor && typeof editor.focus === 'function') {
            editor.focus();
        }
    }

    /**
     * @param {string} name
     */
    function openProject(name) {        if (onOpen) {
            try {
                const result = onOpen(name);
                if (result && typeof result.catch === 'function') {
                    result.catch(() => {
                        actionError = 'That project could not be opened.';
                        render();
                    });
                }
            } catch {
                actionError = 'That project could not be opened.';
                render();
                return;
            }
        }

        window.location.hash = `#project=${encodeURIComponent(name)}`;
    }

    /**
     * @param {string} name
     */
    async function removeProject(name) {
        if (!onDelete || deleting.has(name)) {
            return;
        }

        deleting.add(name);
        actionError = '';
        render();

        let failed = false;

        try {
            await onDelete(name);
        } catch {
            if (!destroyed) {
                actionError = `“${name}” could not be deleted. Try again.`;
                failed = true;
            }
        } finally {
            deleting.delete(name);
            if (!destroyed) {
                if (failed) {
                    render();
                } else {
                    update();
                }
            }
        }
    }

    /**
     * Fetch the list, then render. Guards against an older fetch landing late.
     */
    function update() {
        if (destroyed) {
            return;
        }

        actionError = '';

        const hasArray = Array.isArray(sync?.projects);
        const canList = typeof sync?.listProjects === 'function';

        if (!hasArray && canList) {
            const token = ++loadToken;
            loading = true;
            projects = [];
            render();

            Promise.resolve()
                .then(() => sync.listProjects())
                .then((value) => {
                    if (destroyed || token !== loadToken) {
                        return;
                    }
                    projects = normalizeProjects(value);
                    loading = false;
                    render();
                })
                .catch(() => {
                    if (destroyed || token !== loadToken) {
                        return;
                    }
                    projects = [];
                    loading = false;
                    actionError = 'Projects could not be loaded. Your work is still on this device.';
                    render();
                });

            return;
        }

        loadToken += 1;
        loading = false;
        projects = normalizeProjects(sync?.projects);
        render();
    }

    const unsubscribe = subscribe(sync, update);

    update();

    return {
        update,
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            loadToken += 1;
            unsubscribe();
            element.replaceChildren();
        },
    };
}
