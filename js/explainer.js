/*
 * The friendly-error explainer, set up the way pydle needs it.
 *
 * The vendored library explains Python errors by type: a `TypeError` is looked up
 * by name and the first matching variant is used. Its `TypeError` entry has a
 * single variant, with no condition, so *every* TypeError is described as trying
 * to join text and a number. That is wrong for most of them:
 *
 *     TypeError: Cannot cast array data from dtype('int64') to dtype('int32')
 *
 * is numpy refusing a 32-bit index cast on wasm32, and explaining it as
 * "These types of data cannot be joined" sends the reader looking for a `+`
 * that is not there. A wrong explanation is worse than none: with none, the
 * student at least sees Python's own sentence.
 *
 * Variants support `if.match_message`, and the library exports `loadCopydeck`,
 * so the fix is to give that one variant the condition it is missing and load
 * the corrected deck. That keeps the library's copy as the source of the words,
 * and keeps pydle from keeping its own table of Python errors.
 */

/** The variant that assumes a string is being joined to something else. */
export const CONCATENATION_TITLE = 'These types of data cannot be joined';

/**
 * Messages that really are about joining different types.
 *
 * Substrings, not regular expressions: the library matches with
 * `safeRegexTest`, and Python's own wording contains parentheses that would
 * otherwise change the meaning. These cover the three ways a beginner meets it:
 *
 *   "a" + 1                      can only concatenate str (not "int") to str
 *   1 + "a"                      unsupported operand type(s) for +: ...
 *   "a".join(1)                  ... must be str, not int
 */
export const CONCATENATION_MESSAGES = [
    'can only concatenate',
    'unsupported operand type',
    'must be str',
];

/**
 * Give the concatenation variant the condition it is missing.
 *
 * Returns a new deck; the one passed in is left alone, since it comes from the
 * library's cache and is shared. If the vendored copy changes shape (the variant
 * is renamed, or the condition is added upstream), nothing is altered and the
 * library behaves as it did before, which is the safe failure.
 *
 * @param {{ errors?: Record<string, { variants?: Array<{ title?: string, if?: unknown }> }> }} deck
 * @returns {typeof deck}
 */
export function constrainTypeError(deck) {
    if (!deck || typeof deck !== 'object') {
        return deck;
    }

    const copy = structuredClone(deck);
    const entry = copy.errors && copy.errors.TypeError;
    if (!entry || !Array.isArray(entry.variants)) {
        return copy;
    }

    const variant = entry.variants.find((item) => item && item.title === CONCATENATION_TITLE);
    if (!variant || variant.if) {
        return copy;
    }

    variant.if = { match_message: CONCATENATION_MESSAGES.slice() };
    return copy;
}

/**
 * Load the vendored explainer, corrected, and hand back the one function needed.
 *
 * @param {{ load: () => Promise<any>, language?: string }} options
 * @returns {Promise<{ explain: (input: { error: string, code: string, runtime: string, file: string }) => any }>}
 */
export async function createExplainer({ load, language = 'en' }) {
    const mod = await load();
    const deck = await mod.loadCopydeckFor(language);
    mod.loadCopydeck(constrainTypeError(deck));
    mod.registerAdapter('pyodide', mod.cpythonAdapter);

    return {
        explain: (input) => mod.friendlyExplain(input),
    };
}
