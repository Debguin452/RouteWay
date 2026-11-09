# Dashboard API reference

All endpoints require a session (cookie or `Authorization: Bearer <sessionToken>`) and, for non-GET requests, the `x-csrf-token` header, except signup, login and logout.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/signup`, `/api/login`, `/api/logout` | Account session. Signup and login return `csrf` and `sessionToken`. |
| GET | `/api/me` | Current user and CSRF token. |
| GET, POST | `/api/projects` | List or create projects. |
| PATCH | `/api/projects/:id` | `{ name?, paused? }`. A paused project blocks all its tokens. |
| DELETE | `/api/projects/:id` | Deletes the project, its routes and tokens. |
| GET | `/api/projects/:id/routes` | Routes with `stats: { total, lastUsedAt }`. |
| POST | `/api/projects/:id/routes` | Create a route and its first token. |
| PATCH | `/api/routes/:id` | Update settings (below). |
| POST | `/api/routes/:id/secret` | `{ secret }`. Rotates the stored secret. |
| POST | `/api/routes/:id/pause` | `{ paused }`. |
| DELETE | `/api/routes/:id` | Deletes the route and its tokens. |
| GET, POST | `/api/routes/:id/tokens` | List or issue. Issue body: `{ expiresInDays?, label? }`. |
| POST | `/api/tokens/:id/revoke` | Revoke a token. |
| GET | `/api/debug` | Plain-text health check of every dependency. |

## Creating a route

```json
{
  "label": "openai",
  "targetUrl": "https://api.openai.com/v1",
  "injectAs": "header",
  "injectKey": "Authorization",
  "secret": "Bearer sk-...",
  "allowedOrigin": "https://myapp.com, https://staging.myapp.com",
  "allowedMethods": "GET, POST",
  "allowedPaths": "/chat/completions, /models/*",
  "allowedIps": "203.0.113.0/24",
  "extraHeaders": "anthropic-version: 2023-06-01",
  "rateLimitPerMinute": 60,
  "timeoutSeconds": 60,
  "retries": 1
}
```

Only `label`, `targetUrl`, `injectAs`, `injectKey` and `secret` are required. Label, target URL and injection method cannot be changed later. Create a new route instead. Every other field can be changed with `PATCH /api/routes/:id`, and an empty string clears an optional setting.

## Calling a route

```
https://<worker>/proxy/<token>/<path>?<query>
```

Error codes returned by the proxy: `invalid_token`, `token_revoked`, `token_expired`, `project_paused`, `route_paused`, `origin_not_allowed`, `method_not_allowed`, `path_not_allowed`, `ip_not_allowed`, `invalid_path`, `rate_limited`, `payload_too_large`, `upstream_timeout`, `upstream_unreachable`, `internal_error`.
