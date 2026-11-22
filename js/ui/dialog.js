/**
 * In-page dialogs: a prompt, a confirmation and a notification.
 *
 * The browser's own alert/confirm/prompt are unavailable inside some embeds,
 * cannot be themed and cannot be styled. These three functions replace them
 * with one small overlay built from the same tokens as the rest of pydle.
 *
 *   promptText({ title, label, value, confirmLabel, hint, validate })
 *       -> Promise<string | null>   null when cancelled
 *   confirmAction({ title, message, confirmLabel, danger })
 *       -> Promise<boolean>
 *   notify({ title, message, variant })
 *       -> Promise<void>
 *
 * Everything a caller supplies is written with `textContent`, never as HTML.
 * Only one overlay is ever in the document: calls made while a dialog is open
 * wait their turn, so an alert triggered from behind a confirm cannot stack a
 * second card invisibly.
 */

/** Distinguishes the label and description ids of each dialog. */
let sequence = 0;

/** The dialog currently on screen, if any. */
let active = null;

/** Calls waiting for the open dialog to close. */
const waiting = [];

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
 * Run `open` after any dialog already on screen has closed.
 *
 * @template T
 * @param {() => Promise<T>} open
 * @returns {Promise<T>}
 */
function enqueue(open) {
    return new Promise((resolve) => {
        waiting.push({ open, resolve });
        drain();
    });
}

function drain() {
    if (active !== null || waiting.length === 0) {
        return;
    }

    const entry = waiting.shift();
    active = entry;

    let result;
    try {
        result = entry.open();
    } catch {
        active = null;
        entry.resolve(undefined);
        drain();
        return;
    }

    Promise.resolve(result)
        .then(
            (value) => entry.resolve(value),
            () => entry.resolve(undefined),
        )
        .finally(() => {
            active = null;
            drain();
        });
}

/**
 * All the controls a Tab press may land on, in DOM order.
 *
 * @param {HTMLElement} panel
 * @returns {HTMLElement[]}
 */
function focusables(panel) {
    const selector = 'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';
    return [...panel.querySelectorAll(selector)].filter((node) => {
        if (!(node instanceof HTMLElement)) {
            return false;
        }
        if (node.hasAttribute('disabled') || node.getAttribute('aria-hidden') === 'true') {
            return false;
        }
        return node.offsetParent !== null;
    });
}

/**
 * Build the overlay, wire its keyboard behaviour, and settle one promise when
 * it closes. Shared by all three public functions.
 *
 * @param {{
 *   title: string,
 *   message?: string,
 *   build?: (body: HTMLElement) => void,
 *   actions: Array<{
 *     label: string,
 *     variant?: 'primary' | 'quiet' | 'danger',
 *     value: unknown,
 *     onSubmit?: () => boolean,
 *     autofocus?: boolean,
 *   }>,
 *   initialFocus?: () => HTMLElement | null,
 *   cancelValue: unknown,
 *   tone?: 'error' | 'info',
 * }} options
 * @returns {Promise<unknown>}
 */
function createShell({
    title,
    message,
    build,
    actions,
    initialFocus,
    cancelValue,
    tone,
}) {
    const previous =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = ++sequence;

    const overlay = el('div', 'dialog-overlay');
    const backdrop = el('div', 'dialog-backdrop');
    const panel = el('div', 'dialog-panel');
    if (tone === 'error' || tone === 'info') {
        panel.classList.add(`dialog-tone-${tone}`);
    }
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const titleId = `dialog-title-${id}`;
    panel.setAttribute('aria-labelledby', titleId);

    const header = el('div', 'dialog-header');
    const heading = el('h2', 'dialog-title', title);
    heading.id = titleId;
    header.appendChild(heading);

    const body = el('div', 'dialog-body');

    if (message !== undefined) {
        const note = el('p', 'dialog-message', message);
        const noteId = `dialog-message-${id}`;
        note.id = noteId;
        panel.setAttribute('aria-describedby', noteId);
        body.appendChild(note);
    }

    if (typeof build === 'function') {
        build(body);
    }

    const footer = el('div', 'dialog-footer');
    const buttons = [];

    panel.append(header, body, footer);
    overlay.append(backdrop, panel);

    let closed = false;
    /** @type {HTMLElement | null} */
    let focusTarget = null;

    /**
     * Close the dialog, restore focus and settle the promise.
     *
     * @param {unknown} value
     */
    function finish(value) {
        if (closed) {
            return;
        }
        closed = true;
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();

        const back = previous && previous.isConnected ? previous : null;
        if (back && typeof back.focus === 'function') {
            back.focus({ preventScroll: true });
        }
        resolveShell(value);
    }

    /** @type {(value: unknown) => void} */
    let resolveShell = () => {};

    for (const action of actions) {
        const variant = action.variant || 'primary';
        const button = el('button', `dialog-btn dialog-btn-${variant}`, action.label);
        button.type = 'button';
        button.addEventListener('click', () => {
            if (typeof action.onSubmit === 'function' && action.onSubmit() === false) {
                return;
            }
            finish(action.value);
        });
        if (action.autofocus) {
            focusTarget = button;
        }
        buttons.push(button);
        footer.appendChild(button);
    }

    /**
     * Escape cancels; Tab stays inside the card.
     *
     * @param {KeyboardEvent} event
     */
    function onKeydown(event) {
        if (closed) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(cancelValue);
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const items = focusables(panel);
        if (items.length === 0) {
            event.preventDefault();
            panel.focus({ preventScroll: true });
            return;
        }

        const first = items[0];
        const last = items[items.length - 1];
        const current = document.activeElement;

        if (event.shiftKey) {
            if (current === first || !panel.contains(current)) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            }
        } else if (current === last || !panel.contains(current)) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target === backdrop) {
            finish(cancelValue);
        }
    });

    document.addEventListener('keydown', onKeydown, true);

    return new Promise((resolve) => {
        resolveShell = resolve;
        document.body.appendChild(overlay);

        let target = focusTarget;
        if (!target && typeof initialFocus === 'function') {
            target = initialFocus();
        }
        if (!target && buttons.length > 0) {
            target = buttons[0];
        }
        if (target) {
            target.focus({ preventScroll: true });
            if (target instanceof HTMLInputElement && typeof target.select === 'function') {
                target.select();
            }
        } else {
            panel.focus({ preventScroll: true });
        }
    });
}

