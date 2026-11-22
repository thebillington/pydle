# pydle for schools: storing and moving student work

This document answers a single question: **how do students get their work out of a
browser and back again**, given that pydle has no backend, and schools will not pay
for one?

It covers the three options considered, the numbers behind each, prior art, and a
recommendation. It is a feasibility study, not a specification.

Status: research done 2026-11-22. Prices and limits are as published on that date and
should be re-checked before committing to anything.

---

## 1. The problem, stated precisely

pydle today stores saved scripts in `localStorage` (`pydle_file_*` keys in
`index.html`). That is fine for one device one afternoon. It fails for a school in
three specific ways:

1. **Shared devices wipe.** A managed Chromebook or a logged-out school PC loses
   origin storage. Work done on Tuesday is gone on Thursday.
2. **The device is not the student.** Work saved on the art-room machine is not on the
   one in the computing lab.
3. **Home is a different device again.** "Access it from home" is the actual
   requirement, and it is a cross-device sync problem, not a storage problem.

Everything below is about moving a few kilobytes reliably, not about hosting an IDE.

The reassuring part: **student source code is tiny.** A 725-byte turtle program
compresses to 338 bytes. A year of a student's work, including version history, is
under a megabyte. This is a data-movement problem, not a storage problem, and that
changes which of the three options is sensible.

---

## 2. Option 1 — no backend: QR codes and peer-to-peer

### 2.1 How much actually fits in a QR code

QR capacity is bounded by version (21×21 to 177×177 modules) and error correction.
The absolute maximum, version 40 at level L, is **2,953 bytes** in byte mode
(2,331 / 1,663 / 1,273 bytes at M / Q / H). That is the number everyone quotes, and
it is the wrong number to design against, because a payload that has to survive a
screen-to-camera trip should not be pushed to the limit.

Two practical ceilings:

| Encoding | Why | Usable payload in one version-40 code |
|---|---|---|
| Raw binary, byte mode | Needs your own binary-safe decoder | 2,953 B |
| Base64url inside a URL, byte mode | Works with the stock phone camera app, any JS scanner | ~2,180 B of compressed data (2,953 − prefix, ÷ 4/3) |
| Base45 in a custom URL scheme, alphanumeric mode | 4,296 chars at v40-L instead of 2,953 bytes | ~2,860 B |

**Design against ~2.1 KB of compressed source per code.** That is the honest number if
you want a student to point the built-in iOS/Android camera at a projector and have a
URL open, with no app installed.

Measured against real pydle content:

| File | Source | Deflate | Base64url | Single QR? |
|---|---|---|---|---|
| Small turtle program | 725 B | 338 B | 452 chars | Yes, comfortably |
| Typical lesson program | 2 KB | ~800 B | ~1,070 chars | Yes |
| Large project | 20 KB | ~7 KB | ~9,300 chars | No — animated |

So a single QR carries **almost every pydle program a student will write**. Python
source is highly compressible and pydle files are short. Animated multi-frame codes
are the exception path, not the norm.

### 2.2 Multi-frame (animated) QR

For files over the single-frame limit, stream a sequence of codes and let the
receiver collect frames in any order. Use a **fountain code** (LT or RaptorQ), not
numbered frames — the camera *will* miss frames and there is no back channel to
request retransmission. This is a solved problem; see §5.

Measured real-world throughput, from published implementations:

| Setup | Throughput |
|---|---|
| iPhone 12 scanning a 1080p laptop screen, ~20 cm | ~8 KB/s (reproducible, benchmarked) |
| Laptop screen → phone at arm's length, tuned | 20–25 KB/s |
| Phone OLED → phone camera, held close | 50–60 KB/s |
| Theoretical (v30-L at 30 fps) | 51 KB/s raw |

Plan on **10 KB/s**. Consequences:

- 2 KB program → under a second.
- 20 KB project → ~2 seconds.
- 100 KB project → ~10–15 seconds.
- 1 MB → a minute or more. Not worth it; use another channel.

