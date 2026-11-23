# Build plan: sync

Companion to [PLAN.md](PLAN.md), which is the *what*. This is the *how*: stack,
module boundaries, deployment, and the order of work.

## Ground rules

- **No build step.** Vanilla ES modules, loaded with `<script type="module">`. No
  bundler, no framework, no CDN imports. Vendored libraries only, as the repo already
  does with CodeMirror and Pyodide.
- **`index.html` is live.** GitHub Pages builds from `main` at `/`, so any push to
  `main` deploys. Work happens on `feat/github-sync`.
- **Node 18 on this box**, no nvm. `node --test` works; wrangler v4 does not. Local
  Worker dev needs Node 20+ on a machine that has it.
- The Worker is the only server, and it stores nothing.

## Deployment

### Worker → GitHub Actions

Not from this box: no Cloudflare credentials here, and wrangler v4 requires Node 20.

`.github/workflows/deploy-worker.yml`:

- triggers on `push` to `main` under `worker/**`, plus `workflow_dispatch`;
- `cloudflare/wrangler-action@v4`, `workingDirectory: worker`;
- needs repo secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, Account
  Settings: Read) and `CLOUDFLARE_ACCOUNT_ID`.

Hostname: **`auth.pydle.uk`** as a Worker Custom Domain. DNS is already on Cloudflare,
so adding the custom domain creates the record. A real hostname matters — `workers.dev`
is blocked by many school filters and looks untrustworthy.

Gotcha: the zone has an SEO custom rule, `SEO: hostnames that do not exist`, which
blocks every host other than `pydle.uk`, `www.pydle.uk` and `auth.pydle.uk`. A new
Worker hostname answers **403 to every method** (no `cf-mitigated` header) while the
static site stays fine, because the request never reaches the Worker. Add the
hostname to that rule's expression — it is a WAF custom rule, not bot protection, so
turning Bot Fight Mode off will not help.

### Site → unchanged

Pages already builds from `main`. Nothing to add.

### Owner-only steps (cannot be automated)

1. Create a GitHub OAuth App, name `pydle`, homepage `https://pydle.uk`.
2. **Tick "Enable Device Flow"** in the app settings. Without this every request
   returns `device_flow_disabled`.
3. Copy the Client ID (public, safe to commit) into `js/config.js` and
   `worker/wrangler.toml`.
4. Add the two Cloudflare secrets to the GitHub repo.
5. After the first deploy, attach `auth.pydle.uk` as the Worker's custom domain.

## File ownership

Disjoint by directory so work can proceed in parallel.

```
worker/                     agent A
  wrangler.toml
  src/index.js
  README.md
  package.json

js/vault/                   agent B
  paths.js                  pure, unit-tested
  fs.js                     OPFS with IndexedDB fallback
  tokens.js                 token persistence

js/github/                  agent C
  http.js                   fetch wrapper, error mapping
  device-flow.js            start, poll, refresh
  git-data.js               blobs, trees, commits, refs
  scaffold.js               initial layout
  commit.js                 multi-file commit with retry

js/ui/*.js                  agent D (wave 2)
js/config.js                lead
tests/*.test.js             whoever owns the module
index.html                  lead only
```

Nobody edits `index.html` except the lead, to avoid three agents fighting over one
file.

## Contracts

Agents code to these signatures. Do not change them without saying so.

### `js/config.js`

```js
export const CONFIG = {
  clientId: '',                              // GitHub OAuth App client id (public)
  shimBase: 'https://auth.pydle.uk',
  apiBase: 'https://api.github.com',
  apiVersion: '2026-03-10',
  scopes: ['repo'],
};
```

### `js/vault/paths.js` — pure, no I/O

```js
safeJoin(...parts)            // → string; throws on '..', absolute paths, control chars
isReservedPath(path)          // → bool; true for 'assignments/', 'feedback/' prefixes
normalizeProjectName(name)    // → slug; lowercase, [a-z0-9-], no leading/trailing '-'
assertInside(root, path)      // → bool
```

Reserved paths exist now, unused, so the deferred classroom layer (Appendix A of
PLAN.md) cannot later collide with something a pupil already wrote.

### `js/vault/fs.js`

```js
listProjects()                        // → [{ name, updatedAt }]
readProject(name)                     // → { [path]: content }
writeFile(project, path, content)     // → void
deleteFile(project, path)
deleteProject(name)
renameProject(from, to)
isAvailable()                         // → 'opfs' | 'idb'
```

