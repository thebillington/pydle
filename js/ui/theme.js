/*
 * Theme: auto (follow the OS), light, or dark.
 *
 * The inline script in each page's <head> has already set data-theme before the
 * first paint. This module owns the stored preference and the header toggle; it
 * re-resolves "auto" live when the operating system changes.
 */

const STORAGE_KEY = 'pydle_theme';
const MODES = ['auto', 'light', 'dark'];
const LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };
const THEME_COLORS = { light: '#f8f8f2', dark: '#1e1e2e' };

/**
 * Read the stored preference, falling back to "auto".
 *
 * @returns {'auto' | 'light' | 'dark'} The stored mode, or "auto".
 */
function readMode() {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored === 'light' || stored === 'dark' || stored === 'auto') {
            return stored;
        }
    } catch (error) {
        // Private mode or a blocked storage partition: follow the OS instead.
    }
    return 'auto';
}

/**
 * Whether the operating system currently asks for a light appearance.
 *
 * @returns {boolean} True for light, false for dark or no preference.
 */
function prefersLight() {
    if (typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia('(prefers-color-scheme: light)').matches;
}

/**
 * Resolve a mode to the palette actually shown.
 *
 * @param {'auto' | 'light' | 'dark'} mode Stored preference.
 * @returns {'light' | 'dark'} The palette to apply.
 */
function resolveMode(mode) {
    if (mode === 'light' || mode === 'dark') {
        return mode;
    }
    return prefersLight() ? 'light' : 'dark';
}

/**
 * The palette the current stored preference resolves to right now.
 *
 * Useful before a toggle exists, so a CodeMirror instance can be constructed
 * with the right theme instead of being corrected on first paint.
 *
 * @returns {'light' | 'dark'} The resolved palette.
 */
export function getResolvedTheme() {
    return resolveMode(readMode());
}

/**
 * Mount the header theme control: a real button that cycles
 * auto -> light -> dark -> auto and persists the choice.
 *
 * @param {Element} element Container to append the button to.
 * @param {Object} [options] Optional behaviour.
 * @param {(resolved: 'light' | 'dark', mode: 'auto' | 'light' | 'dark') => void} [options.onChange]
 *     Called whenever the resolved palette changes (including the initial mount).
 * @returns {{
 *     getMode: () => 'auto' | 'light' | 'dark',
 *     getResolved: () => 'light' | 'dark',
 *     setMode: (mode: 'auto' | 'light' | 'dark') => void,
 *     destroy: () => void,
 * }} A small handle for callers that need to read or drive the mode.
 */
export function mountThemeToggle(element, options = {}) {
    let mode = readMode();
    let resolved = resolveMode(mode);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';

    const label = document.createElement('span');
    label.className = 'theme-toggle-label';
    button.appendChild(label);
    element.appendChild(button);

    const query = typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: light)')
        : null;

    function apply() {
        resolved = resolveMode(mode);
        document.documentElement.setAttribute('data-theme', resolved);

        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute('content', THEME_COLORS[resolved]);
        }

        label.textContent = LABELS[mode];
        button.title = 'Theme: ' + mode;
        button.setAttribute('aria-label', 'Theme: ' + mode + '. Click to change.');

        if (typeof options.onChange === 'function') {
            options.onChange(resolved, mode);
        }
    }

    function persist(next) {
        try {
            window.localStorage.setItem(STORAGE_KEY, next);
        } catch (error) {
            // The palette still changes for this visit; it just will not survive.
        }
    }

    function onSchemeChange() {
        if (mode === 'auto') {
            apply();
        }
    }

    function onStorage(event) {
        if (event.key !== null && event.key !== STORAGE_KEY) {
            return;
        }
        mode = readMode();
        apply();
    }

    function onClick() {
        const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
        mode = next;
        persist(next);
        apply();
    }

    button.addEventListener('click', onClick);
    if (query) {
        if (typeof query.addEventListener === 'function') {
            query.addEventListener('change', onSchemeChange);
        } else if (typeof query.addListener === 'function') {
            query.addListener(onSchemeChange);
        }
    }
    window.addEventListener('storage', onStorage);

    apply();

    return {
        getMode() {
            return mode;
        },
        getResolved() {
            return resolved;
        },
        setMode(next) {
            if (MODES.indexOf(next) === -1) {
                return;
            }
            mode = next;
            persist(next);
            apply();
        },
        destroy() {
            button.removeEventListener('click', onClick);
            if (query) {
                if (typeof query.removeEventListener === 'function') {
                    query.removeEventListener('change', onSchemeChange);
                } else if (typeof query.removeListener === 'function') {
                    query.removeListener(onSchemeChange);
                }
            }
            window.removeEventListener('storage', onStorage);
            button.remove();
        },
    };
}
