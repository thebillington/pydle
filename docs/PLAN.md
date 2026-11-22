# pydle school mode: how it works

The concrete spec. For the research and the rejected alternatives, see
[SCHOOLS.md](SCHOOLS.md).

Scope: **Year 9 and up** (GitHub requires account holders to be 13+, and every
Year 9 pupil is. Years 7–8 are out of scope).

Model: **one private repository per student, owned by a school GitHub org. The
student signs in with their own GitHub account using the OAuth device flow.** No
pupil data is stored by pydle; the only server is a stateless CORS shim that keeps
nothing.

---

## 1. Why accounts, in one paragraph

Access from home means a device the student has never used before needs a
credential. Either the student carries it (they type 93 characters of PAT, and
must recover it if lost) or something resolves it (an account, which the student
re-authenticates). Carrying a secret is the thing that does not survive shared
school devices or lost cards. An account is the only credential that is portable
by *re-authenticating* rather than by *transporting*, which is why a student moving
device costs nine characters and not a support ticket.

The device flow's user code is eight characters (`WDJB-MJHT`). That single fact is
what makes school onboarding viable, and it is what the PAT model could not offer.

## 2. What the teacher does, once

Per class, once a year, in the admin panel.

1. Create an org (free) owned by a **school account**, not a personal one — so
   repository ownership survives staff turnover.
2. Create one private repo per student, named `pydle-<pupil-ref>`
   (`pydle-P0142`). Use a pupil reference, not a name: repo names leak into
   screenshots, clones and exports.
3. Invite each student to their own repo as an **outside collaborator**:

   ```
   PUT /repos/{org}/{repo}/collaborators/{username}   { "permission": "push" }
   ```

   Paste the class list of GitHub usernames and the panel does the rest.

   Outside collaborators, not org members: a student then sees only their own repo
   and never appears in the org's People list, so no pupil can enumerate their
   classmates. Set the org's base permission to **none** as well.

4. Order matters: repo and invite first, then the student signs in. A student
   cannot create a repo in an org they are not a member of.

Notes:

- Do not require org-wide 2FA at first — every outside collaborator must enrol
  before accepting the invite, which is a real September support load. Turn it on
  once the class is running.
- Do not enable fine-grained PAT approval for the org; nothing in this design
  needs it.

## 3. What the student does, once per device

Open pydle → **Connect GitHub** → pydle shows an eight-character code → the student
opens `github.com/login/device` on any device, enters the code, approves → done.

pydle keeps the resulting token in IndexedDB and refreshes it, so this happens
**once per device**, not once per lesson.

A new device means signing in again. That is the intended behaviour, not a
failure — there is nothing to transfer and nothing to lose. Include a **Forget this
device** button, because students will sign in on library machines.

## 4. Authentication mechanics

### Device flow

Two requests are needed, and both live on `github.com`, which sends **no CORS
headers**:

```
POST https://github.com/login/device/code        → device_code, user_code, interval
POST https://github.com/login/oauth/access_token → poll until access_token
```

`api.github.com` does allow CORS, so every data request goes direct from the
browser. Only these two are proxied.

The shim is a Cloudflare Worker with a hard allowlist:

- only those two paths, only `POST`, everything else `404`;
- no storage, no database, no cookies;
- no client secret — the device flow does not need one, and that is why this
  design has nothing worth stealing;
- `Origin` allowlisted to the production domain, with `Vary: Origin`;
- optionally pinned to our `client_id`.

GitHub's reply to the first call:

```
device_code=3584d83530557fdd1f46af828993c8ef79f9dc5   secret, stays in the browser
user_code=WDJB-MJHT                                   the 9 characters shown to the human
verification_uri=https://github.com/login/device
expires_in=900
interval=5
```

Poll the second endpoint every `interval` seconds with `device_code` and
`grant_type=urn:ietf:params:oauth:grant-type:device_code`:

- `{"error":"authorization_pending"}` — keep polling
- `{"error":"slow_down"}` — add 5 seconds to the interval, for this and all
  subsequent polls (RFC 8628)
- `{"error":"expired_token"}` — the 15 minutes elapsed; start again
- `{"error":"access_denied"}` — the student declined

Success returns `access_token`, `refresh_token`, `expires_in` and `scope` in one
JSON body. Store all four; the refresh token is what stops the next lesson costing
another sign-in.

**The authorisation step may happen on a different device from the one running
pydle.** Show the URI as a QR alongside the code: a student whose phone is already
signed into GitHub can scan, type the code there and approve, and the school
machine receives a token without ever seeing a password. Design the screen around
that path — it is what makes a shared device viable.

**Device-code phishing is this flow's known weakness.** Someone sends a code and
asks you to enter it, which grants *them* access. Show the app name and the org on
the confirmation step so a pupil notices when the destination isn't theirs, and
say plainly in the UI that a code should only ever be entered for a screen you are
looking at.

