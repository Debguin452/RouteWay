# Routeway

A hosted service that lets any developer lock an API key behind a fixed URL and hand out a
public token instead. The token only ever reaches the one upstream URL it was created for —
it can't be redirected elsewhere.

Everything below runs on Cloudflare's free plan with no credit card: Workers, D1, KV, Durable
Objects and Pages are all card-free. R2 is deliberately not used anywhere in this project
because Cloudflare requires a card on file for it even though the tier itself is free.

## Architecture

- **Workers** — the API and the proxy handler.
- **D1** — users, projects, routes, tokens. Secrets are encrypted before they're written.
- **Durable Objects** — rate limiting and login/signup throttling. KV's free tier only allows
  1,000 writes/day account-wide, which a live proxy would blow through immediately, so all
  counters live in Durable Objects instead, which have no such cap.
- **KV** — sessions only. Login events are naturally far less frequent than proxied requests,
  so this stays comfortably under the 1,000 writes/day limit.
- **Pages** — the dashboard (static files in `dashboard/`).

## One-time setup

```bash
npm install -g wrangler
wrangler login

wrangler d1 create secure-proxy-db
# copy the returned database_id into wrangler.toml

wrangler kv namespace create SESSIONS
# copy the returned id into wrangler.toml

wrangler d1 execute secure-proxy-db --remote --file=./schema.sql

openssl rand -hex 32
wrangler secret put MASTER_KEY
# paste the hex string above when prompted
```

Set `DASHBOARD_ORIGIN` in `wrangler.toml` to wherever you deploy `dashboard/` (e.g.
`https://routeway.pages.dev`), and set `window.ROUTEWAY_API_BASE` in
`dashboard/config.js` to your Worker's URL. These two have to match each other or the
dashboard's login cookie and CORS will silently fail.

## Deploy

```bash
npm install
wrangler deploy
```

Deploy `dashboard/` as a Cloudflare Pages project (connect the repo, or
`wrangler pages deploy dashboard`).

## Request flow

1. A developer signs up, creates a project, and creates a route: a label, a fixed target
   URL, where to inject the secret (header or query parameter), the secret value itself, an
   optional browser origin to allow, and a rate limit.
2. Creating a route returns a token, shown exactly once.
3. Their client calls `https://your-worker.workers.dev/proxy/<token>` with whatever
   method/body/headers the upstream API expects. The Worker looks up the token, decrypts the
   secret, injects it, and forwards the request to the route's fixed target URL — nowhere
   else.
4. The response streams back with upstream `Set-Cookie` headers stripped, so the upstream
   service can't set cookies in the caller's browser through this proxy.

## Error handling already built in

**Proxy path** — invalid/unknown token (401), revoked token (401), paused route or project
(403), origin not in the route's allowlist (403), rate limit exceeded (429 with
`Retry-After`), request body over 5MB (413), upstream timeout after 10s (504), upstream
unreachable (502), secret decryption failure (500, logged server-side without the secret
value), misconfigured target URL (500).

**Auth** — invalid JSON body (400), bad email format (400), password under 10 characters
(400), duplicate signup email (409), wrong credentials (401, same message whether the email
or password was wrong, so you can't enumerate accounts), signup/login throttled per email
(429).

**Project/route/token management** — ownership checked on every call (a route or token that
exists but belongs to someone else returns 404, not 403, so you can't probe for other
people's IDs), invalid label/URL/injection config/rate limit (400 each with a specific
message), duplicate label within a project (409), per-plan caps on projects/routes/active
tokens per route (403) so one account can't silently exhaust D1's write quota.

**Session/CSRF** — every mutating request needs a CSRF header that matches the session; a
missing or stale session returns 401 rather than a stack trace.

## What's deliberately not included

Password reset, email verification, team members on a project, and billing/plan upgrades
aren't built — add them if you need them. The `allowedOrigin` field only guards browser-side
calls (it restricts CORS); it can't stop a server-to-server caller from using a token,
because a server can send any `Origin` header it likes or omit it. If you need to restrict
*who* can call a token server-to-server, that has to be a different mechanism (e.g. requiring
the caller to also know a shared secret) — origin checks are a browser-only protection.
