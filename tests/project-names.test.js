import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_PROJECT_NAME,
    editedLabel,
    toSnakeCase,
    toSnakeFileName,
    validateProjectName,
    validateStarterFileName,
} from '../js/ui/home.js';
import { normalizeProjectName } from '../js/vault/paths.js';

/*
 * The naming rules for a project and its first file. They are pure functions,
 * so they can be tested without a DOM; the Home dialog uses the same two
 * functions to transform the field as it is typed and to validate on submit.
 */

test('toSnakeCase lowercases and joins words with single underscores', () => {
    assert.equal(toSnakeCase('My First Project'), 'my_first_project');
    assert.equal(toSnakeCase('  turtle-house  '), 'turtle_house');
    assert.equal(toSnakeCase('Already_ok'), 'already_ok');
    assert.equal(toSnakeCase('a__b___c'), 'a_b_c');
});

test('toSnakeCase removes characters a project name cannot contain', () => {
    assert.equal(toSnakeCase('héllo wörld!'), 'hllo_wrld');
    assert.equal(toSnakeCase('snake_case.py'), 'snake_casepy');
    assert.equal(toSnakeCase('___leading'), 'leading');
    // The canonical rule trims both ends, while a name is being typed too.
    assert.equal(toSnakeCase('trailing___'), 'trailing');
});

test('the dialogue and the vault normalise names identically', () => {
    // Drift between these two is exactly what produced a vault folder that
    // disagreed with the name on screen, so every shape is checked against the
    // single storage rule rather than a second copy of the regexes.
    const names = [
        'My First Project',
        'turtle-house',
        'turtle - house',
        'Already_ok',
        'a__b___c',
        '___leading',
        'trailing___',
        '--x--',
        'UPPER',
        'a1',
        'a'.repeat(41),
        'b'.repeat(39) + ' x',
        'snake_case.py',
        'héllo wörld!',
        '  __hello__  ',
        'ÜBER',
        '!!!',
        '',
        '   ',
    ];

    for (const name of names) {
        let stored;
        try {
            stored = normalizeProjectName(name);
        } catch {
            stored = '';
        }
        assert.equal(toSnakeCase(name), stored, `normalising ${JSON.stringify(name)}`);
    }
});

test('toSnakeCase caps the name at forty characters', () => {
    const long = 'a'.repeat(60);
    assert.equal(toSnakeCase(long).length, MAX_PROJECT_NAME);
});

test('validateProjectName accepts snake_case names', () => {
    assert.deepEqual(validateProjectName('my_first_project'), {
        ok: true,
        name: 'my_first_project',
    });
    assert.deepEqual(validateProjectName('a1'), { ok: true, name: 'a1' });
    assert.deepEqual(validateProjectName('a'.repeat(40)), {
        ok: true,
        name: 'a'.repeat(40),
    });
});

test('validateProjectName rejects a name that does not start with a letter', () => {
    const result = validateProjectName('1st_project');
    assert.equal(result.ok, false);
    assert.match(result.error, /letter/i);
});

test('validateProjectName rejects double underscores and bad characters', () => {
    assert.equal(validateProjectName('two__words').ok, false);
    assert.equal(validateProjectName('has space').ok, false);
    assert.equal(validateProjectName('has-dash').ok, false);
    // Case is not a reason to reject: the field lowercases as you type, and a
    // pasted name is normalised the same way.
    assert.deepEqual(validateProjectName('UPPER'), { ok: true, name: 'upper' });
});

test('validateProjectName rejects an empty name and one that is too long', () => {
    assert.equal(validateProjectName('   ').ok, false);
    assert.equal(validateProjectName('a'.repeat(41)).ok, false);
});

test('toSnakeFileName keeps the extension while transforming the stem', () => {
    assert.equal(toSnakeFileName('Main'), 'main');
    assert.equal(toSnakeFileName('My Script.py'), 'my_script.py');
    assert.equal(toSnakeFileName('helpers-py'), 'helpers_py');
    assert.equal(toSnakeFileName('..secret.py'), 'secret.py');
});

test('validateStarterFileName adds .py when it is missing', () => {
    assert.deepEqual(validateStarterFileName('main'), { ok: true, name: 'main.py' });
    assert.deepEqual(validateStarterFileName('helpers.py'), {
        ok: true,
        name: 'helpers.py',
    });
});

test('validateStarterFileName follows the project naming rules', () => {
    assert.equal(validateStarterFileName('1main').ok, false);
    assert.equal(validateStarterFileName('').ok, false);
    assert.equal(validateStarterFileName('notes.txt').ok, false);
    // Repeated underscores are collapsed while typing, and the stem is capped
    // at the same forty characters as a project name.
    assert.deepEqual(validateStarterFileName('two__words'), {
        ok: true,
        name: 'two_words.py',
    });
    assert.deepEqual(validateStarterFileName('a'.repeat(41) + '.py'), {
        ok: true,
        name: 'a'.repeat(40) + '.py',
    });
});

test('editedLabel describes recent dates in plain words', () => {
    const now = Date.now();
    assert.equal(editedLabel(now), 'today');
    assert.equal(editedLabel(now - 86400000), 'yesterday');
    assert.equal(editedLabel(now - 3 * 86400000), '3 days ago');
    assert.equal(editedLabel(0), '');
    assert.equal(editedLabel(Number.NaN), '');
});

test('typing a project name one character at a time keeps the separator', async () => {
    const { liveProjectName, validateProjectName } = await import('../js/ui/home.js');

    // The bug: the strict transform trimmed on every keystroke, so "my " became
    // "my" and the words ran together into "myproject".
    let typed = '';
    for (const char of 'my project') {
        typed = liveProjectName(typed + char);
    }
    assert.equal(typed, 'my_project');

    // And the strict rule still produces the same name on submit.
    const check = validateProjectName(typed);
    assert.equal(check.ok, true);
    assert.equal(check.name, 'my_project');
});

test('typing a file name does not eat the dot as you type', async () => {
    const { liveFileName } = await import('../js/ui/home.js');

    let typed = '';
    for (const char of 'my drawing.py') {
        typed = liveFileName(typed + char);
    }
    assert.equal(typed, 'my_drawing.py');
});

test('names used by pydle itself are refused', async () => {
    const { validateProjectName } = await import('../js/ui/home.js');

    for (const reserved of ['drawings', 'assignments', 'feedback']) {
        const check = validateProjectName(reserved);
        assert.equal(check.ok, false, reserved + ' should be refused');
        assert.match(check.error, /used by pydle itself/);
    }

    // A near miss is fine.
    assert.equal(validateProjectName('drawings_2').ok, true);
});
