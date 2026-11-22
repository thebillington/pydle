import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planMerge, resolveConflicts } from '../js/reconcile.js';

const h = (n) => `hash-${n}`;

test('nothing to do when both sides already agree', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(1) }, { 'a.py': h(1) });
    assert.deepEqual(plan.apply, []);
    assert.deepEqual(plan.keep, []);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.converged, ['a.py']);
});

test('a file absent everywhere changes nothing', () => {
    const plan = planMerge({}, {}, {});
    assert.deepEqual(plan, { apply: [], keep: [], conflicts: [], converged: [] });
});

test('only the remote changed: take it', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(1) }, { 'a.py': h(2) });
    assert.deepEqual(plan.apply, [{ path: 'a.py', remoteHash: h(2), kind: 'updated' }]);
    assert.deepEqual(plan.conflicts, []);
});

test('only the local changed: keep it', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, { 'a.py': h(1) });
    assert.deepEqual(plan.keep, ['a.py']);
    assert.deepEqual(plan.apply, []);
});

test('both changed to the same content is convergence, not a conflict', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, { 'a.py': h(2) });
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.converged, ['a.py']);
});

test('both changed differently is a conflict', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, { 'a.py': h(3) });
    assert.deepEqual(plan.conflicts, [{ path: 'a.py', remoteHash: h(3), kind: 'both-changed' }]);
    assert.deepEqual(plan.apply, []);
    assert.deepEqual(plan.keep, []);
});

test('a new remote file is taken when local has never seen it', () => {
    const plan = planMerge({}, {}, { 'new.py': h(1) });
    assert.deepEqual(plan.apply, [{ path: 'new.py', remoteHash: h(1), kind: 'updated' }]);
});

test('a new local file is kept when the remote has never seen it', () => {
    const plan = planMerge({}, { 'mine.py': h(1) }, {});
    assert.deepEqual(plan.keep, ['mine.py']);
});

test('a file created on both sides differently is a conflict', () => {
    const plan = planMerge({}, { 'new.py': h(1) }, { 'new.py': h(2) });
    assert.deepEqual(plan.conflicts, [{ path: 'new.py', remoteHash: h(2), kind: 'both-changed' }]);
});

test('remote deletion is followed when the local copy is untouched', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(1) }, {});
    assert.deepEqual(plan.apply, [{ path: 'a.py', remoteHash: null, kind: 'deleted' }]);
});

test('deleted here, edited elsewhere is a conflict', () => {
    const plan = planMerge({ 'a.py': h(1) }, {}, { 'a.py': h(2) });
    assert.deepEqual(plan.conflicts, [{ path: 'a.py', remoteHash: h(2), kind: 'deleted-here' }]);
});

test('edited here, deleted elsewhere is a conflict', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, {});
    assert.deepEqual(plan.conflicts, [{ path: 'a.py', remoteHash: null, kind: 'deleted-elsewhere' }]);
});

test('a stale device committing several files only reports the real clash', () => {
    // The scenario this exists for: work done at home, committed from school, then
    // the home device comes back. Only the file both sides touched is a conflict.
    const plan = planMerge(
        { 'main.py': h(1), 'helpers.py': h(1), 'notes.txt': h(1) },
        { 'main.py': h(2), 'helpers.py': h(2), 'notes.txt': h(1) },
        { 'main.py': h(3), 'helpers.py': h(1), 'notes.txt': h(1) },
    );
    assert.deepEqual(plan.conflicts.map((c) => c.path), ['main.py']);
    assert.deepEqual(plan.keep, ['helpers.py']);
    assert.deepEqual(plan.converged, ['notes.txt']);
});

test('choosing local leaves the file alone and clears the conflict', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, { 'a.py': h(3) });
    const resolved = resolveConflicts(plan, { 'a.py': 'local' });
    assert.deepEqual(resolved.unresolved, []);
    assert.deepEqual(resolved.apply, []);
});

test('choosing remote schedules the remote content', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, { 'a.py': h(3) });
    const resolved = resolveConflicts(plan, { 'a.py': 'remote' });
    assert.deepEqual(resolved.apply, [{ path: 'a.py', remoteHash: h(3), kind: 'updated' }]);
    assert.deepEqual(resolved.unresolved, []);
});

test('choosing remote where the remote deleted the file schedules a deletion', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, {});
    const resolved = resolveConflicts(plan, { 'a.py': 'remote' });
    assert.deepEqual(resolved.apply, [{ path: 'a.py', remoteHash: null, kind: 'deleted' }]);
});

test('an unanswered conflict stays unresolved', () => {
    const plan = planMerge({ 'a.py': h(1) }, { 'a.py': h(2) }, { 'a.py': h(3) });
    const resolved = resolveConflicts(plan, {});
    assert.deepEqual(resolved.unresolved.map((c) => c.path), ['a.py']);
});

test('safe applies survive alongside an unresolved conflict', () => {
    const plan = planMerge(
        { 'a.py': h(1), 'b.py': h(1) },
        { 'a.py': h(2), 'b.py': h(1) },
        { 'a.py': h(3), 'b.py': h(9) },
    );
    const resolved = resolveConflicts(plan, {});
    assert.deepEqual(resolved.unresolved.map((c) => c.path), ['a.py']);
    assert.deepEqual(resolved.apply, [{ path: 'b.py', remoteHash: h(9), kind: 'updated' }]);
});