`name`/`project` is the **stored** project name, used exactly: `listProjects`
returns what is on disk, including a pre-snake_case spelling, and every other
call must pass that spelling back. Only creation (`writeFile` with a new name)
and the target of `renameProject` apply `normalizeProjectName`. A name that is
not a single plain path segment throws `TypeError`; a valid name with nothing
stored reads as empty.

OPFS when `navigator.storage.getDirectory` exists, IndexedDB otherwise. Same call
surface either way. Never throw on a missing file — return `null`.

### `js/vault/tokens.js`

```js
saveTokens({ accessToken, refreshToken, expiresAt, scope })
loadTokens()                          // → object | null
clearTokens()                         // "Forget this device"
```

IndexedDB. Never render a stored token back into the DOM.

### `js/github/http.js`

```js
class GitHubError extends Error { status; body; }
ghFetch(path, { token, method, body, headers })
  // sets Authorization, Accept: application/vnd.github+json,
  //      X-GitHub-Api-Version: CONFIG.apiVersion
  // → parsed JSON; throws GitHubError on !ok
```

Map `401` to a distinct, catchable signal — the whole app depends on `401` being
"reconnect", never "error".

### `js/github/device-flow.js`

```js
startDeviceFlow({ clientId, scopes, shimBase })
  // → { deviceCode, userCode, verificationUri, expiresIn, interval }

pollForToken({ clientId, deviceCode, interval, expiresIn, shimBase, signal, onTick })
  // → { accessToken, refreshToken, expiresIn, scope }
  // handles authorization_pending, slow_down (+5s, RFC 8628),
  //         expired_token, access_denied

refreshAccessToken({ clientId, refreshToken, shimBase })
  // → same shape as pollForToken
```

### `js/github/git-data.js`

```js
getUser({ token })                                    // → { login, id, name }
getRepo({ token, owner, repo })                       // → repo object | null
createRepo({ token, name })                           // → repo; private, auto_init: false
getRef({ token, owner, repo, branch })                // → { sha } | null
createBlob({ token, owner, repo, content })
createTree({ token, owner, repo, tree, baseTree })
createCommit({ token, owner, repo, message, tree, parents, author, committer })
createRef({ token, owner, repo, ref, sha })           // the empty-repo bootstrap
updateRef({ token, owner, repo, ref, sha })          // PATCH
```

### `js/github/scaffold.js`

```js
scaffoldFiles()            // → [{ path, content }]  README.md, pydle.json, work/.gitkeep
bootstrapRepo({ token, owner, repo, branch, identity })
```

Must use `createRef`, never `updateRef`, and must take `branch` from the caller — the
repo's `default_branch`, not a hardcoded `main`.

### `js/github/commit.js`

```js
commitFiles({ token, owner, repo, branch, files, message, identity })
  // files: [{ path, content }]
  // blobs → tree(base_tree) → commit(parent) → updateRef
  // on 422: refetch head, rebuild, retry once; then throw ConflictError
```

## Work order

Wave 1, parallel:

- **A — Worker.** CORS shim, allowlist, `wrangler.toml`, worker README.
- **B — Vault.** `paths.js`, `fs.js`, `tokens.js`, plus `tests/paths.test.js`.
- **C — GitHub client.** `http.js`, `device-flow.js`, `git-data.js`,
  `scaffold.js`, `commit.js`, with tests for error mapping and commit assembly.

Lead, in parallel: `js/config.js`, `.github/workflows/`, branch setup.

Wave 2, after B and C land:

- **D — UI.** Connect panel (code, countdown, link), project list, wiring into
  `index.html` under lead review.

Lead, last: browser verification, then merge to `main`.

## Acceptance

- `node --test` passes with no dependencies installed.
- Worker answers `OPTIONS` with the CORS headers and rejects any path outside the
  two allowed.
- Empty repo bootstraps to one commit whose tree is exactly the scaffold.
- A second save produces a second commit with a parent, and a `422` retries cleanly.
- `401` anywhere surfaces "reconnect", never a stack trace, and loses no local work.
- With the network off, editing and saving still work, and the queue drains on
  reconnect.

## Wave 2: sync core and UI

`js/sync.js` (lead) is the only module that knows both the vault and GitHub. It owns
the mapping between them: vault project `spiral` file `main.py` is repo path
`work/spiral/main.py`. The UI never talks to `js/github/*` or `js/vault/*` directly.

