/**
 * Thin wrappers over GitHub's Git Data API.
 *
 * Nothing here decides anything: each function is one endpoint, named after what
 * it does, so a reader can match it to GitHub's docs line by line.
 */
import { ghFetch, GitHubError } from './http.js';

/**
 * Base path for one repository.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {string}
 */
function repoPath(owner, repo) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Turn a full ref (`refs/heads/main`) or a short one (`heads/main`) into a URL
 * path segment list, keeping the slashes.
 *
 * @param {string} ref
 * @returns {string}
 */
function refPath(ref) {
    const short = ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref;
    return short.split('/').map(encodeURIComponent).join('/');
}

/**
 * The signed-in user.
 *
 * @param {{ token: string }} options
 * @returns {Promise<{ login: string, id: number, name: string | null }>}
 */
export async function getUser({ token }) {
    const user = await ghFetch('/user', { token });
    return { login: user.login, id: user.id, name: user.name ?? null };
}

/**
 * One repository, or null when it does not exist (or is not visible to the token).
 *
 * @param {{ token: string, owner: string, repo: string }} options
 * @returns {Promise<any | null>}
 */
export async function getRepo({ token, owner, repo }) {
    try {
        return await ghFetch(repoPath(owner, repo), { token });
    } catch (error) {
        if (error instanceof GitHubError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

/**
 * Create a private repository with no initial commit.
 *
 * `auto_init: false` is deliberate: an initial README would leave a junk commit
 * at the root of the user's history forever.
 *
 * @param {{ token: string, name: string }} options
 * @returns {Promise<any>} The new repository object.
 */
export function createRepo({ token, name }) {
    return ghFetch('/user/repos', {
        token,
        method: 'POST',
        body: { name, private: true, auto_init: false },
    });
}

/**
 * The commit a branch points at, or null when the branch has no commits yet.
 *
 * @param {{ token: string, owner: string, repo: string, branch: string }} options
 * @returns {Promise<{ sha: string } | null>}
 */
export async function getRef({ token, owner, repo, branch }) {
    try {
        const data = await ghFetch(`${repoPath(owner, repo)}/git/ref/heads/${encodeURIComponent(branch)}`, { token });
        return { sha: data.object.sha };
    } catch (error) {
        if (error instanceof GitHubError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

/**
 * Store one file's contents as a blob.
 *
 * @param {{ token: string, owner: string, repo: string, content: string }} options
 * @returns {Promise<{ sha: string }>} The blob object.
 */
export function createBlob({ token, owner, repo, content }) {
    return ghFetch(`${repoPath(owner, repo)}/git/blobs`, {
        token,
        method: 'POST',
        body: { content, encoding: 'utf-8' },
    });
}

/**
 * Create a tree. Pass `baseTree` to layer on top of an existing tree, or omit it
 * to replace the whole tree (the bootstrap case).
 *
 * @param {{ token: string, owner: string, repo: string, tree: Array<object>, baseTree?: string }} options
 * @returns {Promise<{ sha: string }>} The tree object.
 */
export function createTree({ token, owner, repo, tree, baseTree }) {
    const body = { tree };
    if (baseTree) {
        body.base_tree = baseTree;
    }
    return ghFetch(`${repoPath(owner, repo)}/git/trees`, { token, method: 'POST', body });
}

/**
 * Create a commit pointing at a tree and zero or more parents.
 *
 * @param {{ token: string, owner: string, repo: string, message: string, tree: string, parents?: string[], author?: object, committer?: object }} options
 * @returns {Promise<{ sha: string }>} The commit object.
 */
export function createCommit({ token, owner, repo, message, tree, parents = [], author, committer }) {
    const body = { message, tree, parents };
    if (author) {
        body.author = author;
    }
    if (committer) {
        body.committer = committer;
    }
    return ghFetch(`${repoPath(owner, repo)}/git/commits`, { token, method: 'POST', body });
}

/**
 * Point a branch at a commit, creating the branch. This is the only way to make
 * the first commit in an empty repository.
 *
 * @param {{ token: string, owner: string, repo: string, ref: string, sha: string }} options
 * @returns {Promise<any>} The new ref object.
 */
export function createRef({ token, owner, repo, ref, sha }) {
    return ghFetch(`${repoPath(owner, repo)}/git/refs`, {
        token,
        method: 'POST',
        body: { ref, sha },
    });
}

/**
 * Move an existing branch to a new commit. Never forces.
 *
 * A non-fast-forward answers 422; the caller decides what to do about it.
 *
 * @param {{ token: string, owner: string, repo: string, ref: string, sha: string }} options
 * @returns {Promise<any>} The updated ref object.
 */
export function updateRef({ token, owner, repo, ref, sha }) {
    return ghFetch(`${repoPath(owner, repo)}/git/refs/${refPath(ref)}`, {
        token,
        method: 'PATCH',
        body: { sha },
    });
}