### 2.3 The direction problem

This is the part that does not work as cleanly as people expect.

**Laptop → phone is easy.** Show a QR on screen, scan with the phone, save to Files.
Any school PC with a screen and any phone with a camera. No network, no account, no
app. This is genuinely excellent and nothing else in this space offers it.

**Phone → laptop is hard.** It needs one of:

| Method | Requirement | Failure mode |
|---|---|---|
| Laptop webcam + on-screen scanner | Laptop has a camera | Most desktop PCs don't; Chromebooks and laptops do |
| WebRTC data channel, QR as signalling | Both devices can reach each other (STUN may suffice; TURN may not) | School wifi with client isolation, or UDP-blocking firewalls, kill it |
| Screenshot/photo of the phone's QR, decoded later | Nothing | Awkward but always works |
| Relay server | A backend | Contradicts the premise |

The WebRTC route is real and needs no server of your own: pack the SDP down to the
ICE credentials, DTLS fingerprint and candidates — about 130–250 bytes, which is a
tiny QR — and exchange offer and answer by scanning. Two scans and you have an
encrypted data channel carrying arbitrary file sizes in both directions. This is
prior art (§5), not a research project.

**But** it depends on the two devices being able to reach each other. Same-room,
same-wifi, no AP isolation: usually fine. School guest wifi is often exactly the
environment where it is not.

### 2.4 Where the file actually lives on the phone

"Stored on the phone" has four meanings, and they are not equally durable:

| Mechanism | iOS Safari | Android Chrome | ChromeOS | Durability |
|---|---|---|---|---|
| Browser download → Files app | Yes | Yes | Yes | **Real file, user-owned.** Best. |
| `localStorage` / IndexedDB / OPFS | Yes | Yes | Yes | Evicted after 7 days of no interaction on iOS **unless installed to home screen**; wiped entirely in ChromeOS managed guest mode |
| File System Access API (persistent folder handle) | No | Yes since Chrome 132, but permission persistence is **desktop-only** | Yes | Good on desktop/ChromeOS, unreliable on Android |
| Web Share API to Drive/Notes/Photos | Yes | Yes | n/a | Depends on the target app |

The hard rule that falls out of this: **never let browser storage be the only copy.**
The vault must be a *file the student owns*, with browser storage as a cache. That is
true on iOS (7-day eviction) and doubly true on school Chromebooks (wipe on logout).

### 2.5 Verdict on Option 1

**Ship it, but as a feature of the free site, not as the product.**

- Laptop → phone single QR: build it. It is a genuine differentiator, it costs
  nothing to run, and it is the single best answer to "Trinket shut down and I lost
  everything" — the work is a file on hardware the student owns.
- Phone → laptop: build the WebRTC path, but present it as best-effort, with
  "download the file and email it to yourself" as the documented fallback.
- It cannot be the *school* offering on its own, because:
  - many schools ban phones;
  - it gives the teacher nothing (no marking, no homework collection, no
    safeguarding visibility);
  - it depends on the student keeping a file safe, which is not a reasonable
    expectation of an 11-year-old.

Used well, it is a *hand-in* mechanism: the student shows a QR of their finished
program, the teacher scans it on their phone or laptop, and no server was involved at
any point. That is a lovely story for a school that does not want pupil data leaving
the building.

---

## 3. Option 2 — hosted, you run it

### 3.1 Architecture

The obvious Cloudflare stack, and it is a good fit:

- **Static site** — pydle itself, as Workers static assets or Pages. Requests to
  static assets are **free and unlimited**; only requests that invoke the Worker are
  metered. Pyodide runs client-side, so the expensive part is already free.
- **Worker** — auth, sync API, admin API.
- **D1** (SQLite) — classes, students, metadata, audit log.
- **R2** — the actual file blobs and git packs. Zero egress cost.
- **Durable Object** (optional) — per-vault ref updates if you want linearisable
  concurrency. SQLite-backed DOs are available on the free plan.