/**
 * Ask for a single line of text.
 *
 * `validate(value)` runs when the form is confirmed. Return `null` when the
 * value is acceptable, or a short message to show inline. An invalid value
 * keeps the dialog open with the text exactly as typed.
 *
 * @param {{
 *   title: string,
 *   label: string,
 *   value?: string,
 *   confirmLabel?: string,
 *   hint?: string,
 *   validate?: (value: string) => string | null,
 * }} options
 * @returns {Promise<string | null>}
 */
export function promptText({
    title,
    label,
    value = '',
    confirmLabel = 'Save',
    hint = '',
    validate,
} = {}) {
    /** @type {HTMLInputElement} */
    let input;
    /** @type {HTMLElement} */
    let error;

    return enqueue(() =>
        createShell({
            title: typeof title === 'string' ? title : '',
            cancelValue: null,
            initialFocus: () => input,
            actions: [
                { label: 'Cancel', variant: 'quiet', value: null },
                { label: confirmLabel, variant: 'primary', value: undefined, onSubmit: attempt },
            ],
            build(body) {
                const fieldId = `dialog-field-${sequence + 1}`;

                const labelNode = el('label', 'dialog-label', label);
                labelNode.htmlFor = fieldId;

                input = el('input', 'dialog-input');
                input.type = 'text';
                input.id = fieldId;
                input.value = String(value);
                input.autocomplete = 'off';
                input.spellcheck = false;

                error = el('p', 'dialog-error');
                error.setAttribute('role', 'alert');

                body.append(labelNode, input);
                if (typeof hint === 'string' && hint !== '') {
                    body.append(el('p', 'dialog-hint', hint));
                }
                body.append(error);

                input.addEventListener('input', () => {
                    error.textContent = '';
                });

                input.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter') {
                        return;
                    }
                    event.preventDefault();
                    if (attempt() !== false) {
                        // `attempt` cannot finish the dialog itself; click the
                        // primary button so the shell owns the lifecycle.
                        const primary = document.querySelector(
                            '.dialog-overlay .dialog-btn-primary',
                        );
                        if (primary instanceof HTMLElement) {
                            primary.click();
                        }
                    }
                });
            },
        }),
    ).then((result) => (typeof result === 'string' ? result : null));

    /**
     * Check the field, showing any reason inline.
     *
     * @returns {boolean} False when the dialog must stay open.
     */
    function attempt() {
        const raw = input.value;
        const problem = typeof validate === 'function' ? validate(raw) : null;
        if (typeof problem === 'string' && problem !== '') {
            error.textContent = problem;
            input.focus({ preventScroll: true });
            return false;
        }
        error.textContent = '';
        return true;
    }
}

/**
 * Ask for confirmation.
 *
 * @param {{
 *   title: string,
 *   message: string,
 *   confirmLabel?: string,
 *   danger?: boolean,
 * }} options
 * @returns {Promise<boolean>}
 */
export function confirmAction({
    title,
    message,
    confirmLabel = 'Confirm',
    danger = false,
} = {}) {
    return enqueue(() =>
        createShell({
            title: typeof title === 'string' ? title : '',
            message: typeof message === 'string' ? message : '',
            cancelValue: false,
            actions: [
                { label: 'Cancel', variant: 'quiet', value: false, autofocus: Boolean(danger) },
                {
                    label: confirmLabel,
                    variant: danger ? 'danger' : 'primary',
                    value: true,
                    autofocus: !danger,
                },
            ],
        }),
    ).then((result) => result === true);
}

/**
 * Show a short message with a single acknowledgement.
 *
 * @param {{
 *   title: string,
 *   message: string,
 *   variant?: 'error' | 'info',
 * }} options
 * @returns {Promise<void>}
 */
export function notify({ title, message, variant = 'error' } = {}) {
    const kind = variant === 'info' ? 'info' : 'error';

    return enqueue(() =>
        createShell({
            title: typeof title === 'string' ? title : '',
            message: typeof message === 'string' ? message : '',
            cancelValue: undefined,
            tone: kind,
            actions: [{ label: 'OK', variant: 'primary', value: undefined, autofocus: true }],
        }),
    ).then(() => {
        // `variant` only selects the colour treatment; the words carry meaning.
    });
}
