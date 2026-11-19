---
title: HTTP API overview
description: Authentication, CSRF, response envelopes, errors, and limits shared by the HTTP API.
sidebar:
  order: 1
---

All framework and scaffolded app endpoints are mounted under `/api`.

| Ownership | Reference | Installed with |
| --- | --- | --- |
| Framework | [Authentication](/toto-stack/http/auth/), [Account](/toto-stack/http/account/), [Users](/toto-stack/http/users/), [Health](/toto-stack/http/health/) | `toto-stack`; always mounted |
| App-owned template | [Notifications and status](/toto-stack/http/template/) | `create-toto-app`; editable routes passed to `createServer({routes})` |

Framework security behavior ships with the package. Template routes belong to the generated app: apps may change or remove them, in which case the paths below need not exist. Framework routes mount before app routes; do not reuse their paths.

Start with the conventions below before using an endpoint. Body schemas live in [validation.ts](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/libs/security/validation.ts); `createUserSchema` and `sendNotificationSchema` are also exported for app code.

## Conventions

**Envelope.** Every response except `GET /api/health` uses the [standard envelope](https://github.com/totoluto/toto-stack/blob/master/packages/stack/README.md#errors): `{status, message, data?, code?, details?}`. Every error carries a `code` (see [`ErrorCode`](https://github.com/totoluto/toto-stack/blob/master/packages/stack/README.md#errors)). Branch on `code`, not `message`.

**Authentication.** A request authenticates in one of two ways:
- **Session cookie:** `connect.sid` in development, `__Host-connect.sid` in production, or your `session.cookieName`.
- **API key:** send an `Authorization` header with the `Bearer` scheme followed by your API key. A request with a Bearer header is authenticated **only** by the key. Its cookies are ignored, and an invalid key gives 401 on protected endpoints; there is no fallback to the session. The public `/api/auth/me` instead returns the `login` state.

**CSRF.** `POST`, `PUT`, `PATCH` and `DELETE` requests under `/api` need an `X-CSRF-Token` header, unless they use Bearer authentication.
- Get the token from `GET /api/auth/csrf`.
- A missing or invalid token gives **403 `CSRF_INVALID`**.
- The CSRF check runs before authentication, so an unauthenticated POST without a token gets 403, not 401.

**Origin.** A request whose `Origin` header isn't in the allowlist gets **403 `ORIGIN_NOT_ALLOWED`** on every path. Requests without `Origin` (curl, server-to-server) pass. `OPTIONS` preflights answer 204.

**Bodies.**
- Use JSON (`Content-Type: application/json`), at most `http.bodyLimit` (default 10 KB).
- Larger bodies get **413 `PAYLOAD_TOO_LARGE`**, malformed JSON **400 `INVALID_JSON`**, and an unsupported encoding or charset **415 `UNSUPPORTED_MEDIA_TYPE`**. The messages are generic; the parser's detail is only logged.
- Schema-validated bodies are strict: unknown fields are rejected with **400 `VALIDATION_FAILED`**, and `details` is `[{path, message}]`.

**Auth failures** (endpoints marked *signed in* or *admin*):
- **401 `UNAUTHORIZED`** (`"Unauthorized access."`) when there is no valid session or API key.
- **403 `FORBIDDEN`** (`"Missing permissions"`) when the user lacks the role.

**Overload.** Endpoints that check a password (login, setup start, and the account and users endpoints with password confirmation) can answer **503 `OVERLOADED`** with `Retry-After: 1` when too many password hashes are already queued (`security.passwordHashing`). Retry after a moment.

**Rate limits.**
- Requests that pass origin/preflight handling, static files included, count against a global limit of **1000 requests per minute per client IP**. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers.
- The endpoints below list their additional limits.
- When a limit is exceeded, the response is **429 `RATE_LIMITED`** with a `Retry-After` header (seconds).
- The client IP is Express' `req.ip`, which honours `TRUST_PROXY`. IPv6 clients are grouped per /64, or per /56 for `POST /api/auth/login` and `POST /api/auth/setup/start`, so an attacker can't multiply the budget by rotating the /64s of one delegation.

Unknown `/api` paths answer 404 `NOT_FOUND` (`"API endpoint does not exist"`).

**Notation:**
- *public*: no authentication.
- *signed in*: any authenticated user.
- *admin*: `admin` or `owner`.
- *session only*: requests with a Bearer header are rejected with **400 `BEARER_NOT_ALLOWED`**, because these endpoints read or write session state.


## Your own routes

`BaseRoute` subclasses passed to `createServer({routes})` are mounted under `/api` after the framework routes. The same CSRF and authentication middleware applies; authentication and roles are selected per endpoint. See [BaseRoute](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/routes/BaseRoute.ts) and the [framework mounting code](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/routes/index.ts).

## Reference coverage

Endpoint entries use headings of the form `` ### `METHOD /api/path` ``. From the repository root, run `node packages/docs/scripts/check-http.mjs` to compare these pages with registered framework and template routes. From `packages/docs`, run `node scripts/check-http.mjs`. The checker follows the current literal route arrays, server mount prefixes, and `BaseRoute` path registrations. It rejects dynamic paths or route lists rather than guessing. It verifies explicit endpoint coverage, not implicit Express `HEAD` handling, middleware `OPTIONS` responses, response behavior, or prose.
