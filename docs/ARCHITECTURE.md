# Architecture and design notes

This file holds the reasoning behind the code, so the source stays free of explanatory comments.

## Request flow

1. `src/index.ts` is the outermost layer. It decides the dashboard CORS headers first, answers `OPTIONS` preflight immediately, runs the router inside a `try/catch`, and attaches the CORS headers to whatever comes back (success, error, 404, crash, debug page).
2. `/proxy/<token>/...` is handled by `src/proxy.ts`. Everything else under `/api/` is the dashboard API, which needs a session.
3. Proxy responses do not get the dashboard CORS headers. They carry per-route CORS based on the route's allowed origins.

## Why CORS headers are attached to every response

A cross-origin response with no CORS headers is hidden from the browser's JavaScript and shows up as a generic network error, which looks identical to "server unreachable". Before the fix, any thrown error escaped the handler without CORS headers, so real server-side failures were invisible. The wrapper in `index.ts` guarantees headers are present no matter what happens, and `/api/debug` reports which dependency is broken in plain text.

Preflight is answered before any D1, KV or Durable Object access so a broken binding can never block the preflight itself.

`corsHeaders` reflects `Access-Control-Request-Headers`, so custom headers such as the CSRF header or `Authorization` never break preflight. Origins are compared after stripping trailing slashes.

## Password hashing

Workers rejects PBKDF2 with more than 100,000 iterations (`NotSupportedError`). `wrangler dev` does not enforce this, so a higher value works locally and fails only when deployed. Routeway uses exactly 100,000. The iteration count is stored inside each hash (`pbkdf2-sha256$<iterations>$<hex>`), so it can be raised or lowered later without invalidating existing passwords. `PBKDF2_ITERATIONS` in `[vars]` lowers it for new hashes if the free plan's 10 ms CPU limit is exceeded.

## Sessions: cookie and bearer token

The dashboard (`pages.dev`) and API (`workers.dev`) are different sites. Both are on the Public Suffix List, so browsers treat the session cookie as third-party. Safari and Chrome Incognito block those cookies. The Worker therefore accepts the session ID either from the cookie or as `Authorization: Bearer <id>`. The login response includes `sessionToken`, which the dashboard keeps in `sessionStorage` (cleared when the tab closes). The cookie is `HttpOnly; Secure; SameSite=None`. CSRF protection still applies to mutating requests.

The cleanest production setup is one parent domain for both (for example `app.example.com` and `api.example.com`), which makes the cookie first-party.

## Proxy path forwarding

A route's target URL is a base. Everything after `/proxy/<token>` is appended to it by `src/target.ts`:

- The upstream origin can never change. The path is set with the URL `pathname` setter rather than resolved as a relative URL, so inputs like `//evil.com` or `/@evil.com` cannot switch hosts.
- Dot segments, backslashes, encoded dots/slashes/backslashes and control characters are rejected (`invalid_path`). The runtime also collapses `/../` before the handler runs, so those requests never reach the upstream.
- The final path must still start with the base path on a segment boundary.
- The caller's query string is forwarded. Query parameters already in the base URL override the caller's, and the injected secret overrides both.

## What is and is not forwarded upstream

Dropped from the request: hop-by-hop headers, `host`, `authorization`, `cookie`, `origin`, `cf-*`, `x-forwarded-*`, `x-real-ip`. The caller's own credentials and network identity never reach the upstream. The route's extra headers are applied next, then the secret, so the secret always wins.

Dropped from the response: `set-cookie`, any `access-control-*` header from the upstream (so an upstream cannot widen the route's CORS policy), and `content-encoding` / `content-length` / `transfer-encoding` (the runtime has already decoded the body).

Redirects are not followed (`redirect: "manual"`). Following one would resend custom secret headers to whatever host the upstream redirected to. The caller receives the 3xx and decides.

## Timeouts, retries, streaming

The per-route timeout (1 to 120 s, default 30) is the budget for receiving response headers, across all attempts. Once headers arrive, the body streams straight through with no further time limit, so server-sent events and long generations work. Retries (0 to 2, exponential backoff from 250 ms) apply only to `GET` and `HEAD` on network errors and 502/503/504, because other methods are not safe to repeat.

Request bodies: with a `Content-Length` of at most 5 MB the body streams straight through. Without a `Content-Length` (chunked), the body is buffered up to 5 MB first so an oversize upload is rejected with 413 before the upstream sees any of it. Earlier streaming-with-a-counter approaches let a truncated body reach the upstream.

## Access controls per route

Evaluated in this order after the token, revocation, expiry and pause checks: allowed origins, allowed methods, allowed paths, allowed caller IPs, then the rate limit.

- **Origins** only restrict browsers, because non-browser callers can omit or forge `Origin`. For server-side callers use IP allowlists.
- **IP allowlist** uses `cf-connecting-ip`, which Cloudflare sets itself at the edge. IPv4 supports CIDR; IPv6 is exact match.
- **Paths** are exact or end in `*` for a prefix. `/models/*` also matches `/models`.
- **Extra headers** are stored as plain JSON in D1, not encrypted. Secrets belong in the secret field.

## Tokens

Only the SHA-256 of a token is stored. Tokens can expire (1 to 365 days) and carry a label. Revocation is immediate. Expired tokens return `token_expired`.

## Usage stats

The per-route Durable Object that enforces the rate limit also records a total request count and last-used time in the same storage write, so stats cost no extra write. The route list reads them. Requests rejected before the rate-limit stage are not counted.

## Observability

Each proxied request gets an `x-request-id` (also on error responses) and one structured log line with request ID, route ID, method, status and duration. Secrets and bodies are never logged. Rate-limit state is exposed through `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `Retry-After`, and the CORS policy exposes them to browsers.

## Debug endpoint

`/api/debug` tests config, D1 connectivity, D1 schema (tables and required columns), KV, the Durable Object, secret encryption and password hashing, each separately, and prints plain text. It never prints secret values. Set the `DEBUG_TOKEN` secret to require `?key=<value>`.

## Limits

Per user: 20 projects. Per project: 50 routes. Per route: 10 active tokens, 6000 requests per minute, 120 s timeout, 5 origins, 20 paths, 10 IPs, 10 extra headers. Request bodies: 5 MB.

## Known trade-offs

- The Workers free plan allows about 10 ms of CPU per request. PBKDF2 at 100,000 iterations may exceed this on signup and login. Lower `PBKDF2_ITERATIONS` if it does.
- A token embedded in public browser code can be copied. Origin checks, the rate limit, expiry, path and method limits, and revocation bound the damage.
- Firestore and other streaming-socket protocols do not fit this model. Plain HTTP APIs do.
