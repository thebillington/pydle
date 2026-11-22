# pydle: saved work and sync

The concrete spec. For the research behind the choices, see [SCHOOLS.md](SCHOOLS.md).

pydle is a static site. This adds one thing: **your work lives in a git repository you
own**, so it follows you between devices, keeps its history, and survives pydle
itself. No database, no accounts to administer, no teacher setup. The only server is
a stateless CORS shim that stores nothing.

The classroom layer (assignments, feedback, org accounts) is deferred. See
[Appendix A](#appendix-a-deferred-classroom-layer) — it is additive and none of it
constrains this design.

---

## 1. Model

**One repository, in the user's own GitHub account, called `pydle`.** Created by
pydle on request if it does not exist.

Everything else follows from that:

- no org, no invites, no collaborators, no permissions to model;
- no repository discovery ambiguity — there is exactly one candidate;
- the user is admin of their own work, so nobody can take it away;
- if pydle disappears, the repo and its full history remain.

Signed-in access requires a GitHub account, which requires being 13 or older. Below
that, pydle keeps working exactly as it does today: local storage and download to
`.py`.

## 2. Authentication

GitHub OAuth **device flow**. The user code is eight characters plus a hyphen
(`WDJB-MJHT`) — the only credential anyone ever types.

### Why not a personal access token

A PAT works and needs no server at all, but onboarding means walking a 13-year-old
through GitHub's fine-grained token UI — resource owner, repository access, fifty
permission checkboxes, expiry — and then a confusing `401` a year later when it
expires, with nobody to help. The device flow issues a correctly scoped token in
nine characters and refreshes it silently.

Keep the PAT path as an error fallback ("having trouble connecting?"), not as the
main route. The device flow issues a correctly scoped token in nine characters and
refreshes it silently.

### The flow

```
POST https://github.com/login/device/code
     client_id=<public>  scope=repo offline_access
```

```json
{
  "device_code": "3584d835…",        // secret, stays in the browser
  "user_code": "WDJB-MJHT",          // the 9 characters shown to the human
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

Poll the token endpoint every `interval` seconds with `device_code` and
`grant_type=urn:ietf:params:oauth:grant-type:device_code`:

- `authorization_pending` — keep polling
- `slow_down` — add 5 seconds to the interval for this and all later polls (RFC 8628)
- `expired_token` — the 15 minutes elapsed; start again
- `access_denied` — the user declined

Success returns `access_token`, `refresh_token`, `expires_in` and `scope`.

Show a visible countdown and a "get a new code" button, or a slow user stares at a
dead screen with no explanation. Never surface `slow_down` as an error.

**The authorisation can happen on a different device.** Show the URI as a QR next to
the code: a user whose phone is already signed into GitHub can scan, type the code
there and approve, and the machine running pydle receives a token without ever
seeing a password. Design the screen around that path.

### Refresh

`offline_access` matters: new OAuth apps issue **8-hour** access tokens by default.
Without refresh, users re-authenticate every session. With it, refresh tokens last
~6 months of non-use, so a re-auth lands roughly once per term.

```
POST https://github.com/login/oauth/access_token
     grant_type=refresh_token&refresh_token=…&client_id=…
```

Store access token, refresh token, expiry and scope. Refresh proactively on `401`,
once, before surfacing an error.

### The shim

`github.com` sends **no CORS headers**, so the two auth endpoints cannot be called
from a page. `api.github.com` does, so all data requests go direct from the browser.

The shim is a Cloudflare Worker with a hard allowlist:

- only those two paths, only `POST`, everything else `404`;
- no storage, no database, no cookies, no client secret — the device flow does not
  need one, which is why there is nothing worth stealing;
- `Origin` allowlisted to the production domain, with `Vary: Origin`;
- pinned to our `client_id`.

**It sees the access token in transit**, because it forwards the token response.
"Stores nothing" is not "sees nothing". Never log request or response bodies — put
that in the code.

### Requests

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

Pin the version header. Breaking changes ship only in dated versions, each supported
for at least 24 months.

### Device-code phishing

Someone sends a code and asks you to enter it, which grants *them* access. Show the
app name on the confirmation step, and say plainly in the UI that a code should only
ever be entered for a screen you are looking at.

## 3. Finding or creating the repo

```
GET /repos/{login}/pydle
```

- **Exists and looks like a vault** → connect.
- **Doesn't exist** → offer *"Create my workspace"*. `POST /user/repos` with
  `private: true` and `auto_init: false`.
- **Exists but isn't a vault** (no `pydle.json`, no recognised layout) → refuse and
  offer a different name. Never scaffold over someone's files.

Always ask before creating. A repository in someone's account is a visible,
permanent side effect, not something to do silently on first sign-in.

`auto_init: false` is deliberate: `auto_init: true` leaves a junk README commit at
the root of the user's history forever.

## 4. Bootstrapping

An empty repo has no ref to patch, so the first commit creates the branch. Two traps:

- `PATCH /git/refs/heads/main` fails on a repo with no commits — use
  `POST /git/refs`.
- Do not hardcode `main`. Read `default_branch` from the repo object and use it.

```
GET    /repos/{o}/{r}                           → default_branch, empty?
POST   /git/blobs            × N                → one per scaffolded file
POST   /git/trees                               → no base_tree, whole tree
POST   /git/commits                             → no parents
POST   /git/refs            refs/heads/{branch}  → creates the branch
```

Every later save is the same with `base_tree`, a parent, and
`PATCH /git/refs/heads/{branch}`.

A `PATCH` that is not a fast-forward returns `422`: refetch the head and re-apply the
commit. Since a single user writes only their own repo, this is rare — but see §8.

## 5. Commit identity

The user is author and committer. Use GitHub's noreply address so a real email never
enters the history, while commits still link to the profile:

| Field | Value |
|---|---|
| `author.name` | `GET /user` → `name` or `login` |
| `author.email` | `<id>+<login>@users.noreply.github.com` |
| `committer` | same |

## 6. Repository layout

```
pydle/
├── README.md                 generated: what this is, how to export
├── pydle.json                format version, last client version
└── work/                     the user's projects
    └── spiral/
        ├── main.py
        └── project.json      optional: title, entrypoint
```

That is the whole schema. No assignments, no feedback, no tags, no status derivation.

`pydle.json` exists for one reason: so a future version can tell what it is looking at
and migrate rather than guess.

```json
{ "format": 1, "app": "pydle" }
```

## 7. Saving and committing

Two separate things, deliberately:

**Saving is automatic and local.** Editing writes the file into the vault (OPFS with
an IndexedDB fallback) immediately, and never waits on the network. This is what
makes an expired token, a filter, or an outage cost nothing: the lesson's work is on
the device regardless.

**Committing is manual and deliberate.** Nothing reaches GitHub without the user
choosing files and writing a message. There is no debounce, no background commit and
no commit on a timer. The commit is the thing being taught, so it is the thing the
user does.

Which files are uncommitted is answered offline: after each commit, the hash of every
committed file is stored beside the project in the vault. Comparing current files to
that snapshot gives added / modified / deleted without a network call. Files left out
of a commit stay dirty — an unselected edit is never recorded as committed.

### Guards before leaving

- **Switching file, switching project, closing the editor**: our own modal, with the
  file picker and message box.
- **Closing the tab or reloading**: the browser's own dialog. A page cannot customise
  `beforeunload`, so this is a generic "may not be saved" prompt and nothing more.
  Do not promise a custom modal here.

### History

Read from GitHub rather than stored locally: commits that touched the project
(`/commits?path=work/<project>`), and one commit expanded to per-file patches
(`/commits/<sha>`). It needs a connection, and it is where "view all changes in a
commit" lives. Deleting a project also commits that deletion, because the user has
already confirmed a destructive action.

## 8. Conflicts

Single user, but they may use two devices. Two backends:

- **Optimistic:** `PATCH /git/refs` rejects a non-fast-forward with `422`. Refetch,
  re-apply, retry once.
- **Fallback:** if that fails twice, commit to `pydle/pending-<timestamp>` and tell
  the user, rather than silently losing either side.

Never force-push.

## 9. Export

A `.git` bundle, or a plain `git clone`. Complete history, offline, importable into
any host. This is the exit path and the answer to "what if pydle stops".

## 10. Ceilings

- **50 sign-ins per hour, per OAuth app.** GitHub rate-limits device-flow
  verification-code submissions to 50/hour per application. This, not Cloudflare,
  decides onboarding capacity. Fine for a class of 30; not fine for a whole school at
  once, or for the week a term's refresh tokens expire together. Stagger onboarding
  one class at a time. Each school registering its own OAuth app resets the limit for
  that school.
- **Account required** for sync, therefore 13+. Without an account pydle works as it
  does today.
- **Signup is the sharp edge.** Accounts created in bulk from one school NAT get
  flagged as multi-accounting and suspended; appeals take weeks. If teachers point a
  class at this, the guide must say: sign up at home, before the lesson.
- **`api.github.com` must be reachable.** Different hostname from `github.com`, and
  filters sometimes allow one and block the other.
- **The consent screen is broad.** OAuth needs the `repo` scope, which GitHub renders
  as *"Full control of private repositories"*. Fine for personal repos; alarming on a
  consent screen if unexplained, so page copy should name it before GitHub does.

---

## Appendix A: deferred classroom layer

Not built. Recorded because it was designed, it is additive, and a repo containing
only `work/` is already a valid vault — so adding any of this later needs no
migration.

If it returns, the pieces are:

- **`assignments/<id>/`** — teacher-owned, read-only to the student. `brief.md`,
  `starter/`, `tests/`, and `assignment.json` (`id`, `title`, `version`, `issued`,
  `due`, `entry`, `tests`, `points`).
- **`submissions/<id>/`** — student-owned, created from `starter/`.
- **`feedback/<id>.md`** — teacher-owned Markdown with YAML front matter carrying
  `mark`, `marker`, `marked`, and line-anchored `comments[]`. Renders on GitHub,
  parses in pydle, and makes the gradebook a directory scan rather than a database.
- **Ownership by first path segment.** The editor refuses to write under
  `assignments/` or `feedback/`. This is what lets a publish never clobber a pupil's
  work, and what makes concurrent teacher/student commits disjoint.
- **Submission as an annotated tag** — `submitted/<id>`, resubmissions `-2`, `-3`.
  Timestamped by GitHub, visible in the UI, exported with the repo, and unaffected by
  later edits. Late is tag date versus `due`.
- **Class workspaces** — `<school-org>/pydle-<ref>`, created by the teacher, student
  added as an **outside collaborator** with push (so they never appear in the org's
  People list). Personal versus class is derived, not configured:
  `repo.owner.login === me`.
- **Class link** — `pydle.uk/#org=stmarys-cs`, posted once per class, to make
  discovery deterministic when a user has more than one repo.
- **Publishing** is an N-write fan-out to every repo in the class; move to a
  `workflow_dispatch` GitHub Action in the teacher's org if cohorts grow.

None of it requires a database, a server, or a change to §6.
