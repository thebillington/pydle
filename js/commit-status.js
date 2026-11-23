/*
 * What kind of change is this, given both sides?
 *
 * The device's own view is not enough. A file this device has never committed is
 * "new" as far as the vault is concerned, but the repository may already have a
 * different version of it, put there by another editor or another device. Showing
 * that as a brand new file tells the student their upload will create it, when in
 * fact it will replace something.
 *
 * So the status is derived from the two versions rather than from the local
 * snapshot, and this is the one place that decides it.
 */

/**
 * @typedef {'added' | 'modified' | 'deleted' | 'unchanged'} ChangeStatus
 */

/**
 * Work out how one file differs between the repository and this device.
 *
 * @param {string | null} before The version in the repository, or null if absent.
 * @param {string | null} after The version on this device, or null if absent.
 * @returns {ChangeStatus}
 */
export function describeChange(before, after) {
    const hasBefore = typeof before === 'string';
    const hasAfter = typeof after === 'string';

    if (!hasBefore && !hasAfter) {
        return 'unchanged';
    }
    if (!hasBefore) {
        return 'added';
    }
    if (!hasAfter) {
        return 'deleted';
    }
    return before === after ? 'unchanged' : 'modified';
}
