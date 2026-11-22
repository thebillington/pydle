/**
 * The first commit in an empty repository.
 *
 * An empty repo has no ref to patch, so the branch is created with
 * `POST /git/refs` rather than `PATCH /git/refs/...`. The branch name comes from
 * the repo's `default_branch` — never hardcode `main`.
 */
import { createBlob, createCommit, createRef, createTree } from './git-data.js';

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

    const entries = await Promise.all(
        files.map(async (file) => {
            const blob = await createBlob({ token, owner, repo, content: file.content });
            return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
        }),
    );

    const tree = await createTree({ token, owner, repo, tree: entries });
    const commit = await createCommit({
        token,
        owner,
        repo,
        message: 'Create pydle workspace',
        tree: tree.sha,
        parents: [],
        author: identity,
        committer: identity,
    });

    await createRef({ token, owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });

    return commit;
}