**The shim sees the access token in transit**, because it forwards the token
response. "Stores nothing" is not "sees nothing". Never log request or response
bodies — state that in the code, not just in a comment elsewhere.

### Scopes and token lifetime

Request `repo` (the minimum for writing to a private repo — OAuth scopes are
coarse) plus `offline_access`.

`offline_access` matters: newly created OAuth apps issue **8-hour access tokens**
by default. Without a refresh implementation, students re-authenticate every
lesson. With it, refresh tokens last ~6 months of non-use, so a re-auth lands
roughly once a term.

```
POST https://github.com/login/oauth/access_token
  grant_type=refresh_token&refresh_token=...&client_id=...
```

Also proxied by the shim, since it is the same host and the same CORS problem.

The consent screen reads *"Full control of private repositories"*. For a pupil
whose only private repos are school work that is harmless, but a teacher will ask
about it — explain it in the teacher docs rather than letting it look reckless.

### Requests

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

Pin the version header; do not rely on the default drifting. Breaking changes only
ship in dated versions, and each version is supported for at least 24 months.

### Finding the repo after sign-in

Never ask the student to type a repository name. Resolve it, in this order, and
stop at the first hit:

1. **Personal workspace.** `GET /repos/{login}/pydle`. If it exists and looks like
   a vault, connect. If it does not exist, offer *"create my workspace"* — one
   `POST /user/repos`, private — and scaffold it. This path needs no teacher, no
   org and no invite, which is what makes pydle usable by an individual.
2. **Class workspaces.**
   `GET /user/repos?affiliation=collaborator&per_page=100`, keeping entries whose
   name starts `pydle-` and whose `permissions.push` is true.
3. **If a class link is present** — `pydle.uk/#org=stmarys-cs` — narrow step 2 to
   that owner. The teacher posts the link once per class; it is not per student.
4. **Exactly one match** → connect silently, with no UI at all.
5. **Several** → picker showing `org/repo`, last commit date and last opened.
6. **None** → *"ask your teacher for access"* if a class link is active, otherwise
   offer the personal workspace.

Naming convention, which is the whole mechanism:

```
<login>/pydle                personal: created on request, owned by the student
<school-org>/pydle-<ref>     class: created by the teacher, pushed by the student
```

No class segment in the name. A pupil who somehow ends up in two classes gets two
repos in two orgs, which the workspace switch below already covers.

**Personal and class are not a setting — they are derived:**

```js
const isPersonal = repo.owner.login === signedInUser.login;
```

Personal is a repo in the student's own account, where they are admin. Class is a
repo in the school org, where they are an outside collaborator with push. Nothing
else distinguishes them, so there is no preference to store and no mode to choose.

A user can have both, and nothing special-cases it — they are two independent
repositories the same account can push to. Keep it rare rather than supported:

- create the personal workspace **only** on explicit request, or when nothing else
  resolves — never automatically for someone who already has a class workspace;
- show one active workspace, named in the header, with a **Switch workspace…**
  action that lists the rest. Not a permanent two-item switcher, and no picker at
  startup;
- the picker appears only when both exist on a device with no class link, which is
  genuinely ambiguous and worth exactly one question;
- cache `owner/repo` locally against the token, so resolution runs once per device
  and never again.

Two side benefits of keeping personal separate: it survives the school org being
deleted or the teacher leaving, and "archive my school work to my personal
workspace" is later just a blob copy through the same sync code rather than a new
feature.

Guard rails on connecting:

- refuse if `permissions.push` is false — read-only repos are class resources,
  not workspaces;
- refuse to scaffold into a non-empty repo that has no `pydle.json` and no
  recognised layout; offer a different name rather than writing over someone's
  files;
- an empty repo is scaffolded per §5, creating the branch with `POST /git/refs`.

## 5. Bootstrapping an empty repo

If the repo has no commits, pydle generates the whole structure in **one atomic
commit**. Two traps:

- **An empty repo has no ref to patch.** `PATCH /git/refs/heads/main` fails. Use
  `POST /git/refs` to create `refs/heads/<branch>`.
- **Do not hardcode `main`.** Read `default_branch` from the repo object and use
  it for the ref.

```
GET    /repos/{o}/{r}                           → default_branch, empty?
POST   /git/blobs            × N                → one per scaffolded file
POST   /git/trees                               → no base_tree, whole tree
POST   /git/commits                             → no parents
POST   /git/refs            refs/heads/{branch}  → creates the branch
```

Every later save is the same sequence with `base_tree`, a parent, and
`PATCH /git/refs/heads/{branch}`.

A `PATCH` that is not a fast-forward returns `422`; refetch the head and re-apply.
Because teacher and student write to disjoint directories (§7), re-applying always
succeeds.

## 6. Commit identity

The student is the author, and the student's own credential is the committer. That
is what makes the repo a portfolio they own.

