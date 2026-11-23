import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CATALOGUE,
    addPackage,
    hasPackage,
    parseRequirements,
    removePackage,
} from '../js/packages.js';

/*
 * The rules for requirements.txt. They are pure text functions, so the picker
 * can be tested without a browser. The file is the source of truth: these tests
 * pin down deduplication, comment preservation and the empty-file case.
 */

test('the catalogue lists the packages a student may choose', () => {
    const ids = CATALOGUE.map((entry) => entry.id);

    for (const id of ['numpy', 'sympy', 'pandas', 'scipy']) {
        assert.ok(ids.includes(id), `catalogue is missing ${id}`);
    }

    const seen = new Set();
    for (const entry of CATALOGUE) {
        assert.equal(entry.id, entry.label, `${entry.id} should have the same label`);
        assert.ok(!seen.has(entry.id), `${entry.id} is listed twice`);
        seen.add(entry.id);
        assert.ok(entry.summary.trim() !== '', `${entry.id} needs a summary`);
        assert.ok(entry.size.trim() !== '', `${entry.id} needs a size`);
    }
});

test('parseRequirements reads one name per line', () => {
    assert.deepEqual(parseRequirements('numpy\npandas\n'), ['numpy', 'pandas']);
});

test('parseRequirements ignores blank lines and comments', () => {
    const text = '# maths\n\nnumpy\n   \n# another note\npandas\n';
    assert.deepEqual(parseRequirements(text), ['numpy', 'pandas']);
});

test('parseRequirements deduplicates case-insensitively, keeping file order', () => {
    assert.deepEqual(parseRequirements('NumPy\npandas\nnumpy\nPANDAS\n'), ['NumPy', 'pandas']);
});

test('parseRequirements handles CRLF and version pins', () => {
    assert.deepEqual(parseRequirements('numpy==1.26.4\r\npandas>=2.0\r\n'), ['numpy', 'pandas']);
});

test('parseRequirements of empty or missing text is empty', () => {
    assert.deepEqual(parseRequirements(''), []);
    assert.deepEqual(parseRequirements(null), []);
    assert.deepEqual(parseRequirements(undefined), []);
});

test('addPackage appends a lowercase name with a trailing newline', () => {
    assert.equal(addPackage('', 'numpy'), 'numpy\n');
    assert.equal(addPackage('numpy\n', 'Pandas'), 'numpy\npandas\n');
});

test('addPackage changes nothing when the package is already present', () => {
    const exact = 'numpy\n\n';
    assert.equal(addPackage(exact, 'numpy'), exact);

    const differentCase = 'NumPy\n# note\n';
    assert.equal(addPackage(differentCase, 'NUMPY'), differentCase);
});

test('addPackage keeps comments above the names', () => {
    assert.equal(
        addPackage('# maths\nnumpy\n', 'pandas'),
        '# maths\nnumpy\npandas\n',
    );
    // A comment written below the names moves above them, where a reader looks.
    assert.equal(
        addPackage('numpy\n# maths\n', 'pandas'),
        '# maths\nnumpy\npandas\n',
    );
});

test('addPackage drops blank lines and keeps an inline comment intact', () => {
    assert.equal(addPackage('numpy  # fast\n\n\n', 'pandas'), 'numpy  # fast\npandas\n');
});

test('addPackage keeps a name that is not in the catalogue', () => {
    assert.equal(addPackage('numpy\n', 'requests'), 'numpy\nrequests\n');
});

test('removePackage removes a name from the middle', () => {
    assert.equal(removePackage('numpy\npandas\nscipy\n', 'pandas'), 'numpy\nscipy\n');
});

test('removePackage leaves the empty string after the last entry', () => {
    assert.equal(removePackage('numpy\n', 'numpy'), '');
});

test('removePackage changes nothing when the name is absent', () => {
    const text = 'numpy\n\n# note\n';
    assert.equal(removePackage(text, 'requests'), text);
});

test('removePackage matches case-insensitively and through a version pin', () => {
    assert.equal(removePackage('NumPy==2.0\nPandas\n', 'numpy'), 'Pandas\n');
});

test('removePackage keeps unknown names and comments it did not remove', () => {
    assert.equal(removePackage('numpy\nrequests\n', 'numpy'), 'requests\n');
    assert.equal(removePackage('# maths\nnumpy\n', 'numpy'), '# maths\n');
});

test('removing an unknown name still works, so a hand-edited line can go', () => {
    assert.equal(removePackage('requests\n', 'requests'), '');
    assert.equal(removePackage('numpy\nrequests\n', 'requests'), 'numpy\n');
});

test('hasPackage matches case-insensitively and ignores a version pin', () => {
    assert.equal(hasPackage('numpy\n', 'numpy'), true);
    assert.equal(hasPackage('NumPy\n', 'numpy'), true);
    assert.equal(hasPackage('numpy==1.26.4\n', 'numpy'), true);
    assert.equal(hasPackage('pandas\n', 'numpy'), false);
    assert.equal(hasPackage('', 'numpy'), false);
});

test('add then remove returns the same text for a file with comments', () => {
    const text = '# what this project needs\nnumpy\n';
    assert.equal(removePackage(addPackage(text, 'scipy'), 'scipy'), text);
});
