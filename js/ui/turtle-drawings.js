/**
 * The drawings list.
 *
 * Presentational only, like `projects.js`: the page supplies the list and the
 * actions, so this module never reads the vault itself. Each row shows a
 * drawing's name and when it was last saved, with one action to open it and one
 * to delete it.
 *
 * Names and dates are written with `textContent`. A failed action is reported
 * in the list rather than thrown into the page.
 */

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

/** One formatter for the whole page: the same drawing always reads the same. */
const WHEN = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

/**
 * When a drawing was last saved, in words.
 *
 * @param {number} updatedAt Milliseconds since the epoch, or 0 when unknown.
 * @returns {string}
 */
export function formatWhen(updatedAt) {
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
        return 'Last modified: not recorded';
    }
    try {
        return 'Last modified ' + WHEN.format(new Date(updatedAt));
    } catch {
        return 'Last modified: not recorded';
    }
}

/**
 * Mount the drawings list.
 *
 * @param {HTMLElement} element Container supplied by the caller. It is emptied.
 * @param {{
 *   list: () => Promise<Array<{ name: string, updatedAt: number }>>,
 *   getCurrent?: () => string | null,
 *   onOpen?: (name: string) => unknown,
 *   onDelete?: (name: string) => unknown,
 * }} options
 * @returns {{ refresh: () => Promise<void>, setCurrent: () => void, destroy: () => void }}
 */
export function mountDrawings(element, options = {}) {
    if (!element) {
        throw new TypeError('mountDrawings needs a container element.');
    }

    const list = typeof options.list === 'function' ? options.list : null;
    const getCurrent = typeof options.getCurrent === 'function' ? options.getCurrent : () => null;
    const onOpen = typeof options.onOpen === 'function' ? options.onOpen : null;
    const onDelete = typeof options.onDelete === 'function' ? options.onDelete : null;

    /** @type {Array<{ name: string, updatedAt: number }>} */
    let drawings = [];
    let loading = false;
    let error = '';
    let token = 0;
    let destroyed = false;
    const busy = new Set();

    const root = document.createElement('div');
    root.className = 'drawings-list';
    element.replaceChildren(root);

    /**
     * Run an action, letting a rejection become a quiet line in the list.
     *
     * @param {(() => unknown) | null} action
     * @param {string} failure
     */
    function run(action, failure) {
        if (!action) {
            return;
        }
        error = '';
        try {
            const result = action();
            if (result && typeof result.then === 'function') {
                result.catch(() => {
                    if (!destroyed) {
                        error = failure;
                        render();
                    }
                });
            }
        } catch {
            error = failure;
            render();
        }
    }

    /**
     * @param {{ name: string, updatedAt: number }} drawing
     * @returns {HTMLLIElement}
     */
    function renderRow(drawing) {
        const row = el('li', 'drawing-item');
        const isCurrent = drawing.name === getCurrent();
        row.classList.toggle('is-current', isCurrent);

        const open = el('button', 'drawing-open');
        open.type = 'button';
        open.title = 'Open ' + drawing.name;
        if (isCurrent) {
            open.setAttribute('aria-current', 'true');
        }
        open.append(
            el('span', 'drawing-name', drawing.name),
            el('span', 'drawing-when', formatWhen(drawing.updatedAt)),
        );
        open.addEventListener('click', () => {
            run(onOpen && (() => onOpen(drawing.name)), 'That drawing could not be opened.');
        });

        const remove = el('button', 'drawing-delete', busy.has(drawing.name) ? 'Deleting...' : 'Delete');
        remove.type = 'button';
        remove.disabled = busy.has(drawing.name);
        remove.setAttribute('aria-label', 'Delete ' + drawing.name);
        remove.title = 'Delete ' + drawing.name;
        remove.addEventListener('click', async () => {
            if (!onDelete || busy.has(drawing.name)) {
                return;
            }
            busy.add(drawing.name);
            error = '';
            render();
            try {
                await onDelete(drawing.name);
            } catch {
                if (!destroyed) {
                    error = '“' + drawing.name + '” could not be deleted. Try again.';
                }
            } finally {
                busy.delete(drawing.name);
                if (!destroyed) {
                    await refresh();
                }
            }
        });

        row.append(open, remove);
        return row;
    }

    function render() {
        if (destroyed) {
            return;
        }

        root.replaceChildren();

        if (error !== '') {
            const note = el('p', 'drawings-error', error);
            note.setAttribute('role', 'alert');
            root.append(note);
        }

        if (loading) {
            const note = el('p', 'drawings-empty', 'Loading drawings...');
            note.setAttribute('aria-live', 'polite');
            root.append(note);
            return;
        }

        if (drawings.length === 0) {
            const empty = el('div', 'drawings-empty');
            empty.append(
                el('p', 'drawings-empty-text', 'No drawings saved yet.'),
                el(
                    'p',
                    'drawings-empty-hint',
                    'Use Save to keep a drawing on this device, then commit it to your GitHub repository.',
                ),
            );
            root.append(empty);
            return;
        }

        const items = el('ul', 'drawings-items');
        items.setAttribute('aria-label', 'Saved drawings');
        for (const drawing of drawings) {
            items.append(renderRow(drawing));
        }
        root.append(items);
    }

    async function refresh() {
        if (destroyed) {
            return;
        }

        const current = ++token;
        loading = true;
        render();

        let next = [];
        if (list) {
            try {
                next = await list();
            } catch {
                next = [];
            }
        }

        if (destroyed || current !== token) {
            return;
        }

        drawings = Array.isArray(next)
            ? next
                  .filter((drawing) => drawing && typeof drawing.name === 'string')
                  .map((drawing) => ({
                      name: drawing.name,
                      updatedAt: Number.isFinite(drawing.updatedAt) ? drawing.updatedAt : 0,
                  }))
            : [];
        loading = false;
        render();
    }

    return {
        refresh,
        setCurrent() {
            if (!destroyed && !loading) {
                render();
            }
        },
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            token += 1;
            element.replaceChildren();
        },
    };
}
