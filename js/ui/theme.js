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
 * Icons for the three modes. Static markup, so no user content is involved.
 */
const ICONS = {
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/>'
        + '<path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/>'
        + '<g stroke="currentColor" stroke-width="2" stroke-linecap="round">'
        + '<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>'
        + '</g></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
        + '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="none" '
        + 'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

const TITLES = {
    auto: 'Auto: follow your device',
    light: 'Light',
    dark: 'Dark',
};

/**
 * Mount the header theme control: three buttons (auto, light, dark), one of
 * which is pressed, that persist the choice and apply it immediately.
 *
 * Auto re-resolves when the operating system changes appearance.
 *
 * @param {Element} element Container to append the control to.
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

    const group = document.createElement('div');
    group.className = 'theme-switch';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Theme');

    const buttons = new Map();

    for (const option of MODES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.mode = option;
        button.title = TITLES[option];
        button.setAttribute('aria-label', TITLES[option]);
        button.innerHTML = ICONS[option];
        button.addEventListener('click', function () {
            choose(option);
        });
        group.appendChild(button);
        buttons.set(option, button);
    }

    element.replaceChildren(group);

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

        for (const [option, button] of buttons) {
            button.setAttribute('aria-pressed', option === mode ? 'true' : 'false');
        }

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

    function choose(next) {
        if (MODES.indexOf(next) === -1) {
            return;
        }
        mode = next;
        persist(next);
        apply();
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
            choose(next);
        },
        destroy() {
            if (query) {
                if (typeof query.removeEventListener === 'function') {
                    query.removeEventListener('change', onSchemeChange);
                } else if (typeof query.removeListener === 'function') {
                    query.removeListener(onSchemeChange);
                }
            }
            window.removeEventListener('storage', onStorage);
            group.remove();
        },
    };
}
