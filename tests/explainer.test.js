import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CONCATENATION_MESSAGES,
    CONCATENATION_TITLE,
    constrainTypeError,
} from '../js/explainer.js';

const deckWith = (variant) => ({
    errors: {
        TypeError: { variants: [variant] },
        NameError: { variants: [{ title: 'That name is not defined' }] },
    },
});

test('the concatenation variant is given the condition it is missing', () => {
    const deck = deckWith({ title: CONCATENATION_TITLE });
    const patched = constrainTypeError(deck);

    const variant = patched.errors.TypeError.variants[0];
    assert.deepEqual(variant.if, { match_message: CONCATENATION_MESSAGES });
});

test('the deck passed in is not modified', () => {
    const deck = deckWith({ title: CONCATENATION_TITLE });
    constrainTypeError(deck);

    assert.equal(deck.errors.TypeError.variants[0].if, undefined);
});

test('a variant that already has a condition is left alone', () => {
    const existing = { match_message: ['something else'] };
    const deck = deckWith({ title: CONCATENATION_TITLE, if: existing });
    const patched = constrainTypeError(deck);

    assert.deepEqual(patched.errors.TypeError.variants[0].if, existing);
});

test('other error types are untouched', () => {
    const deck = deckWith({ title: CONCATENATION_TITLE });
    const patched = constrainTypeError(deck);

    assert.deepEqual(
        patched.errors.NameError,
        deckWith({ title: CONCATENATION_TITLE }).errors.NameError,
    );
});

test('a deck without that variant is unchanged, so an upstream rename fails safe', () => {
    const deck = deckWith({ title: 'Something else entirely' });
    const patched = constrainTypeError(deck);

    assert.equal(patched.errors.TypeError.variants[0].if, undefined);
});

test('malformed decks do not throw', () => {
    assert.equal(constrainTypeError(null), null);
    assert.deepEqual(constrainTypeError({}), {});
    assert.deepEqual(constrainTypeError({ errors: {} }), { errors: {} });
});

/*
 * The real vendored library, exercised the way the page uses it. This is the
 * regression test for the bug that prompted the patch: a numpy cast error was
 * being explained as text concatenation.
 */
const trace = (message) =>
    'Traceback (most recent call last):\n' +
    '  File "<exec>", line 6, in <module>\n' +
    `TypeError: ${message}`;

test('the real deck no longer explains every TypeError as concatenation', async () => {
    const { createExplainer } = await import('../js/explainer.js');
    const explainer = await createExplainer({
        load: () => import('../vendor/python-friendly-error-messages/index.browser.js'),
    });

    const numpy = explainer.explain({
        error: trace(
            "Cannot cast array data from dtype('int64') to dtype('int32') according to the rule 'safe'",
        ),
        code: 'counts = np.bincount(rolls)',
        runtime: 'pyodide',
        file: 'main.py',
    });
    assert.equal(numpy, null, 'the numpy cast error should get no friendly explanation');

    const called = explainer.explain({
        error: trace("'NoneType' object is not callable"),
        code: 'f()',
        runtime: 'pyodide',
        file: 'main.py',
    });
    assert.equal(called, null, 'a call signature error is not about joining text');
});

test('the real deck still explains genuine concatenation', async () => {
    const { createExplainer } = await import('../js/explainer.js');
    const explainer = await createExplainer({
        load: () => import('../vendor/python-friendly-error-messages/index.browser.js'),
    });

    const direct = explainer.explain({
        error: trace('can only concatenate str (not "int") to str'),
        code: '"a" + 1',
        runtime: 'pyodide',
        file: 'main.py',
    });
    assert.equal(direct.title, CONCATENATION_TITLE);

    const operand = explainer.explain({
        error: trace("unsupported operand type(s) for +: 'int' and 'str'"),
        code: '1 + "a"',
        runtime: 'pyodide',
        file: 'main.py',
    });
    assert.equal(operand.title, CONCATENATION_TITLE);
});
