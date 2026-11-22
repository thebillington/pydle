/**
 * The sign-in panel.
 *
 * Six views: welcome, the code to type, waiting, "create a workspace", connected,
 * and an error. Nothing here knows about GitHub internals — it calls the `Sync`
 * object and renders what comes back.
 *
 * Every piece of remote data (the user code, the login, the repository name) is
 * written with `textContent`, never `innerHTML`.
 */

const VERIFICATION_FALLBACK = 'https://github.com/login/device';

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
        // The panel still works from `update()`.
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
 * A real button, so it is reachable and operable by keyboard.
 *
 * @param {string} label
 * @param {'primary' | 'quiet' | 'danger'} variant
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
 * Normalise GitHub's code to ABCD-EFGH for display.
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatUserCode(value) {
    const clean = String(value ?? '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(0, 8);

    if (clean.length <= 4) {
        return clean;
    }
    return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

/**
 * Only follow an https github.com link; otherwise fall back to the known page.
 *
 * @param {unknown} value
 * @returns {string}
 */
function verificationHref(value) {
    try {
        const url = new URL(String(value ?? ''), VERIFICATION_FALLBACK);
        if (url.protocol === 'https:' && /(^|\.)github\.com$/i.test(url.hostname)) {
            return url.href;
        }
    } catch {
        // Fall through to the fixed address.
    }
    return VERIFICATION_FALLBACK;
}

/**
 * @param {number} seconds
 * @returns {string} `m:ss`
 */
function clock(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Turn any thrown value into an Error without leaking a stack trace into the DOM.
 *
 * @param {unknown} value
 * @returns {Error}
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
        if (typeof value.code === 'string') {
            error.code = value.code;
        }
        return error;
    }
    return new Error('Unknown error');
}

/**
 * Mount the sign-in panel.
 *
 * @param {HTMLElement} element Container supplied by the caller.
 * @param {object} sync The `Sync` object from `js/sync.js`.
 * @returns {{ update: () => void, destroy: () => void }}
 */
export function mountConnect(element, sync) {
    if (!element) {
        throw new TypeError('mountConnect needs a container element.');
    }

    const root = document.createElement('div');
    root.className = 'sync-panel';
    root.tabIndex = -1;
    element.replaceChildren(root);

    let destroyed = false;
    let busy = false;
    /** @type {null | { userCode: string, verificationUri: string, expiresIn: number }} */
    let code = null;
    /** @type {number | null} */
    let remaining = null;
    /** @type {Error | null} */
    let localError = null;
    /** @type {'signin' | 'connect' | 'workspace' | null} */
    let errorSource = null;
    let awaitingWorkspace = false;
    let idleOverride = false;
    /** @type {AbortController | null} */
    let controller = null;
    /** @type {HTMLElement | null} */
    let countdown = null;
    let lastView = '';

    /**
     * Which of the six views should be on screen.
     *
     * @returns {string}
     */
    function currentView() {
        if (localError) {
            return 'error';
        }
        if (code) {
            return 'waiting';
        }
        if (idleOverride) {
            return 'idle';
        }
        if (awaitingWorkspace) {
            return 'workspace';
        }

        const status = typeof sync?.status === 'string' ? sync.status : 'signed-out';
        const signedIn = Boolean(sync?.identity);

        if (status === 'connected' || (status === 'offline' && signedIn)) {
            return sync?.workspace ? 'connected' : 'workspace';
        }
        if (status === 'connecting') {
            return 'connecting';
        }
        if (status === 'error') {
            return 'error';
        }
        return 'idle';
    }

    /**
     * @returns {string}
     */
    function countdownText() {
        if (remaining === null) {
            return 'Code expires in 15:00';
        }
        return `Code expires in ${clock(remaining)}`;
    }

    /**
     * @param {number} seconds
     */
    function setRemaining(seconds) {
        remaining = seconds;
        if (countdown && countdown.isConnected) {
            countdown.textContent = countdownText();
        }
    }

    /**
     * Update just the countdown, so ticks never move focus or re-create buttons.
     *
     * @param {{ elapsed?: number, remaining?: number }} [tick]
     */
    function onTick(tick) {
        if (destroyed) {
            return;
        }
        const left = Number(tick?.remaining);
        if (Number.isFinite(left)) {
            setRemaining(Math.max(0, Math.round(left)));
        }
    }

    /**
     * Clear the local flow state before a new attempt.
     */
    function resetFlow() {
        code = null;
        remaining = null;
        localError = null;
        errorSource = null;
        awaitingWorkspace = false;
        idleOverride = false;
    }

    async function startSignIn() {
        if (busy || destroyed) {
            return;
        }
        if (typeof sync?.beginSignIn !== 'function') {
            localError = new Error('Sign-in is not available.');
            errorSource = 'signin';
            render();
            return;
        }

        busy = true;
        resetFlow();
        controller = new AbortController();
        render();

        try {
            await sync.beginSignIn({
                onCode(payload) {
                    if (destroyed) {
                        return;
                    }
                    const expiresIn = Number(payload?.expiresIn);
                    code = {
                        userCode: formatUserCode(payload?.userCode),
                        verificationUri: verificationHref(payload?.verificationUri),
                        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900,
                    };
                    remaining = code.expiresIn;
                    idleOverride = false;
                    render();
                },
                onTick,
                signal: controller.signal,
            });

            if (destroyed) {
                return;
            }
            code = null;
            remaining = null;
            if (!sync?.workspace) {
                awaitingWorkspace = true;
            }
        } catch (error) {
            if (destroyed) {
                return;
            }
            if (error && error.name === 'AbortError') {
                idleOverride = true;
            } else {
                localError = toError(error);
                errorSource = 'signin';
                code = null;
                remaining = null;
            }
        } finally {
            busy = false;
            controller = null;
            if (!destroyed) {
                code = null;
                remaining = null;
                render();
            }
        }
    }

    function cancelSignIn() {
        idleOverride = true;
        code = null;
        remaining = null;
        const active = controller;
        controller = null;
        if (typeof sync?.cancelSignIn === 'function') {
            try {
                sync.cancelSignIn();
            } catch {
                // The view has already returned to the welcome state.
            }
        }
        if (active) {
            active.abort();
        }
        render();
    }

    async function createWorkspace() {
        if (busy || destroyed) {
            return;
        }
        if (typeof sync?.createWorkspace !== 'function') {
            localError = new Error('Creating a workspace is not available.');
            errorSource = 'workspace';
            render();
            return;
        }

        busy = true;
        localError = null;
        errorSource = null;
        idleOverride = false;
        awaitingWorkspace = true;
        render();

        try {
            await sync.createWorkspace();
            awaitingWorkspace = !sync?.workspace;
        } catch (error) {
            if (destroyed) {
                return;
            }
            localError = toError(error);
            errorSource = 'workspace';
        } finally {
            busy = false;
            if (!destroyed) {
                render();
            }
        }
    }

    async function retryConnect() {
        if (busy || destroyed) {
            return;
        }
        if (typeof sync?.connect !== 'function') {
            localError = new Error('Connecting is not available.');
            errorSource = 'connect';
            render();
            return;
        }

        busy = true;
        localError = null;
        errorSource = null;
        idleOverride = false;
        render();

        try {
            await sync.connect();
            awaitingWorkspace = !sync?.workspace;
        } catch (error) {
            if (destroyed) {
                return;
            }
            localError = toError(error);
            errorSource = 'connect';
        } finally {
            busy = false;
            if (!destroyed) {
                render();
            }
        }
    }

    function disconnect() {
        if (busy) {
            return;
        }
        try {
            sync?.disconnect?.();
        } catch {
            // Fall through and re-render whatever state sync reports.
        }
        resetFlow();
        render();
    }

    /**
     * Choose the message and the one action offered in the error view.
     *
     * @returns {{ message: string, label: string, run: () => void }}
     */
    function errorPlan() {
        const error = localError || (sync && sync.error) || null;
        const kind = error && typeof error.kind === 'string' ? error.kind : '';
        const codeName = error && typeof error.code === 'string' ? error.code : '';

        if (codeName === 'expired_token') {
            return {
                message: 'That code expired before it was approved. Press Connect GitHub to get a new one.',
                label: 'Connect GitHub',
                run: startSignIn,
            };
        }
        if (codeName === 'access_denied') {
            return {
                message: 'The sign-in was cancelled on GitHub. You can try again whenever you like.',
                label: 'Connect GitHub',
                run: startSignIn,
            };
        }
        if (kind === 'auth' || errorSource === 'signin') {
            return {
                message: 'GitHub needs you to sign in again. Your work is safe on this device.',
                label: 'Reconnect GitHub',
                run: startSignIn,
            };
        }
        if (awaitingWorkspace) {
            return {
                message: 'The workspace could not be created. Nothing was changed. You can try again.',
                label: 'Try again',
                run: createWorkspace,
            };
        }
        if (kind === 'network') {
            return {
                message: 'We could not reach GitHub. Your work is safe on this device and will sync later.',
                label: 'Try again',
                run: retryConnect,
            };
        }
        return {
            message: 'Something went wrong while connecting. Your work is safe on this device.',
            label: 'Try again',
            run: retryConnect,
        };
    }

    function renderIdle() {
        root.append(
            el('p', 'sync-lede', 'Keep your work in your own GitHub repository. No account with us.'),
            el(
                'p',
                'sync-muted',
                'Sign in with GitHub and your projects are saved to a repository you own. Your work also stays on this device.',
            ),
        );

        const actions = el('div', 'sync-actions');
        actions.append(
            button('Connect GitHub', 'primary', startSignIn, { disabled: busy }),
            el('span', 'sync-small sync-muted', 'You will need a GitHub account.'),
        );
        root.append(actions);
    }

    function renderConnecting() {
        root.append(
            el('p', 'sync-lede', 'Asking GitHub for a code…'),
            el('p', 'sync-muted sync-small', 'This usually takes a moment.'),
        );

        const actions = el('div', 'sync-actions');
        actions.append(button('Cancel', 'quiet', cancelSignIn));
        root.append(actions);
    }

    function renderCode() {
        if (!code) {
            renderConnecting();
            return;
        }

        root.append(
            el('p', 'sync-lede', 'Enter this code on GitHub to sign in.'),
        );

        const codeRow = el('div', 'sync-code-row');
        const codeNode = el('code', 'sync-code', code.userCode || '—');
        codeNode.setAttribute('aria-label', 'Your sign-in code');
        const copyMessage = el('span', 'sync-small sync-muted sync-copy-message');
        copyMessage.setAttribute('aria-live', 'polite');

        const copy = button('Copy code', 'quiet', () => {
            copyCode(codeNode, copyMessage);
        }, { disabled: !code.userCode });

        codeRow.append(codeNode, copy);
        root.append(codeRow, copyMessage);

        root.append(
            el(
                'p',
                'sync-muted sync-small',
                'Only enter this code on a page you opened yourself. A code sent to you might not be from pydle.',
            ),
        );

        const link = el('a', 'sync-link', 'Open github.com/login/device');
        link.href = code.verificationUri;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        root.append(link);

        countdown = el('p', 'sync-countdown', countdownText());
        countdown.setAttribute('aria-live', 'polite');
        root.append(countdown);

        const actions = el('div', 'sync-actions sync-actions-between');
        actions.append(
            el('span', 'sync-waiting', 'Waiting for you to approve…'),
            button('Cancel', 'quiet', cancelSignIn),
        );
        root.append(actions);
    }

    function renderWorkspace() {
        const login = typeof sync?.identity?.login === 'string' ? sync.identity.login : '';

        root.append(
            el('p', 'sync-lede', 'You are signed in, but there is no pydle workspace yet.'),
        );

        if (login) {
            root.append(el('p', 'sync-muted sync-small', `Signed in as ${login}.`));
        }

        root.append(
            el(
                'p',
                'sync-muted',
                'No repository called pydle was found in your GitHub account. Create one to keep your work there. It is private, and only you can see it.',
            ),
        );

        const actions = el('div', 'sync-actions');
        actions.append(
            button(busy ? 'Creating…' : 'Create my workspace', 'primary', createWorkspace, {
                disabled: busy,
            }),
        );
        root.append(actions);
    }

    function renderConnected() {
        const workspace = sync?.workspace;
        const owner = workspace && typeof workspace.owner === 'string' ? workspace.owner : '';
        const repo = workspace && typeof workspace.repo === 'string' ? workspace.repo : '';
        const login = typeof sync?.identity?.login === 'string' ? sync.identity.login : '';
        const offline = sync?.status === 'offline';

        root.append(el('p', 'sync-lede', 'Your work is saved to your GitHub repository.'));

        if (owner && repo) {
            const line = el('p', 'sync-workspace');
            line.append(el('code', '', `${owner}/${repo}`));
            root.append(line);
        }

        if (login) {
            const line = el('p', 'sync-muted sync-small');
            line.append(document.createTextNode('Signed in as '), el('strong', '', login), document.createTextNode('.'));
            root.append(line);
        }

        root.append(el('p', 'sync-muted', 'Local work stays on this device as well.'));

        if (offline) {
            root.append(
                el('p', 'sync-muted sync-small', 'You are offline. Changes are kept here and will sync later.'),
            );
        }

        const actions = el('div', 'sync-actions');
        actions.append(button('Forget this device', 'quiet', disconnect, { disabled: busy }));
        root.append(actions);
    }

    function renderError() {
        const plan = errorPlan();
        root.append(el('p', 'sync-lede sync-error', plan.message));

        const actions = el('div', 'sync-actions');
        actions.append(button(plan.label, 'primary', plan.run, { disabled: busy }));
        root.append(actions);
    }

    /**
     * Replace the panel body from current state.
     */
    function render() {
        if (destroyed) {
            return;
        }

        countdown = null;

        if (awaitingWorkspace && sync?.workspace) {
            awaitingWorkspace = false;
        }
        if (sync?.status === 'signed-out') {
            awaitingWorkspace = false;
        }

        const view = currentView();
        const focusWasHere = root.contains(document.activeElement) || document.activeElement === document.body;

        root.dataset.view = view;
        root.replaceChildren();

        switch (view) {
            case 'waiting':
                renderCode();
                break;
            case 'connecting':
                renderConnecting();
                break;
            case 'workspace':
                renderWorkspace();
                break;
            case 'connected':
                renderConnected();
                break;
            case 'error':
                renderError();
                break;
            case 'idle':
            default:
                renderIdle();
                break;
        }

        if (view !== lastView && focusWasHere && lastView !== '') {
            root.focus({ preventScroll: true });
        }
        lastView = view;
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
            if (controller) {
                controller.abort();
                controller = null;
            }
            element.replaceChildren();
        },
    };
}

/**
 * Copy the code, with a selectable fallback when the clipboard is unavailable.
 *
 * @param {HTMLElement} codeNode
 * @param {HTMLElement} message
 */
async function copyCode(codeNode, message) {
    const text = codeNode.textContent || '';

    try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('Clipboard unavailable');
        }
        await navigator.clipboard.writeText(text);
        message.textContent = 'Copied.';
        return;
    } catch {
        // Select the code so the user can copy it with the keyboard.
    }

    try {
        const range = document.createRange();
        range.selectNodeContents(codeNode);
        const selection = window.getSelection();
        if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
        }
        message.textContent = 'Selected. Copy it with your keyboard.';
    } catch {
        message.textContent = 'Select the code and copy it.';
    }
}
