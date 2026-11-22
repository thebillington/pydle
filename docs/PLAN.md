# pydle school mode: how it works

The concrete spec. For the research and the rejected alternatives, see
[SCHOOLS.md](SCHOOLS.md).

Scope: **Year 9 and up** (GitHub requires account holders to be 13+, and every
Year 9 pupil is. Years 7–8 are out of scope).

Model: **one private repository per student, owned by a school GitHub org, written
with a per-repository fine-grained PAT that the teacher mints.** No student GitHub
accounts. No server.

---

## 1. What the teacher does, once

Per class, once a year. About 20 minutes for 30 students.

1. Create an org (free) owned by a **school service account**, not a personal
   account. Tokens belong to the account that minted them, so a personal teacher
   account means thirty pupils lose access the day that teacher leaves.
2. Per student, create a private repo named `pydle-<pupil-ref>`, e.g. `pydle-P0142`.
   Use a pupil reference, not a name — repo names leak into screenshots and clones.
3. Per student, mint a fine-grained PAT. **Five settings, nothing else:**

   | Field | Value |
   |---|---|
   | Resource owner | the school org |
   | Repository access | Only select repositories → that one repo |
   | Permissions | **Contents: Read and write** |
   | Everything else | no access |
   | Expiration | 366 days — and **set them all to the same date** |

   Align the expiry dates or you get a slow trickle of locked-out students in
   February. All on 1 September is the obvious choice.

4. Give the token to the student: paste it into Classroom/Teams, or use pydle's
   "show as QR" so it can be projected or printed. Do not ask them to type it.

Notes:

- Do **not** enable fine-grained PAT approval for the org; as owner you would be
  approving your own tokens thirty times over.
- Do not mint from a personal account (see 1).
- `Contents: read/write` on one repo cannot delete the repo, change its settings,
  or reach any other repo. A leaked token costs one student's work, recoverable
  from history.

## 2. What the student does, once

Open pydle → **Connect** → paste or scan the token → done. pydle stores the token
locally against that device and repo. Once per device, not per lesson.

There is no account, no signup, no email, no password reset. A lost device is
reissued by handing over the same token again; a lost token is a 20-second
re-mint by the teacher.

## 3. Authentication

Every request:

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

`api.github.com` sends permissive CORS headers, so this all works from a static
page with no proxy.

**Treat the token as an opaque string.** Do not validate length or prefix — GitHub
changed installation tokens from 40 to ~520 characters in 2026 with three weeks'
notice. Send it and let the API return `401`.

Token lengths for context: fine-grained ~93 characters, classic 40. Both are
effectively impossible to type reliably (no per-character error feedback), so the
UI must accept paste and QR, and must not clear the field on failure.

## 4. Bootstrapping an empty repo

If the repo has no commits, pydle generates the whole structure in **one atomic
commit**. Two traps:

- **An empty repo has no ref to patch.** `PATCH /git/refs/heads/main` fails. Use
  `POST /git/refs` to create `refs/heads/<branch>`.
- **Do not hardcode `main`.** Read `default_branch` from the repo object; use it
  for the ref you create.

Sequence:

```
GET    /repos/{o}/{r}                          → default_branch, empty?
POST   /git/blobs            × N               → one per scaffolded file
POST   /git/trees                              → no base_tree, whole tree
POST   /git/commits                            → no parents
POST   /git/refs            refs/heads/{branch} → creates the branch
```

For every subsequent save the sequence is the same but with `base_tree`, a parent,
and `PATCH /git/refs/heads/{branch}`.

A `PATCH` that is not a fast-forward returns `422`; refetch the head and re-apply
the commit. Because the teacher and student write to disjoint directories (see
below), re-applying always succeeds.

## 5. Commit identity

Two identities, and the split matters:

| Field | Value | Why |
|---|---|---|
| `author.name` | pupil ref, e.g. `P0142` | no personal data in every clone and export |
| `author.email` | `p0142@pupils.invalid` | `.invalid` is reserved (RFC 2606): can never resolve, can never link to a real account |
| `committer` | the school service account | it is the credential that actually wrote it |

The history then reads "authored by P0142, committed by the school bot". If a
student later wants a real-name portfolio, `author.name` is a per-student setting;
changing it does not rewrite history.

## 6. Repository layout

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

## 7. Submission is a tag

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

## 8. File formats

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

## 9. UI

| Screen | Reads | Writes |
|---|---|---|
| My work | `work/*`, `submissions/*` | — |
| Editor | one folder | that folder only |
| History | `git log` for that folder | — |
| Assignments | `assignments/*`, tag presence | `submissions/<id>/` from `starter/` |
| Feedback | `feedback/<id>.md` | — |
| Submit | — | tag + push |
| Teacher: Class | org repos | — |
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

## 10. Export

A `.git` bundle, or a plain `git clone` of the repo. Complete history, works
offline, imports into any other host. This is the exit path and the answer to
"what if this project stops".

## 11. Known ceilings

- **Manual provisioning.** Fine-grained PATs cannot be created via the API, and
  neither can classic ones. One PAT per student means 30 trips through the UI per
  class per year. Roughly one or two classes per teacher before this becomes
  painful. A department-wide rollout needs OAuth, which is why the token layer
  should be a single `getToken() : Promise<string>` behind the connect UI.
- **Token lifecycle.** Org-scoped fine-grained PATs cap at 366 days. Align expiry
  dates and rotate annually as a known chore.
- **One service account.** If it is suspended or lost, every student stops until
  it is recovered. Own the recovery route for that account.
- **No student account** means no self-service password recovery — which is mostly
  a benefit, handled by reissuing the token, but it is the teacher's time.