```js
createSync({ onStatus }) -> Sync

Sync.status        // 'signed-out' | 'connecting' | 'connected' | 'offline' | 'error'
Sync.identity      // { login, name } | null
Sync.workspace     // { owner, repo } | null

Sync.beginSignIn({ onCode, onTick, signal })  // resolves once signed in
Sync.cancelSignIn()
await Sync.connect()          // token -> identity -> workspace
await Sync.createWorkspace()  // create the repo and bootstrap it
await Sync.pull()             // remote work/ into the vault (never overwrites local)
await Sync.saveProject(name)  // queue a commit for one project
await Sync.flush()            // force the queue now
Sync.disconnect()             // forget this device
```

`SyncError.kind` is one of `'auth' | 'network' | 'conflict' | 'config'`. `'auth'`
means reconnect; everything else means retry later. Local edits are never lost.

### UI modules

Presentational only, DOM built programmatically inside a container the lead supplies,
so `index.html` needs one empty element per mount and nothing else.

```js
mountStatus(element, sync)          // small toolbar indicator
mountConnect(element, sync)         // the whole sign-in panel
mountProjects(element, sync)        // project list with sync state per project
```

They call `sync` and read `sync.status`; they never import from `js/github/`.

## Out of scope for this build

- QR codes for the device URI (needs a vendored QR encoder; fine as a follow-up).
- Multi-file bulk import, folder upload.
- The classroom layer — see Appendix A of PLAN.md.

## Error explanations

`vendor/python-friendly-error-messages/` is the RPF explainer, unmodified. It
explains by exception type, and its `TypeError` entry has one variant with no
condition, so every TypeError is described as joining text and a number. That is
wrong for most of them, including numpy's 32-bit cast refusal.

`js/explainer.js` gives that one variant the `if.match_message` condition the
library already supports, then loads the corrected deck through the library's own
`loadCopydeck` hook. The words stay the library's; only the condition is added.
When the message does not match, `friendlyExplain` returns null and the error
block shows Python's own sentence, which is better than a confident wrong answer.

If the vendored file is updated and the variant is renamed, the patch quietly
does nothing and the old behaviour returns. `tests/explainer.test.js` runs the real
vendored deck against a numpy cast traceback, so that shows up as a failing test
rather than as a misleading message in front of a student.

## Libraries

A project's libraries are whatever `requirements.txt` names. The Libraries dialog in
the rail edits that file; it is the only source of truth, and it travels with the
project and appears in the repository.

Nothing is installed until the code runs. Before each run the worker reads
`requirements.txt`, resolves each name against `vendor/pyodide/pyodide-lock.json`,
and downloads the wheel and its dependencies from the Pyodide CDN at the exact
version of the bundled runtime.

**Wheels are never bundled.** The site ships only the lockfile, which is a few
hundred kilobytes of metadata; a project fetches only what it declares, once per
device, and the browser caches the response. That keeps the repository small and
costs nothing for projects that use no libraries. The trade-off is that the first
run of a project that imports numpy needs a connection, which is what the dialog
says.

The worker resolves the wheel explicitly rather than calling `loadPackage('<name>')`.
With a bare name that call resolves even when the wheel cannot be fetched, leaving the
package uninstalled and turning a missing download into a confusing `ImportError`
later. The worker also checks `loadedPackages` after loading and reports a plain
message when a package did not arrive.

### What is not in the catalogue

matplotlib and pygame are not offered. Both need somewhere to draw: a figure or a
display surface. pydle is an editor and a text console, so a project that ticked
either would download tens of megabytes and then appear to do nothing. They come
back when there is a renderer, not before.

Do not add wheels to `vendor/pyodide/`. If a deployment ever needs to serve them
itself, that is a hosting decision, not a repository one.

### numpy is a 32-bit build

Pyodide runs wasm32, so `np.intp` is 32 bits and the default integer is still
`int64`. Anything that requires a *safe* cast from an array to indices therefore
raises rather than coercing:

```python
TypeError: Cannot cast array data from dtype('int64') to dtype('int32')
           according to the rule 'safe'
```

`np.bincount` on the result of `rng.integers(...)` is the usual way to meet it.
Use `np.bincount(values.astype(np.int32))`, or avoid bincount entirely with
`np.unique(values, return_counts=True)`, which is portable and usually clearer.
The same applies to any other routine taking indices, and to `array.array`
lengths: nothing here should assume a 64-bit address space.
