/**
 * The first commit in an empty repository.
 *
 * A repository with no commits is a special case that GitHub makes awkward: the
 * git data API answers `409 Conflict` for blob creation until at least one commit
 * exists, so the usual blob, tree, commit, ref sequence cannot start from nothing.
 * The Contents API is the one endpoint that works on an empty repository, so it
 * seeds the first file and creates the branch, and the remainder of the scaffold
 * is committed normally on top.
 *
 * The branch name comes from the repo's `default_branch` — never hardcode `main`.
 */
import { GitHubError, ghFetch } from './http.js';
import {
    createBlob,
    createCommit,
    createRef,
    createTree,
    getCommit,
    getRef,
    updateRef,
} from './git-data.js';

/**
 * Base64 for a UTF-8 string, which is what the Contents API wants.
 *
 * @param {string} text
 * @returns {string}
 */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/**
 * Create the very first commit through the Contents API.
 *
 * @param {{ token: string, owner: string, repo: string, file: { path: string, content: string }, message: string }} options
 * @returns {Promise<void>}
 */
async function seedFirstFile({ token, owner, repo, file, message }) {
    await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}`, {
        token,
        method: 'PUT',
        body: { message, content: toBase64(file.content) },
    });
}

/**
 * The files every pydle workspace starts with.
 *
 * @returns {Array<{ path: string, content: string }>}
 */
export function scaffoldFiles() {
    return [
        {
            path: 'README.md',
            content: [
                '# pydle workspace',
                '',
                'This repository holds a pydle workspace. Projects live under `work/`,',
                'one folder per project.',
                '',
                'pydle keeps a copy of your work here so it follows you between devices',
                'and keeps its history. The repository is yours: you can clone it with',
                'git at any time, and it stays even if pydle does not.',
                '',
                'To take a copy out of pydle, use **Export** in the app. It downloads the',
                'full history as a git bundle that imports into any git host.',
                '',
            ].join('\n'),
        },
        {
            path: 'pydle.json',
            content: JSON.stringify({ format: 1, app: 'pydle' }),
        },
        {
            path: 'work/.gitkeep',
            content: '',
        },
    ];
}

/**
 * Create the scaffold commit and the branch that points at it.
 *
 * @param {{ token: string, owner: string, repo: string, branch: string, identity?: { name: string, email: string } }} options
 * @returns {Promise<any>} The commit object.
 */
export async function bootstrapRepo({ token, owner, repo, branch, identity }) {
    if (!branch) {
        throw new Error('bootstrapRepo needs the repository default branch.');
    }

    const files = scaffoldFiles();
    const message = 'Create pydle workspace';

    /** @param {Array<{ path: string, content: string }>} subset */
    const entriesFor = async (subset) =>
        Promise.all(
            subset.map(async (file) => {
                const blob = await createBlob({ token, owner, repo, content: file.content });
                return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
            }),
        );

    const commitSubset = async (subset, baseTree, parents, commitMessage = message) => {
        const tree = await createTree({ token, owner, repo, tree: await entriesFor(subset), baseTree });
        return createCommit({
            token,
            owner,
            repo,
            message: commitMessage,
            tree: tree.sha,
            parents,
            author: identity,
            committer: identity,
        });
    };

    // Already initialised? Do nothing. The branch is authoritative; `repo.size`
    // is not, and trusting it re-ran the whole scaffold on every page load.
    const existingHead = await getRef({ token, owner, repo, branch });
    if (existingHead) {
        console.info('[pydle] scaffold: already initialised on', branch);
        return null;
    }

    // The normal path, for a repository that already has a commit.
    try {
        const commit = await commitSubset(files, undefined, []);
        await createRef({ token, owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });
        return commit;
    } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 409) {
            throw error;
        }
    }

    // Empty repository: seed one file so a commit exists, then commit the rest.
    console.info('[pydle] scaffold: repository is empty, seeding', files[0].path);
    await seedFirstFile({ token, owner, repo, file: files[0], message });

    const rest = files.slice(1);
    const head = await getRef({ token, owner, repo, branch });
    if (!head) {
        // The seed should have created the branch. If it did not, the repository's
        // default branch is not the name we were given, and guessing would loop.
        throw new Error(
            `Seeded the first file but found no branch called ${branch}. ` +
                'The repository default branch may not match the one reported earlier.',
        );
    }
    if (rest.length === 0) {
        return null;
    }

    const headCommit = await getCommit({ token, owner, repo, sha: head.sha });
    // A distinct message: the seed and the layout are two steps, and the history
    // should not read as though the same thing happened twice.
    const commit = await commitSubset(rest, headCommit.tree.sha, [head.sha], 'Add the workspace layout');
    await updateRef({ token, owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });

    return commit;
}
