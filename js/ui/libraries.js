/**
 * The library picker for the file rail.
 *
 * A project declares what it needs in `requirements.txt`, and this dialog is a
 * view over that file: ticking a box calls the page's `add`, unticking calls
 * `remove`, and both write immediately. There is no separate list of installed
 * libraries to drift out of step with the file.
 *
 * The catalogue lives in `js/packages.js`, which also owns the text rules. This
 * module only renders it and reports a failure beside the box that failed, so a
 * write that did not happen is never shown as a tick that did.
 *
 * One dialog is mounted per page, normally into a host element the page owns.
 * The page supplies the storage callbacks, which keeps the vault seam out of
 * the view layer:
 *
 *     const libraries = mountLibraries(host, {
 *         list: () => sync.readProject(name).then((files) => parseRequirements(files['requirements.txt'])),
 *         add: (pkg) => writeRequirements(addPackage(text, pkg)),
 *         remove: (pkg) => writeRequirements(removePackage(text, pkg)),
 *         available: true,
 *     });
 *     libraries.open();
 *
 * Every value from the catalogue or from a callback is written with
 * `textContent`, never as HTML.
 */

import { CATALOGUE } from '../packages.js';

/** Distinguishes the control ids of each mounted dialog. */
let sequence = 0;

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
 * Make sure the picker's stylesheet is present.
 *
 * `index.html` is not this module's to edit, so the one stylesheet this view
 * needs is attached here. The page may also link it directly; the href check
 * keeps that from producing two copies.
 */
function ensureStylesheet() {
    if (typeof document === 'undefined') {
        return;
    }

    const href = new URL('../../css/libraries.css', import.meta.url).href;
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    for (const link of links) {
        if (link instanceof HTMLLinkElement && link.href === href) {
            return;
        }
    }

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = href;
    stylesheet.dataset.pydleLibraries = '';
    document.head.appendChild(stylesheet);
}

/**
 * Mount the library picker.
 *
 * @param {HTMLElement} root Container the overlay is appended to.
 * @param {{
 *   list?: () => Promise<string[]>,
 *   add?: (name: string) => Promise<void>,
 *   remove?: (name: string) => Promise<void>,
 *   available?: boolean,
 * }} [options]
 *   `available` false means this copy of pydle has no libraries at all; the
 *   dialog then explains that and leaves every box disabled rather than
 *   accepting a choice that cannot work.
 * @returns {{ open: () => void, close: () => void }}
 */
