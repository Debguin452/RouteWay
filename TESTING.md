# Test checklist

Run through this against a deployed instance before giving the dashboard to anyone else.

## Signup / login

- [ ] Sign up with a new email and a 9-character password → 400 `weak_password`.
- [ ] Sign up with an already-registered email → 409 `email_taken`.
- [ ] Sign up normally → 201-equivalent success, session cookie set, dashboard loads.
- [ ] Log in with the wrong password 11 times in under 15 minutes → the 11th attempt returns
      429 `rate_limited` with a `Retry-After` header, not a 401.
- [ ] Log in with the wrong password once → 401 `invalid_credentials`. Confirm the message is
      identical whether the email doesn't exist or the password is wrong — it shouldn't be
      possible to tell which.
- [ ] Log out, then call `/api/me` → 401 `not_authenticated`.
- [ ] Open the dashboard in a second browser profile while logged in on the first → each
      session is independent; logging out of one doesn't affect the other.

## CSRF

- [ ] From the browser console on the dashboard's own origin, call `fetch` against
      `/api/projects` with `POST` and no `x-csrf-token` header → 403 `csrf_mismatch`.
- [ ] Same call with the CSRF token from `/api/me` → succeeds.
- [ ] Confirm a plain `GET` (no CSRF header at all) still works — CSRF is only enforced on
      mutating methods.

## Routes and tokens

- [ ] Create a route with a non-`https` target URL → 400 `invalid_target_url`.
- [ ] Create a route, then create a second route in the same project with the same label →
      409 `label_taken`.
- [ ] Create more routes than `MAX_ROUTES_PER_PROJECT` (50) → 403 `route_limit` on the 51st.
- [ ] Issue tokens on one route past `MAX_ACTIVE_TOKENS_PER_ROUTE` (10) → 403 `token_limit` on
      the 11th, and confirm revoking one brings the count back under the limit.
- [ ] Revoke a token, then call its `/proxy/<token>` URL → 401 `token_revoked`.
- [ ] Pause a route, then call its token's proxy URL → 403 `route_paused`.
- [ ] Call `/proxy/` with a token that was never issued (type a random string) → 401
      `invalid_token`, not a 500.

## Proxy behavior

- [ ] Point a route at a target URL that returns 500 → the proxy passes that 500 straight
      through with the upstream's body, not a generic error.
- [ ] Point a route at a URL that doesn't resolve (typo the domain) → 502
      `upstream_unreachable`.
- [ ] Point a route at a URL that hangs (a test endpoint that sleeps 15s) → 504
      `upstream_timeout` at the 10-second mark, not 15.
- [ ] Send a request body over 5MB → 413 `payload_too_large`.
- [ ] Set `allowedOrigin` on a route, then call the proxy URL via `fetch` from a page hosted
      on a *different* origin, in a real browser → the browser blocks reading the response
      (no CORS headers). Confirm the same call from a plain `curl`/Postman still succeeds —
      this is expected, not a bug: origin checks only constrain browsers.
- [ ] Confirm the upstream's own `Set-Cookie` header never reaches the browser's dev tools
      Application → Cookies panel for your dashboard's domain.
- [ ] Hit one route's proxy URL more than `rate_limit_per_minute` times inside 60 seconds →
      the request over the limit gets 429 with a `Retry-After` that counts down correctly,
      and succeeds again once it hits zero.

## Encryption

- [ ] Inspect the `routes` table directly (`wrangler d1 execute ... --command "select
      encrypted_secret from routes"`) → the value is ciphertext, not the plaintext key you
      entered.
- [ ] Deploy with a *different* `MASTER_KEY` than the one secrets were encrypted with (e.g.
      in a staging environment restored from a backup) → calling that route's proxy URL
      returns 500 `internal_error`, not a wrong-but-successful decryption. This confirms a
      wrong key fails loudly instead of silently forwarding garbage.
