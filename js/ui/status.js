/**
 * Toolbar control for the GitHub connection.
 *
 * This is the discoverable front door to the "Your work" dialog. When nobody
 * is signed in it reads "Connect GitHub" and is a real button, because a dim
 * status line with a hollow dot does not tell anyone where to start.
 *
 * All text is set with `textContent`: the login name comes from the GitHub API.
 */

import { CONFIG } from '../config.js';

/** Event the page listens for to open the Your work dialog. */
const OPEN_EVENT = 'pydle:open-sync';

/**
 * Subscribe to sync status changes when the implementation offers it.
 *
 * Accepts either an unsubscribe function or an object with an `unsubscribe`
 * method. A missing `onStatus` is not an error.
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
        // A status stream is a nicety; `update()` still works without it.
    }

    return () => {};
}

/**
 * Build a `<span>` with optional class and text.
 *
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLSpanElement}
 */
function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/**
 * Mount the sync control.
 *
 * @param {HTMLElement} element Container supplied by the caller.
 * @param {object} sync The `Sync` object from `js/sync.js`.
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function mountStatus(element, sync) {
    if (!element) {
        throw new TypeError('mountStatus needs a container element.');
    }

    const root = document.createElement('span');
    root.className = 'sync-status';

    let destroyed = false;
    let lastSignature = '';

    /**
     * Ask the page to open the Your work dialog. A custom event keeps this
     * module independent of the overlay markup and of how it is wired up.
     */
    function openDialog() {
        root.dispatchEvent(new CustomEvent(OPEN_EVENT, { bubbles: true }));
    }

    /**
     * A quiet button: calmer than the primary Run action, but unmistakably a
     * control rather than a read-only label.
     *
     * @param {string} text
     * @param {string} description
     * @param {boolean} hollow
     * @returns {HTMLButtonElement}
     */
    function control(text, description, hollow) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sync-connect';
        button.setAttribute('aria-label', description);
        button.title = description;
        button.setAttribute('aria-haspopup', 'dialog');

        const dot = span('sync-status-dot');
        dot.setAttribute('aria-hidden', 'true');
        if (hollow) {
            dot.dataset.hollow = 'true';
        }

        button.append(dot, span('sync-status-label', text));
        button.addEventListener('click', openDialog);
        return button;
    }

    /**
     * A non-interactive status line, for the moment between pressing sign in
     * and GitHub answering.
     *
     * @param {string} text
     * @returns {HTMLSpanElement}
     */
    function statusLine(text) {
        const line = span('sync-status-line');
        const dot = span('sync-status-dot');
        dot.setAttribute('aria-hidden', 'true');
        const label = span('sync-status-label', text);
        label.setAttribute('aria-live', 'polite');
        line.append(dot, label);
        return line;
    }

    /**
     * Build the current control. Returns null when there is no OAuth app, so
     * the whole affordance disappears rather than opening an empty dialog.
     *
     * @returns {HTMLElement | null}
     */
    function build() {
        if (!CONFIG || !CONFIG.clientId) {
            return null;
        }

        const status = typeof sync?.status === 'string' ? sync.status : 'signed-out';
        const login = typeof sync?.identity?.login === 'string' ? sync.identity.login : '';

        switch (status) {
            case 'connecting':
                return statusLine('Connecting to GitHub…');
            case 'connected':
                return control(
                    login ? `Signed in as ${login}` : 'Signed in to GitHub',
                    login
                        ? `Signed in to GitHub as ${login}. Open Your work.`
                        : 'Signed in to GitHub. Open Your work.',
                    false,
                );
            case 'offline':
                return control(
                    'Offline. Saved on this device.',
                    'Offline. Your work is saved on this device. Open Your work to see the GitHub connection.',
                    false,
                );
            case 'error':
                return control(
                    'Not connected. Your work is safe.',
                    'Not connected. Your work is saved on this device. Open Your work to try signing in again.',
                    false,
                );
            case 'signed-out':
            default:
                return control(
                    'Connect GitHub',
                    'Connect GitHub. Your work stays on this device too.',
                    true,
                );
        }
    }

    function render() {
        if (destroyed) {
            return;
        }

        const status = typeof sync?.status === 'string' ? sync.status : 'signed-out';
        const login = typeof sync?.identity?.login === 'string' ? sync.identity.login : '';
        const signature = `${status}|${login}|${Boolean(CONFIG && CONFIG.clientId)}`;
        if (signature === lastSignature) {
            return;
        }
        lastSignature = signature;

        root.dataset.state = status;
        root.replaceChildren();

        const node = build();
        if (node) {
            root.appendChild(node);
        }
        root.hidden = node === null;
    }

    const unsubscribe = subscribe(sync, render);

    render();
    element.replaceChildren(root);

    return {
        update() {
            render();
        },
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            unsubscribe();
            element.replaceChildren();
        },
    };
}
