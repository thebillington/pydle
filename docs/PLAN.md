# pydle: saved work and sync

The concrete spec. For the research behind the choices, see [SCHOOLS.md](SCHOOLS.md).

pydle is a static site. This adds one thing: **your work lives in a git repository you
own**, so it follows you between devices, keeps its history, and survives pydle
itself. No backend, no server, no OAuth app, no accounts database, no teacher admin.

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

A **personal access token**, minted by the user, pasted once.

There is no OAuth app, no client ID, no shim, and no CORS problem: the token goes
from the browser straight to `api.github.com`, which allows CORS. Nothing of ours
ever sees it, and there is nothing to operate.

### Onboarding

Prefer a **classic** token, because the form can be pre-filled by URL:

```
https://github.com/settings/tokens/new?scopes=repo&description=pydle
```

That opens the create-token page with `repo` already ticked and the description
filled in. The user picks an expiry, clicks Generate, copies. Four interactions.

Fine-grained tokens are narrower and are what GitHub recommends, but they have no
equivalent pre-fill and around fifty permission checkboxes. That is where a
first-time user gives up, so do not send them there by default.

Then: a paste field, store the token in IndexedDB, and offer a **Forget this device**
button — people will sign in on library machines.

### Recovery, since there is no refresh

Classic tokens are shown once and cannot be read back, so a lost or expired token
means minting a new one. That is a 30-second job and the local vault is untouched,
provided the failure is designed rather than discovered.

On `401`:

1. keep the editor working and keep saving locally;
2. show "your GitHub link has expired" with the same deep link;
3. accept a new token, then replay the queued commit.

Expiry is the main operational cost of this choice. Ask for a 1-year token and treat
the annual `401` as routine, not as an error. Do not encourage never-expiring tokens:
a permanent credential in a school browser ends up in a screenshot.

### Requests

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

Pin the version header. Breaking changes ship only in dated versions, each supported
for at least 24 months.

Treat the token as an opaque string — never validate length or prefix. GitHub changed
installation tokens from 40 characters to ~520 in 2026 with three weeks' notice.

### If OAuth is ever wanted

Keep everything behind `getToken() : Promise<string>` and the rest of the app is
unchanged. The device flow would buy an eight-character sign-in and silent refresh,
but `github.com` sends no CORS headers, so it needs a stateless shim in front of the
two auth endpoints. Worth it only if token expiry becomes a real support burden.

The `repo` scope grants read/write to every repository the user can see. That is why
the token must never be shared, pasted into a chat, or committed.

## 3. Finding or creating the repo

```
GET /repos/{login}/pydle
```

- **Exists and looks like a vault** → connect.
- **Doesn't exist** → offer *"Create my workspace"*. `POST /user/repos` with
  `private: true` and `auto_init: false`. The classic `repo` scope permits this.
- **Exists but isn't a vault** (no `pydle.json`, no recognised layout) → refuse and
  offer a different name. Never scaffold over someone's files.

Always ask before creating. A repository in someone's account is a visible,
permanent side effect, not something to do silently on first sign-in.

`auto_init: false` is deliberate: `auto_init: true` leaves a junk README commit at
the root of the user's history forever.

A fine-grained token scoped to Contents only cannot create a repository — that needs
Administration: write. Another reason classic is the default.

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

## 7. Sync

Local first. The browser is the source of truth; GitHub is a sync target.

- Files live in OPFS with an IndexedDB fallback.
- Saves write locally immediately, and commit to GitHub on a debounce (~20–30s) or
  on an explicit save.
- If the network, the token, or GitHub itself fails, the save still succeeds locally
  and the commit is queued. Never block editing on a network call.
- Queue the commit, not each keystroke. On reconnect, one commit covering what
  changed.

This is the property that makes the whole thing usable: an expired token, a filter,
or an outage means "will sync later", never "lost the lesson's work".

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

- **Account required** for sync, therefore 13+. Without an account pydle works as it
  does today.
- **Token expiry is the recurring cost.** One 1-year token per user, re-minted
  annually, with a `401` path that never loses work.
- **Tokens are shown once.** A lost token cannot be recovered, only replaced. Say so
  in the UI at creation time.
- **Signup is the sharp edge.** Accounts created in bulk from one school NAT get
  flagged as multi-accounting and suspended; appeals take weeks. If teachers point a
  class at this, the guide must say: sign up at home, before the lesson.
- **`api.github.com` must be reachable.** Different hostname from `github.com`, and
  filters sometimes allow one and block the other.
- **No local-only story for the under-13s.** They get today's pydle, unchanged.

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
