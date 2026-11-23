/*
 * When the Commit control is shown, and what it says.
 *
 * This is a pure rule, extracted because it has been the source of repeated
 * bugs. The number used to come from a network call to GitHub, so a failed or
 * slow request painted zero, and zero is rendered as "no button". That made
 * "could not ask" indistinguishable from "nothing to commit".
 *
 * The count now comes from this device only (`dirty()` against the snapshot),
 * which cannot fail and needs no connection. So the control can honestly be
 * hidden when there is nothing to commit, and shown when there is, without ever
 * depending on the network being reachable at that moment.
 *
 * The repository check belongs to the commit window, which is opened
 * deliberately and can afford to talk to GitHub, and can explain itself when it
 * cannot.
 */

/**
 * @param {{ signedIn: boolean, project: string | null, count: number }} input
 * @returns {{ visible: boolean, count: number, label: string, title: string }}
 */
export function commitBadge({ signedIn, project, count }) {
    const known = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const visible = Boolean(signedIn) && project !== null && project !== '' && known > 0;

    if (!visible) {
        return {
            visible: false,
            count: 0,
            label: 'Commit',
            title: 'Put this project\u2019s changes in GitHub',
        };
    }

    const label = 'Commit ' + known + ' ' + (known === 1 ? 'file' : 'files') + ' to GitHub';
    return {
        visible: true,
        count: known,
        label,
        title: label,
    };
}