- **Cloudflare Access** — teacher/admin login, free for up to 50 users, Google or
  Microsoft SSO, zero password code.

### 3.2 The git question

You asked for git with exportable history. Three ways, in increasing order of effort:

**(a) Client-side git, server as object store.** The browser holds the repo using
`isomorphic-git` + `lightning-fs` (both mature, IndexedDB-backed) or `wasm-git`
(libgit2 compiled to WASM, ~800 KB–1.5 MB, requires a worker, much faster on
`git log`). The server only stores content-addressed blobs and a `refs` document.
One PUT per save. This is the right choice for v1.

**(b) Client-side git, static dumb-HTTP export.** Run `git update-server-info` at
export time and you get `.git/info/refs` and `.git/objects/info/packs`. R2 can serve
those as plain static files, and **stock `git clone https://…/u/abc/repo.git`
works** against it. Read-only, but that is what "export the full history" means. Cost:
one Class B read per object, tens of reads for a student repo. This is a genuinely
cheap trick and worth using for the export button alone.

**(c) A real git smart-HTTP server on Workers.** Doable — several projects do it
(`git-on-cloudflare`, `dgit`, `gitmode`) — but it means pkt-line framing, pack
negotiation, delta resolution and streaming pack assembly inside a 128 MB / 10 ms
Worker. This is a solved problem, but it is a large amount of code to own, and
Cloudflare's own paid `Artifacts` product now exists for exactly this. Not for v1.

Note that Artifacts is **Workers Paid only**, so it cannot serve a free tier.

For the student experience, do not expose branches, merges or rebasing. Call them
**checkpoints**, with a timeline and a restore button. Git is the storage format, not
the UI.

### 3.3 What it actually costs

Storage first. Per student, per year, generously:

| Item | Size |
|---|---|
| 20 source files at ~3 KB | 60 KB |
| ~90 saved checkpoints × ~2 KB blob (git dedupes unchanged files) | ~180 KB |
| Commit/tree objects, ~90 × 350 B | ~30 KB |
| Slack, mistakes, a few images | rest |
| **Planning figure** | **1 MB/student/year; 10 MB with images and a safety factor** |

R2 pricing, which is the only part that scales with students:

| Students | At 10 MB each | R2 cost/month |
|---|---|---|
| 500 | 5 GB | $0 (under the 10 GB free allowance) |
| 1,000 | 10 GB | $0 |
| 5,000 | 50 GB | $0.60 |
| 25,000 | 250 GB | $3.60 |
| 100,000 | 1 TB | $15.21 |

Egress is free. **Storage is a rounding error at every plausible scale.** The widely
quoted fear about blob storage costs does not apply to text files.

Operations are the real constraint, and the free plan's constraints are *hard walls*,
not bills:

| Resource | Free | One school's realistic use | Verdict |
|---|---|---|---|
| Worker requests | 100,000/day | 1,200 students × 40 req/day = 48,000 | Fits, ~2× headroom |
| D1 rows written | 100,000/day | 1,200 × 50 saves = 60,000 | Fits, if autosave is debounced |
| D1 storage | 5 GB | metadata only, tens of MB | Fine |
| R2 storage | 10 GB | 12 GB for a 1,200-student school at 10 MB | Marginal |
| R2 Class A | 1M/month | ~100k/month | Fine |
| Worker CPU | 10 ms/invocation | see below | **The real constraint** |

The 10 ms CPU cap rules out several obvious designs: no Argon2, no `bcrypt` with
sane iterations, no server-side pack assembly. Concretely:

- PIN verification should be `HMAC-SHA256(secret_pepper, class|student|pin)` — one
  WebCrypto call, sub-millisecond, and a leaked database without the pepper is
  useless. Do not use PBKDF2 with a high iteration count here; you cannot afford it,
  and PIN security comes from rate limiting and scoping, not from the KDF.
- Sessions should be HMAC-signed cookies, not DB rows, so a page load is zero
  database writes. Remember the 100k/day write limit.