| Field | Value |
|---|---|
| `author.name` | `GET /user` → `name` or `login` |
| `author.email` | `<id>+<login>@users.noreply.github.com` |
| `committer` | same |

The noreply address is constructed from the authenticated user's `id` and `login`,
so commits link to their GitHub profile while their real email never enters the
history. This is also why nothing needs to be scrubbed before a student forks the
repo into their own account at the end of the year.

## 7. Repository layout

Ownership is decided by the **first path segment**. A publish can therefore never
clobber a pupil's work, and concurrent writes cannot collide.

```
pydle-P0142/
├── README.md                 generated: class, assignments, status
├── pydle.json                vault metadata
│
├── work/                     STUDENT-OWNED, free-form projects
│   └── spiral/
│       ├── main.py
│       └── project.json      optional: title, entrypoint
│
├── assignments/              TEACHER-OWNED, read-only to the student
│   └── 2026-11-angles/
│       ├── assignment.json
│       ├── brief.md
│       ├── starter/main.py
│       └── tests/test_main.py
│
├── submissions/              STUDENT-OWNED, created from starter/
│   └── 2026-11-angles/
│       ├── main.py
│       └── notes.md
│
└── feedback/                 TEACHER-OWNED
    └── 2026-11-angles.md
```

The editor refuses to write under `assignments/` or `feedback/`.

## 8. Submission is a tag

No database, so "handed in" must be derivable from git.

- `submitted/2026-11-angles` — annotated tag on the submitted tree.
- Resubmission → `submitted/2026-11-angles-2`.
- Late = tag date vs `due`.
- The student can keep editing after submitting and the evidence does not move.

Commit message prefixes keep history readable:

```
work: add spiral
submit: 2026-11-angles
feedback: 2026-11-angles
publish: 2026-11-angles v2
```

## 9. File formats

`assignment.json`:

```json
{
  "format": 1,
  "id": "2026-11-angles",
  "title": "Angles and loops",
  "version": 2,
  "issued": "2026-11-14T09:00:00Z",
  "due": "2026-11-28T16:00:00Z",
  "entry": "main.py",
  "tests": ["tests/test_main.py"],
  "points": 10,
  "brief": "brief.md"
}
```

`feedback/<id>.md` — Markdown so it renders on GitHub, front matter so it can be
parsed:

```markdown
---
assignment: 2026-11-angles
marked: 2026-12-01T10:00:00Z
marker: J. Smith
mark: 8/10
comments:
  - path: main.py
    line: 12
    note: This loop never terminates — check the condition.
---

Good work on the loops. The turtle shape is neat, but you never closed it off.
```

The gradebook is a scan of the org: `assignments/*/assignment.json`, presence of
`submitted/*` tags, `feedback/*.md` front matter. No database, no drift, and a
teacher can reconstruct everything from GitHub alone if pydle breaks.

## 10. UI

One connect path only. The PAT field, if it exists at all, lives behind "having
trouble connecting?" and is not presented as an option.

| Screen | Reads | Writes |
|---|---|---|
| Connect | device flow, `/user/repos` | — |
| My work | `work/*`, `submissions/*` | — |
| Editor | one folder | that folder only |
| History | `git log` for that folder | — |
| Assignments | `assignments/*`, tag presence | `submissions/<id>/` from `starter/` |
| Feedback | `feedback/<id>.md` | — |
| Submit | — | tag + push |
| Teacher: Class | org repos, collaborators | repo create, invite |
| Teacher: New assignment | form | `assignments/<id>/` across N repos |
| Teacher: Review | `submissions/<id>` at its tag | `feedback/<id>.md` |
| Teacher: Gradebook | all of the above | CSV |

Status derives entirely from the filesystem:

```
no submissions/<id>/   → To do
folder exists          → In progress
submitted/* tag exists → Submitted
feedback/<id>.md       → Marked
```

## 11. Export

A `.git` bundle, or a plain `git clone` of the repo. Complete history, works
offline, imports into any other host. This is the exit path and the answer to
"what if this project stops".

## 12. Known ceilings and risks

- **Signup is homework, not a lesson.** Twenty-odd accounts created from one
  school NAT in a few minutes get flagged as multi-accounting and suspended;
  appeals take weeks and must be individual. Ship a one-page guide and make lesson
  one entirely local.
- **`api.github.com` must be reachable** through the school filter. It is a
  different hostname from `github.com`, and filters sometimes allow one and block
  the other. Test both.
- **Everything must degrade gracefully.** An expired token, a suspension, a
  filter, or an outage should mean "saved locally, will sync later", never "lost
  the lesson's work". The local vault is the source of truth; GitHub is the sync
  target.
- **Publishing is an N-write fan-out** — one form submission writes
  `assignments/<id>/` into every repo in the class. Fine at class scale; move to a
  `workflow_dispatch` GitHub Action in the teacher's org if cohorts grow.
- **No student-facing password recovery** exists, by design. It is GitHub's.
