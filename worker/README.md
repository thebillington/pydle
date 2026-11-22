# pydle auth shim

A Cloudflare Worker that puts CORS in front of the two GitHub OAuth endpoints the
browser needs for the device flow. `github.com` sends no CORS headers, so a static
page cannot call them directly.

It forwards exactly two paths to `https://github.com`, with the status and body
returned unchanged, and it does nothing else.

| Path | Used for |
|---|---|
| `POST /login/device/code` | starting the flow: get `device_code` and `user_code` |
| `POST /login/oauth/access_token` | polling while the user approves, and refreshing later |

`OPTIONS` on those paths answers `204` with the preflight headers. Everything
else — any other path, and any method other than `POST`/`OPTIONS` — is a `404`.

## Environment

Set in `wrangler.toml` under `[vars]`; both are public values, not secrets.

- `ALLOWED_ORIGINS` — comma-separated origin allowlist. `Access-Control-Allow-Origin`
  is only ever set to an origin on this list, with `Vary: Origin`. A request with
  no `Origin` header gets no CORS header.
- `CLIENT_ID` — the pydle GitHub OAuth App client id. When set, the Worker parses
  `client_id` out of the request body and rejects a mismatch with
  `403 {"error":"client_id_mismatch"}`, so the Worker cannot be used as a free
  CORS proxy for somebody else's app. Leave it empty to skip the check.

Other responses: `502 {"error":"upstream_unreachable"}` if GitHub cannot be
reached within 10 seconds.

## Deployment

Not from a laptop on this network: wrangler v4 needs Node 20+ and the Cloudflare
credentials. On push to `main` under `worker/**`, GitHub Actions runs
`.github/workflows/deploy-worker.yml` with `cloudflare/wrangler-action` and
`workingDirectory: worker`. That needs the repo secrets `CLOUDFLARE_API_TOKEN`
(Workers Scripts: Edit, Account Settings: Read) and `CLOUDFLARE_ACCOUNT_ID`.

After the first deploy, attach `auth.pydle.uk` to the Worker as a Custom Domain.
DNS is already on Cloudflare, so adding the custom domain creates the record.

## Security note

The Worker stores nothing, keeps no database or cookies, and holds no client
secret — the device flow does not need one. But it is not blind: it **sees the
token response in transit**, including the access and refresh tokens. It must
therefore **never log request or response bodies**, nor anything derived from
them. If you add a `console.log` or a debug header, do not add it there.

Owner steps that cannot be automated: tick **Enable Device Flow** on the GitHub
OAuth App (otherwise every request returns `device_flow_disabled`) and copy its
public client id into both `js/config.js` and `CLIENT_ID` above.