- Autosave must be debounced to 20–30 seconds. Autosave-per-keystroke would blow both
  the request and the write limit within a single lesson.

**$5/month Workers Paid removes the daily request wall and gives 30M CPU-ms**, which
is the sane production setting for anything real. Everything above is then bounded by
storage at a few dollars a month for tens of thousands of students.

### 3.4 The reason not to do this

It is not the cost. It is that **you become a processor of children's personal data**,
in many schools, under contracts you have to negotiate one at a time.

- UK schools must run a DPIA on any cloud service holding pupil data, and need a data
  sharing agreement, a named sub-processor list (Cloudflare), breach notification
  terms, retention and deletion commitments, and an exit/portability plan.
- DfE guidance wants data stored and processed in the UK or EU, with international
  transfers justified. R2 offers an **EU jurisdiction**; there is no UK jurisdiction,
  so UK schools would be relying on the UK Addendum/IDTA with Cloudflare. Check this
  before promising anything.
- If you sell direct to consumers (option 2 as a free public service), you are likely
  an information society service and therefore in scope of the **ICO Children's
  Code**, even as a non-profit. If you only ever act on a school's instructions as a
  processor, you are probably out of scope. That distinction is a strong argument for
  the self-hosted model in §4.
- You also become a single honeypot holding thousands of children's work, which is a
  security posture you have to be able to defend, not just a hosting bill.

**Recommendation: do not host student data as the primary offering.** If you want a
hosted thing, make it deliberately ephemeral — no accounts, no names, 24-hour expiry,
class-code only — so it is a demo and a bridge, not a database of children.

---

## 4. Option 3 — teacher-owned instances (recommended)

Each teacher (or school) deploys their own copy into their own Cloudflare account.
They are the data controller; you ship software.

### 4.1 Deployment, realistically

The plumbing is now genuinely easy:

- A **Deploy to Cloudflare button** clones a public repo into the teacher's GitHub,
  provisions the D1 database, R2 bucket and Worker automatically from
  `wrangler.jsonc`, and connects Workers Builds. No API token, no local Node.
- `wrangler.jsonc` bindings can omit resource IDs and Wrangler provisions resources
  on first deploy.
- Or, for the technical: fork → add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
  as GitHub secrets → `cloudflare/wrangler-action` deploys on push.
- **A domain is optional.** `*.workers.dev` works, and free. A custom domain is
  needed in practice because many school filters block `workers.dev`, and because
  `*.pages.dev` looks untrustworthy to a DPO. Budget £10/year, not a real cost.

Honest risk: **self-hosted education software usually dies of upgrade friction.**
Version skew, manual migrations and "it stopped working after a year" are what kill
these projects. Mitigations to build in from day one:

