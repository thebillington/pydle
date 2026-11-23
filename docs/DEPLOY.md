# Deploying your own copy

pydle is a static site. There is no build step, no database and no server that runs
Python. Publishing a fork is enough to give a school its own copy that does not
depend on pydle.uk.

GitHub sync is the only optional part, and the only part that needs an account of
your own: one GitHub OAuth App and one Cloudflare Worker that adds CORS to GitHub's
device-flow endpoints.

## What you need

- A GitHub account, to fork this repository and serve it with GitHub Pages.
- Nothing else, if you do not want GitHub sync.
- For sync: a Cloudflare account (the free plan is enough) and permission to create
  an OAuth App under a GitHub account.

## 1. Publish the site

1. Fork this repository.
2. Delete or replace the `CNAME` file. It contains `pydle.uk`, and GitHub Pages will
   try to serve your fork at that address and fail its domain check.
3. In the fork, open **Settings → Pages**. Set **Source** to *Deploy from a branch*,
   branch `main`, folder `/ (root)`.
4. Add your own custom domain if you have one, and tick **Enforce HTTPS**. A domain
   or a user site (`https://<you>.github.io/`) is the simplest option: the links in
   the pages are absolute (`/teachers/`, `/turtle/`), so a project page served from
   `https://<you>.github.io/pydle/` will send visitors to the wrong place.
5. Cloudflare in front of Pages is optional. It is what pydle.uk does, mainly for
   caching and for the auth Worker's hostname, and nothing in the site needs it.

Pushing to `main` rebuilds the site. There is no separate publish branch.

## 2. Decide about GitHub sync

Without sync, students can still write, run, save to the browser and download
`.py` files. If that is enough, stop here: the site works as published.

The sign-in button will not work until you complete the two steps below. That is
the only visible difference.

## 3. Create your own GitHub OAuth App

1. Open **github.com/settings/developers → OAuth Apps → New OAuth App**.
2. Name it for your school. Homepage URL is your site.
3. Authorization callback URL is required by the form but not used by the device
   flow. Put your site URL there.
4. After creating it, tick **Enable Device Flow**. Without this every sign-in
   request returns `device_flow_disabled`.
5. Copy the **Client ID**. There is no client secret to keep, because the device
   flow does not use one.

## 4. Deploy the relay Worker

`worker/` is a small Cloudflare Worker that forwards exactly two paths to
github.com and adds CORS. GitHub sends no CORS headers, so a static page cannot
call those endpoints directly.

Either deploy it from the Cloudflare dashboard (create a Worker, paste
`worker/src/index.js`) or with `wrangler` from `worker/`. Its settings live in
`worker/wrangler.toml`:

- `ALLOWED_ORIGINS`: comma-separated list of origins allowed to read responses.
  Add your site's origin, and `http://localhost:8080` if you want to try sync
  locally. A request from an origin not on the list gets no CORS header.
- `CLIENT_ID`: your OAuth App's client id. When set, the Worker rejects requests
  carrying a different client id, so it cannot be used as a free CORS proxy for
  someone else's app.

Give it a real hostname rather than the `workers.dev` one. Many school filters
block `workers.dev` outright. pydle.uk uses `auth.pydle.uk` as a Worker Custom
Domain, which also creates the DNS record because the zone is on Cloudflare.

If you deploy through GitHub Actions, copy `.github/workflows/deploy-worker.yml`
and set two repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit,
Account Settings: Read) and `CLOUDFLARE_ACCOUNT_ID`.

## 5. Point the app at your own ids

Edit [`js/config.js`](../js/config.js):

```js
export const CONFIG = {
    clientId: 'your-client-id',
    shimBase: 'https://your-relay-hostname',
    apiBase: 'https://api.github.com',
    apiVersion: '2026-03-10',
    scopes: ['repo'],
};
```

Commit, push, and the site picks it up.

## 6. Check it works

1. Open your site and run a Python program.
2. Open the turtle editor and draw something.
3. **GitHub** button → **Sign in with GitHub** → GitHub shows a code, you approve
   it, pydle offers to create `pydle-workspace`. If the repository is created and
   a commit appears in it, sync is wired correctly.

If sign-in fails, the browser console shows the failing request: either the relay
is not reachable at `shimBase`, or your origin is not in `ALLOWED_ORIGINS`.

## Updating

Merge or pull from this repository into your fork, or copy the changed files. There
are no migrations and no versions in storage: the browser keeps projects in the
Origin Private File System, with IndexedDB as a fallback.

Run the tests with Node 18 or newer:

```bash
npm test
```

## What is stored, and where

- Nothing on the server. The published files are static, and the relay keeps no
  database, cookies or logs of request bodies.
- Projects live in the student's browser, and the GitHub token in that browser's
  IndexedDB. **Forget this device** removes the token.
- Commits go to the repository in the student's own GitHub account.

The relay does see OAuth token responses in transit, because it sits between the
browser and GitHub. Never log request or response bodies there, and never add a
debug header that echoes them.

## Costs

GitHub Pages and the Cloudflare Workers free tier both cover a school's use. The
only other network dependency is `cdn.jsdelivr.net`, which serves Pyodide and the
Python packages. If that domain is blocked, the editor will not start.
