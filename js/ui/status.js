/**
 * Toolbar indicator for sync state.
 *
 * This is deliberately not a control: it never starts sign-in. The Connect panel
 * owns the buttons. All text is set with `textContent` because the login name
 * comes from the GitHub API.
 */

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
 * Mount the small sync indicator.
 *
 * @param {HTMLElement} element Container supplied by the caller.
 * @param {object} sync The `Sync` object from `js/sync.js`.
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function mountStatus(element, sync) {
    if (!element) {
        throw new TypeError('mountStatus needs a container element.');
    }

    const root = document.createElement('div');
    root.className = 'sync-status';

    const dot = span('sync-status-dot');
    dot.setAttribute('aria-hidden', 'true');

    const label = span('sync-status-label');
    label.setAttribute('aria-live', 'polite');

    root.append(dot, label);
    element.replaceChildren(root);

    let destroyed = false;

    function render() {
        if (destroyed) {
            return;
        }

        const status = typeof sync?.status === 'string' ? sync.status : 'signed-out';
        const login = typeof sync?.identity?.login === 'string' ? sync.identity.login : '';

        root.dataset.state = status;
        root.title = '';

        switch (status) {
            case 'connecting':
                label.textContent = 'Connecting to GitHub…';
                root.title = 'Signing in to GitHub.';
                break;
            case 'connected':
                label.textContent = login ? `Signed in as ${login}` : 'Signed in to GitHub';
                root.title = 'Your work is saved in your GitHub repository and on this device.';
                break;
            case 'offline':
                label.textContent = 'Offline — saved on this device';
                root.title = 'Your work is safe. pydle will catch up when you are online again.';
                break;
            case 'error':
                label.textContent = 'Not connected — your work is safe';
                root.title = 'Your work is still on this device. Open Your work to sign in again.';
                break;
            case 'signed-out':
            default:
                label.textContent = 'Not connected to GitHub';
                root.title = 'Your work is saved on this device. Sign in to keep a copy in your own repository.';
                break;
        }
    }

    const unsubscribe = subscribe(sync, render);

    render();

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
