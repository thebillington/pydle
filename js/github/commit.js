/**
 * Saving local files as one commit.
 *
 * The browser is the source of truth; GitHub is a target. So this module never
 * force-pushes and never silently discards either side: if two devices race, the
 * commit is rebuilt on the newer head and retried once, and then reported as a
 * conflict for the caller to surface.
 *
 * Sequence: blobs -> tree (base_tree) -> commit (parent) -> updateRef.
 */
import { GitHubError } from './http.js';
import { createBlob, createCommit, createTree, getRef, updateRef } from './git-data.js';

/**
 * Two writes raced and the retry lost too.
 *
 * `oldSha` is the head this call started from; `newSha` is what the branch points
 * at now. The caller can keep the local work and tell the user rather than
 * pretending the save landed.
 */
export class ConflictError extends Error {
    /**
     * @param {string} [message]
     * @param {{ oldSha?: string | null, newSha?: string | null, cause?: Error }} [details]
     */
    constructor(message = 'The repository changed on another device while saving.', { oldSha = null, newSha = null, cause } = {}) {
        super(message);
        this.name = 'ConflictError';
        /** @type {string | null} */
        this.oldSha = oldSha;
        /** @type {string | null} */
        this.newSha = newSha;
        if (cause) {
            this.cause = cause;
        }
    }
}

/**
 * Store every file's contents as a blob, keeping the caller's order.
 *
 * @param {{ token: string, owner: string, repo: string, files: Array<{ path: string, content: string }> }} options
 * @returns {Promise<Array<{ path: string, mode: string, type: string, sha: string }>>}
 */
async function blobEntries({ token, owner, repo, files }) {
    return Promise.all(
        files.map(async (file) => {
            const blob = await createBlob({ token, owner, repo, content: file.content });
            return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
        }),
    );
}

/**
 * Commit a set of files to a branch.
 *
 * @param {{ token: string, owner: string, repo: string, branch: string, files: Array<{ path: string, content: string }>, message: string, identity?: { name: string, email: string } }} options
 * @returns {Promise<any>} The commit object that the branch now points at.
 * @throws {ConflictError} If a non-fast-forward survives one rebuild and retry.
 */
export async function commitFiles({ token, owner, repo, branch, files, message, identity }) {
    const ref = `refs/heads/${branch}`;
    const head = await getRef({ token, owner, repo, branch });

    if (!head) {
        throw new Error(`Branch ${branch} has no commits yet; run bootstrapRepo first.`);
    }

    const oldSha = head.sha;
    const entries = await blobEntries({ token, owner, repo, files });

    let baseSha = oldSha;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const tree = await createTree({ token, owner, repo, tree: entries, baseTree: baseSha });
        const commit = await createCommit({
            token,
            owner,
            repo,
            message,
            tree: tree.sha,
            parents: [baseSha],
            author: identity,
            committer: identity,
        });

        try {
            await updateRef({ token, owner, repo, ref, sha: commit.sha });
            return commit;
        } catch (error) {
            if (!(error instanceof GitHubError) || error.status !== 422) {
                throw error;
            }

            const latest = await getRef({ token, owner, repo, branch });
            const newSha = latest ? latest.sha : null;

            if (attempt === 1 || !newSha || newSha === baseSha) {
                throw new ConflictError(
                    'The repository changed on another device while saving. Your work is still local.',
                    { oldSha, newSha, cause: error },
                );
            }

            baseSha = newSha;
        }
    }

    // The loop always returns or throws; this keeps the contract explicit.
    throw new ConflictError('The repository changed on another device while saving.', { oldSha, newSha: baseSha });
}