export function mountLibraries(root, options = {}) {
    const host = root instanceof HTMLElement ? root : document.body;
    ensureStylesheet();

    const list = typeof options.list === 'function' ? options.list : async () => [];
    const add = typeof options.add === 'function' ? options.add : async () => {};
    const remove = typeof options.remove === 'function' ? options.remove : async () => {};
    const available = options.available !== false;

    const id = ++sequence;
    const titleId = `libraries-title-${id}`;
    const noteId = `libraries-note-${id}`;

    /* Shell ------------------------------------------------------------- */

    const overlay = el('div', 'dialog-overlay libraries-overlay');
    overlay.hidden = true;

    const backdrop = el('div', 'dialog-backdrop');
    const panel = el('div', 'dialog-panel libraries-panel');
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', titleId);
    panel.setAttribute('aria-describedby', noteId);

    const header = el('div', 'dialog-header');
    const title = el('h2', 'dialog-title', 'Libraries');
    title.id = titleId;
    header.appendChild(title);

    const body = el('div', 'dialog-body libraries-body');

    const note = el('p', 'libraries-note');
    note.id = noteId;
    note.setAttribute('aria-live', 'polite');
    note.textContent = available
        ? 'Ticking a library writes it to requirements.txt. Libraries are downloaded once per device, and the first use needs a connection.'
        : 'This copy of pydle does not include any libraries, so none can be added here. requirements.txt is left unchanged.';

    const listNode = el('ul', 'libraries-list');
    listNode.setAttribute('aria-label', 'Libraries you can add to this project');

    const status = el('p', 'libraries-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    body.append(note, status, listNode);

    const footer = el('div', 'dialog-footer');
    const doneBtn = el('button', 'dialog-btn dialog-btn-primary', 'Done');
    doneBtn.type = 'button';
    footer.appendChild(doneBtn);

    panel.append(header, body, footer);
    overlay.append(backdrop, panel);
    host.appendChild(overlay);

    /* Catalogue --------------------------------------------------------- */

    /** @type {Map<string, HTMLInputElement>} */
    const inputs = new Map();

    for (const entry of CATALOGUE) {
        const item = el('li', 'libraries-item');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'libraries-check';
        input.id = `libraries-${id}-${entry.id}`;
        input.dataset.package = entry.id;
        input.disabled = !available;

        const label = el('label', 'libraries-row');
        label.htmlFor = input.id;

        const head = el('span', 'libraries-row-head');
        head.append(
            el('span', 'libraries-name', entry.label),
            el('span', 'libraries-size', entry.size),
        );
        label.append(head, el('span', 'libraries-summary', entry.summary));

        item.append(input, label);
        input.addEventListener('change', () => {
            void toggle(entry, input);
        });

        inputs.set(entry.id, input);
        listNode.appendChild(item);
    }

    /* State ------------------------------------------------------------- */

    let isOpen = false;
    /** A write is in flight; every box waits so two edits cannot race. */
    let busy = false;
    /** Bumped on open and close, so a late list() cannot repaint a dead dialog. */
    let token = 0;

    /** @type {HTMLElement | null} */
    let returnFocus = null;

    /* Rendering --------------------------------------------------------- */

    /**
     * @param {string} text
     * @param {boolean} [error]
     */
    function setStatus(text, error = false) {
        status.textContent = text;
        status.classList.toggle('is-error', text !== '' && error);
    }

    function paintBusy() {
        for (const input of inputs.values()) {
            input.disabled = !available || busy;
        }
        listNode.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    /** @returns {HTMLElement[]} */
    function focusables() {
        const selector = 'button:not([disabled]), input:not([disabled])';
        return [...panel.querySelectorAll(selector)].filter((node) => {
            return node instanceof HTMLElement && node.offsetParent !== null;
        });
    }

    function focusFirstCheckbox() {
        for (const input of inputs.values()) {
            if (!input.disabled) {
                input.focus({ preventScroll: true });
                return;
            }
        }
        doneBtn.focus({ preventScroll: true });
    }

    /* Loading ----------------------------------------------------------- */

    async function load() {
        const mine = ++token;
        busy = true;
        paintBusy();
        setStatus('Reading requirements.txt...');

        let names;
        try {
            names = await list();
        } catch {
            if (isOpen && mine === token) {
                busy = false;
                paintBusy();
                setStatus('Could not read requirements.txt. Close this and try again.', true);
            }
            return;
        }

        if (!isOpen || mine !== token) {
            return;
        }

        const present = new Set(
            (Array.isArray(names) ? names : []).map((name) => String(name).trim().toLowerCase()),
        );
        for (const [packageId, input] of inputs) {
            input.checked = present.has(packageId.toLowerCase());
        }

        busy = false;
        paintBusy();
        setStatus('');

        // On first open focus is on the panel, so land on the first choice now
        // that there is one.
        if (document.activeElement === panel || document.activeElement === document.body) {
            focusFirstCheckbox();
        }
    }

    /* Writing ----------------------------------------------------------- */

    /**
     * Tick or untick one library, writing immediately.
     *
     * The tick moves first so the control responds at once. If the write is
     * refused, the tick is put back and the reason is shown in the live region
     * above the Done button, which is the truthful state: the file did not
     * change.
     *
     * @param {{ id: string, label: string }} entry
     * @param {HTMLInputElement} input
     */
    async function toggle(entry, input) {
        if (!available || busy) {
            return;
        }

        const wanted = input.checked;
        const previous = !wanted;

        busy = true;
        paintBusy();
        setStatus('');

        try {
            if (wanted) {
                await add(entry.label);
            } else {
                await remove(entry.label);
            }
        } catch (error) {
            input.checked = previous;
            const reason =
                error && typeof error.message === 'string' && error.message !== ''
                    ? error.message
                    : 'requirements.txt was not changed.';
            setStatus(
                `Could not ${wanted ? 'add' : 'remove'} ${entry.label}. ${reason}`,
                true,
            );
        } finally {
            busy = false;
            paintBusy();
            input.focus({ preventScroll: true });
        }
    }

    /* Lifecycle --------------------------------------------------------- */

    function open() {
        if (isOpen) {
            void load();
            return;
        }

        isOpen = true;
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        overlay.hidden = false;

        for (const input of inputs.values()) {
            input.checked = false;
        }
        setStatus('');
        busy = true;
        paintBusy();
        panel.focus({ preventScroll: true });

        void load();
    }

    function close() {
        if (!isOpen) {
            return;
        }

        isOpen = false;
        token += 1;
        busy = false;
        overlay.hidden = true;
        setStatus('');

        const back = returnFocus;
        returnFocus = null;
        if (back && back.isConnected) {
            back.focus({ preventScroll: true });
        }
    }

    /* Interaction ------------------------------------------------------- */

    /**
     * Escape closes, Tab stays inside the card.
     *
     * @param {KeyboardEvent} event
     */
    function onKeydown(event) {
        if (!isOpen) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const items = focusables();
        if (items.length === 0) {
            event.preventDefault();
            panel.focus({ preventScroll: true });
            return;
        }

        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;

        if (event.shiftKey) {
            if (active === first || !panel.contains(active)) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            }
        } else if (active === last || !panel.contains(active)) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }

    overlay.addEventListener('keydown', onKeydown);

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target === backdrop) {
            close();
        }
    });

    doneBtn.addEventListener('click', close);

    return { open, close };
}