- one Worker, no separate frontend to keep in sync;
- D1 migrations that run automatically on deploy;
- an `/admin/upgrade` page that shows current vs latest version and a one-click
  "redeploy from upstream" (a repository dispatch to the teacher's fork);
- a `/status` endpoint and a support bundle export (versions, row counts, last error,
  no student data) so a teacher can send you something useful;
- never make a schema change that requires manual SQL.

### 4.2 Teacher admin panel

Authentication: put `/admin` behind **Cloudflare Access** (free, 50 users, Google or
Microsoft SSO). The Worker verifies the `Cf-Access-Jwt-Assertion` header. This means
you write **no password code and no password reset flow** for teachers, which
eliminates the most common support ticket in school software.

Student authentication: this is a solved pattern and every competitor does it the same
way, for good reason.

- Class code (6 characters, e.g. `7XK2QP`) → tap your name from a grid → 6-digit PIN.
- No email address, no password, no account creation.
- Teachers print **login cards** with a QR code per student, which also solves the
  "five-year-old cannot type" problem and the "shared Chromebook" problem.
- PINs are generated, shown once, and resettable by the teacher. Hash with a
  peppered HMAC as above.
- Rate limit per class, not per IP (schools are behind one NAT).

Admin panel scope for v1:

| Feature | Why it is needed |
|---|---|
| Class and student management | Roster, PIN reset, login cards |
| View any student's files and history | Safeguarding expectation; DfE guidance explicitly wants an audit trail for safeguarding leads |
| Comment on a line of code | The "feedback on homework" requirement, and the main pedagogical value |
| Assignment + deadline + collect | Turns a playground into a classroom tool |
| Audit log of teacher access | DPIA requirement, and protects the teacher too |
| Export a student / whole class as zip of git bundles | Portability and exit; also the safety net when the teacher stops paying |
| Storage usage per student + quota | Keeps the free tier free |

### 4.3 Realistic capacity

Per teacher instance, on the **free** plan:

| Cohort | Students | Est. storage | Est. requests/day | Fits free tier? |
|---|---|---|---|---|
| One class | 30 | 300 MB | ~1,200 | Easily |
| One department | 150 | 1.5 GB | ~6,000 | Easily |
| One secondary school | 1,200 | 12 GB | ~48,000 | Yes; storage slightly over 10 GB → ~$0.03/month |
| One large school, heavy use | 2,000 | 20 GB | ~80,000 | Requests near the 100k wall; storage $0.15/month |

**Practical ceiling on the free plan: roughly 1,500–2,000 active students per
instance**, set by the 100,000 requests/day wall, not by storage. On the $5/month
paid plan, the same instance handles 10,000+ before CPU becomes interesting.

Recommended per-student quota: **25 MB soft, 50 MB hard**. That is 25–50× what a
student needs for Python, leaves room for images or notebooks later, and puts 400
students on the free 10 GB allowance.

### 4.4 Compliance position

This is the strongest argument for option 3 over option 2:

- The school is the data controller, the teacher administers the instance, and you
  never hold the data. No DPA with you is strictly needed, because you process
  nothing.
- Cloudflare becomes the school's sub-processor under Cloudflare's own standard terms,
  which schools already accept for other services.
- You are not an information society service processing children's data, so the
  Children's Code is very likely out of scope.
- There is no central honeypot to breach.
- Data residency is the teacher's choice of Cloudflare jurisdiction.

You should still ship a **ready-made DPIA pack**: data flow diagram, sub-processor
list, retention defaults, and a "what we do not collect" page. That document is
cheap to write and is what actually unblocks a sale to a school.

---

## 5. Prior art

Worth knowing, because most of this is already built and some of it can be reused.

**QR / optical file transfer** — a crowded and mature space:

- `txqr` and `gofountain` — the originals; animated QR + fountain codes.
- AirQR — RaptorQ, Rust/WASM, browser and Flutter, benchmarked at ~8 KB/s.
- Decimen / `optical-transfer` — LT fountain codes, documented tuning guidance, the
  best public write-up of the real-world trade-offs.
- QR File Transfer (`qrfiletransfer.app`) — full protocol spec, per-frame CRC32,
  BLAKE3 whole-file verification, six-character transfer ID to avoid two neighbouring
  streams colliding. Good design to copy.
- OneSend, `one-transfer`, CIMBAR (colour codes, much higher density, much fussier).

**WebRTC with QR signalling, no server** — also solved:

- Beam (`Londopy/beam`) — packs SDP to ~250 chars, two scans, static files on GitHub
  Pages.
- FileDrop — ~175-character answer payload, offer in the URL fragment, candidate
  compaction, native `BarcodeDetector` with a bundled fallback.
- `qrdrop`, `filetunnel`, QWBP (a formal spec for QR-bootstrapped data channels),
  `libp2p` over QR.

**Git in the browser:** `isomorphic-git` + `lightning-fs`; `wasm-git` (libgit2/WASM).
Server-side on Workers: `git-on-cloudflare`, `dgit`, `gitmode`, and Cloudflare's own
**Artifacts**.

**The product space** — Trinket shut down on 31 August 2026 and the gap is being
contested hard: CS Room, Pickcode, Kita, Dodona, CodeHS, Coding Pathway (UK), CS++,
onlinecompiler.io. Every one of them is cloud-first, account-first, and
teacher-dashboard-first.

**The gap pydle can actually occupy:** no account, no server, offline-capable, UK,
free, and *the school owns the data*. That is a real and defensible position — it is
the opposite of every competitor — and it is the one thing Trinket's collapse proved
people care about. It is also a much smaller market than "a better CodeHS", which is
fine.

---

## 6. Recommendation

**Build the vault, not the service.** The same artifact serves all three options, so
nothing is wasted:

```
Vault  =  a git repository  +  a manifest  +  optional passphrase encryption
          stored locally (OPFS  +  File System Access handle)
          exported as one file  `name.pydlevault`
          synced by a pluggable backend: none | QR | R2 | WebRTC
```

Because the vault is a real git repo, "export the full history" is `git clone
name.pydlevault`, and a student can take their work to GitHub or a laptop later. Because
it is one file, the transport is irrelevant: QR, USB stick, email to self, Google
Drive, or a Worker.

### Phase order

| Phase | What | Why first |
|---|---|---|
| 1 | Vault format, OPFS/IndexedDB storage, import/export `.py` and `.pydlevault`, service worker so the app works offline after first load | Fixes "the device wiped my work" with no backend at all |
| 2 | Single-QR export (deflate + base64url in the URL fragment) and QR import via camera | The differentiator. Mostly free to run. Ship it on the public site |
| 3 | Animated multi-frame QR with a fountain code, both directions | Only needed for large projects; do it after 2 proves useful |
| 4 | WebRTC pairing by QR, bidirectional, no server | Solves phone → laptop where a camera is absent |
| 5 | Client-side git checkpoints + static dumb-HTTP export | Delivers the version-history requirement at ~zero server cost |
| 6 | Worker + R2 + D1 + class-code auth; the hosted sync target | The actual "access from home" story |
| 7 | Teacher panel behind Cloudflare Access, Deploy to Cloudflare button, DPIA pack | Turns it into a school offering |

Phases 1–2 are maybe a week's work and stand alone as a good release. Phase 6 is the
one that needs a decision about who holds the data, and §4 argues it should be the
teacher.

### Things to decide before writing code

1. **Is a phone allowed in the room?** If not, phase 2 is a home-only feature and the
   classroom story depends entirely on phase 6. This changes the roadmap order.
2. **Who is the customer?** A teacher self-hosting for free, or a school buying
   support? The former is a community project; the latter needs the DPIA pack, a
   support contract, and probably a company.
3. **UK-only or international?** UK GDPR plus the DfE cloud standards is a specific
   set of requirements; adding FERPA/COPPA changes the admin panel.
4. **Does the sponsor want their name on a free public service, or on development of
   self-hosted software?** The second is a much easier ask and avoids the compliance
   question entirely.

---

## 7. Key numbers, one page

- One QR code holds **2,953 bytes** raw; **~2.1 KB of compressed source** as a URL.
- A typical pydle program is **under 2 KB of source and compresses to under 1 KB**, so
  **one QR is almost always enough**.
- Animated QR runs at **~10 KB/s** planning figure (3–60 KB/s measured range).
- A student's year of work with history is **~1 MB**; plan **10 MB** with images.
- Cloudflare R2: **10 GB / 1M writes / 10M reads free per month, egress free**.
  **1,000 students fit in the free allowance; 25,000 students cost about $3.60/month.**
- Workers free: **100,000 requests/day, 10 ms CPU**. Hard walls, not bills.
- **~1,500–2,000 active students per instance** on the free plan, limited by
  requests/day. **$5/month** raises that by roughly an order of magnitude.
- Sessions must be signed cookies, PINs must be peppered HMACs, autosave must be
  debounced to 20–30 s — all because of the 10 ms CPU and 100k write/day limits.
