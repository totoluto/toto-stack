# HTTP API reference

These are the endpoints of a `toto-stack` app. All of them live under `/api`. They come from two places:

| Provided by | Endpoints | Where the code lives |
|---|---|---|
| **Framework** (`toto-stack`, always mounted) | [Auth](#auth-apiauth) (`/api/auth/*`), [Account](#account-apiaccount) (`/api/account/*`), [`GET /api/health`](#get-apihealth) | [`packages/stack/src/routes/api`](../packages/stack/src/routes/api); update with the package |
| **Template** (`create-toto-app`, app-owned and editable) | [Users](#users-apiusers) (`/api/users`), [Notifications](#notifications) (`/api/notifications/*`), [`GET /api/status`](#get-apistatus) | the app's `server/routes` ([template source](../packages/create-toto-app/template/server/routes)), registered with `createServer({routes})` |

The framework endpoints are the sign-in flow and the signed-in user's own credentials: their security guarantees (rate limits, re-authentication, session handling) are part of the package. The template endpoints are ordinary app routes built on the public API. This page documents them as the template ships them; an app may have changed or removed them. Without them, those paths answer 404.

The schemas are in [`validation.ts`](../packages/stack/src/libs/security/validation.ts) (`createUserSchema` and `sendNotificationSchema` are exported for the template's routes).

## Conventions

**Envelope.** Every response except `GET /api/health` uses the [standard envelope](../packages/stack/README.md#errors): `{status, message, data?, code?, details?}`. Every error carries a `code` (see [`ErrorCode`](../packages/stack/README.md#errors)). Branch on `code`, not `message`.

**Authentication.** A request authenticates in one of two ways:
- **Session cookie:** `connect.sid` in development, `__Host-connect.sid` in production, or your `session.cookieName`.
- **API key:** `Authorization: Bearer toto_…`. A request with a Bearer header is authenticated **only** by the key. Its cookies are ignored, and an invalid key gives 401; there is no fallback to the session.

**CSRF.** `POST`, `PUT`, `PATCH` and `DELETE` requests under `/api` need an `X-CSRF-Token` header, unless they use Bearer authentication.
- Get the token from `GET /api/auth/csrf`.
- A missing or invalid token gives **403 `CSRF_INVALID`**.
- The CSRF check runs before authentication, so an unauthenticated POST without a token gets 403, not 401.

**Origin.** A request whose `Origin` header isn't in the allowlist gets **403 `ORIGIN_NOT_ALLOWED`** on every path. Requests without `Origin` (curl, server-to-server) pass. `OPTIONS` preflights answer 204.

**Bodies.**
- JSON (`Content-Type: application/json`), at most `http.bodyLimit` (default 10 KB).
- Larger bodies get **413 `PAYLOAD_TOO_LARGE`**, malformed JSON **400 `INVALID_JSON`**, and an unsupported encoding or charset **415 `UNSUPPORTED_MEDIA_TYPE`**. The messages are generic; the parser's detail is only logged.
- Schemas are strict: unknown fields are rejected with **400 `VALIDATION_FAILED`**, and `details` is `[{path, message}]`.

**Auth failures** (endpoints marked *signed in* or *admin*):
- **401 `UNAUTHORIZED`** (`"Unauthorized access."`) when there is no valid session or API key.
- **403 `FORBIDDEN`** (`"Missing permissions"`) when the user lacks the role.

**Overload.** Endpoints that check a password (login, setup start, and the account endpoints with password confirmation) can answer **503 `OVERLOADED`** with `Retry-After: 1` when too many password hashes are already queued (`security.passwordHashing`). Retry after a moment.

**Rate limits.**
- Every request, static files included, counts against a global limit of **1000 requests per minute per client IP**. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers.
- The endpoints below list their additional limits.
- When a limit is exceeded, the response is **429 `RATE_LIMITED`** with a `Retry-After` header (seconds).
- The client IP is Express' `req.ip`, which honours `TRUST_PROXY`. IPv6 clients are grouped per /64, or per /56 for `POST /api/auth/login` and `POST /api/auth/setup/start`, so an attacker can't multiply the budget by rotating the /64s of one delegation.

Unknown `/api` paths answer 404 `NOT_FOUND` (`"API endpoint does not exist"`).

**Notation:**
- *public*: no authentication.
- *signed in*: any authenticated user.
- *admin*: `admin` or `owner`.
- *session only*: requests with a Bearer header are rejected with **400 `BEARER_NOT_ALLOWED`**, because these endpoints read or write session state.

## Auth state

`data` of the login, MFA, setup, logout and `/me` endpoints is a `UserStatusType`:

```json
{"user": {"id": 1, "username": "alice", "roles": ["owner"]}, "authState": "authenticated"}
```

| `authState` | Meaning | Next step |
|---|---|---|
| `setup` | No user exists yet | `POST /api/auth/setup/start` |
| `setup-verify` | Setup started; waiting for the TOTP code | `POST /api/auth/setup/verify` |
| `login` | Not signed in (also: wrong credentials) | `POST /api/auth/login` |
| `otp` | Password accepted; waiting for the TOTP code (also: wrong code) | `POST /api/auth/login/verify` |
| `authenticated` | Signed in; `user` is set | |

`user` is `null` in every state except `authenticated`.

## Auth (`/api/auth`)

*Framework.*

### `GET /api/auth/csrf`

*Public.* Rate limit: 120 per minute per IP.

Returns a CSRF token for the `X-CSRF-Token` header: `data: {token}`.
- **Anonymous visitors** get a stateless signed token. It is bound to an HttpOnly, SameSite=Strict nonce cookie (`__Host-connect.sid.csrf` in production) and is valid for 12 hours. Nothing is written to the database.
- **Signed-in sessions** get the session's own token.

Fetch a new token after every login, MFA completion, setup or logout, because the session changes. `apiFetch` and `UserProvider` do this automatically.

### `GET /api/auth/me`

*Public.* The caller's auth state.
- Before setup it answers `setup` (or `setup-verify` while a setup is in progress in this session).
- During an MFA login it answers `otp`.
- Otherwise it answers `authenticated` with the user (roles are read from the database) or `login`.
- With a Bearer header it reports only the key's user (`authenticated`) or `login`.

### `POST /api/auth/login`

*Public, session only.* Body:

| Field | Type |
|---|---|
| `username` | string, 1–64 characters (trimmed) |
| `password` | string, 1–256 characters |

Response 200 with an auth state:
- **`login`:** wrong username or password. The response is identical, and takes the same time, for unknown users.
- **`otp`:** the password is correct and MFA is enabled. The session gets a new id and holds the pending login for 10 minutes.
- **`authenticated`:** signed in. The session gets a new id, and the browser gets a **device cookie** (below).

A new login replaces any pending MFA login or setup of the session.

Rate limits, per 15 minutes:
- 20 attempts per IP (IPv6 per /56).
- 5 per account and IP.
- 100 per account from any IP. A browser with a valid device cookie for this account skips this ceiling and is limited to **10 per device** instead.

A correct password doesn't count: it refunds the IP and the account (or device) attempt and clears the account+IP counter.

**Device cookie.** After a complete sign-in (password plus MFA if enabled, or setup), the response sets `__Host-<cookieName>.device` (`connect.sid.device` in development).
- It is signed, HttpOnly and SameSite=Strict, and valid for 180 days. It names the account by a hash and holds a random device id.
- It grants no access. It only lets a user log in from a browser they used before, even while attackers elsewhere exhaust the account-wide ceiling.
- Only the most recently signed-in account per browser is remembered.

### `POST /api/auth/login/verify`

*Public, session only.* Body: `{token}` (6 digits).

| Response | When |
|---|---|
| 200 `authenticated` | Code correct. The session gets a new id, and the browser gets the device cookie. |
| 200 `otp` | Wrong, expired or already used code; try again. |
| 200 `login` | The account was deleted, no longer has MFA, or **its password changed** since the password step; the pending login is discarded. |
| 401 `MFA_NOT_PENDING` | No live pending login (expired after 10 minutes, or never started). Log in again. |

Rate limits, per 10 minutes:
- 20 per IP.
- 5 per account and IP.
- 10 per account.

### `POST /api/auth/logout`

*Public, session only.* Body: none or `{}`.

Always answers 200 `login`. It ends the session, a pending MFA login, or a setup in progress, and clears the cookie. Anonymous calls cause no database write.

### `POST /api/auth/setup/start`

*Public, session only.* First-run setup of the owner account. Body:

| Field | Type |
|---|---|
| `username` | string, 1–64 characters (trimmed) |
| `password` | string, 10–256 characters |
| `setupToken` | string, 1–512 characters: `SETUP_TOKEN`, or the token from the server log |

| Response | When |
|---|---|
| 200 `data: {authState: "setup-verify", qrCode, key}` | Token accepted. `qrCode` is a PNG data URL of the `otpauth://` URI; `key` is the base32 secret for manual entry. The pending setup lives in a new session for 10 minutes. |
| 403 `SETUP_COMPLETED` | An owner already exists. |
| 403 `SETUP_TOKEN_INVALID` | Wrong token. |

Rate limit: 5 attempts per IP (IPv6 per /56) per 15 minutes. An accepted token refunds its attempt.

### `POST /api/auth/setup/verify`

*Public, session only.* Body: `{token}` (6 digits from the authenticator app).

| Response | When |
|---|---|
| 200 `authenticated` | Code correct. The owner is created with MFA enabled and signed in on a new session, and the browser gets the device cookie. |
| 200 `setup-verify` | Wrong code; try again. |
| 400 `SETUP_NOT_STARTED` | No live setup in this session (expired after 10 minutes, or never started). |
| 403 `SETUP_COMPLETED` | Another setup won the race, or an owner already exists. |
| 403 `SETUP_TOKEN_CHANGED` | The active setup token changed since `/setup/start`, for example a restart with a generated token. Start again. |

Rate limit: 5 attempts per IP per 10 minutes. The owner is created atomically, so concurrent setups yield exactly one owner.

## Account (`/api/account`)

*Framework. Signed in.* The endpoints act on the caller's own account.

**Password confirmation.** Endpoints that take `password` or `currentPassword` check it first:
- A wrong password gives **403 `PASSWORD_CONFIRMATION_FAILED`**.
- Every attempt counts against 10 per account and 30 per IP per 15 minutes, successful or not, because each check costs a full password hash.

### `POST /api/account/password`

Body: `{currentPassword, newPassword}`. `newPassword` is 10–256 characters.

200 `"Password updated"`. It also **revokes the user's API key** and signs out the user's **other sessions**.

### `POST /api/account/api-key`

Body: `{password}`. Issues a new API key, replacing any previous one.

200 `data: {apiKey}`. The key is `toto_` followed by 43 base64url characters. It is shown **only in this response**; only its SHA-256 hash is stored.

### `DELETE /api/account/api-key`

No body. 200 `"API key revoked"`.

### `POST /api/account/mfa/start`

*Session only.* Body: `{password}`.

| Response | When |
|---|---|
| 200 `data: {qrCode, key}` | Enrollment started; it lives in the session for 10 minutes. |
| 409 `MFA_ALREADY_ENABLED` | |

### `POST /api/account/mfa/verify`

*Session only.* Body: `{token}`.

| Response | When |
|---|---|
| 200 `"MFA enabled"` | MFA is on. The user's other sessions are signed out. |
| 400 `MFA_ENROLLMENT_NOT_STARTED` | No live enrollment. |
| 400 `MFA_INVALID` | Wrong code. |
| 409 `MFA_ALREADY_ENABLED` | |

Rate limits: the MFA limits of `/auth/login/verify`.

### `POST /api/account/mfa/disable`

Body: `{password, token}`, the password plus a current TOTP code.

| Response | When |
|---|---|
| 200 `"MFA disabled"` | MFA is off. The user's other sessions are signed out. |
| 400 `MFA_INVALID` | Wrong or reused code. |
| 409 `MFA_NOT_ENABLED` | |

Rate limits: password confirmation, then the MFA limits.

## Users (`/api/users`)

*Template (`server/routes/UsersRoute.ts`). Admin.* The rules below are the template's; keep them if you change the route. Creating a user also follows the stack's password policy (`createUserSchema`), and `userService.createUser` turns a taken username into a 409.

### `GET /api/users`

200 `data: {users: [{id, username, otpEnabled, createdAt, roles}]}`.

### `POST /api/users`

Body:

| Field | Type |
|---|---|
| `username` | string, 1–64 characters (trimmed) |
| `password` | string, 10–256 characters |
| `roles` | optional array of configured role names (built-in plus `roles` from the config); default `[]` |

| Response | When |
|---|---|
| 201 `data: {user: {id, username, roles}}` | Created, without MFA and without an API key. Users issue their own key. |
| 400 `VALIDATION_FAILED` | Invalid body or an unknown role. |
| 403 `ROLE_NOT_GRANTABLE` | Only an owner may grant `owner` or `admin`. |
| 409 `USERNAME_TAKEN` | Also returned for a concurrent duplicate. |

### `DELETE /api/users/:id`

| Response | When |
|---|---|
| 200 `"User deleted"` | The user's sessions are deleted with them. |
| 400 `INVALID_USER_ID` | |
| 400 `CANNOT_DELETE_SELF` | |
| 403 `USER_PROTECTED` | The target is an owner, or holds a role the caller may not grant (an admin deleting an admin). |
| 404 `USER_NOT_FOUND` | Also when the user was deleted concurrently. |

## Notifications

*Template (`server/routes/NotificationRoute.ts`). Admin.* Mounted whether or not handlers are configured; without handlers, `send` answers 503 `NO_HANDLERS`. Configure handlers with `createServer({notifications: {handlers}})`.

### `GET /api/notifications/handlers`

200 `data: {handlers: ["ops", "email", …]}`.

### `POST /api/notifications/send`

Body (strict):

| Field | Type |
|---|---|
| `title` | string, 1–200 characters (trimmed) |
| `message` | string, 1–2000 characters (trimmed) |
| `handlers` | optional array of handler ids (at most 50); default: all handlers |
| `metadata` | optional object with at most 25 keys (1–64 characters each). Values are strings (at most 1024 characters), numbers or booleans. `color: "#rrggbb"` sets the Discord/Slack accent colour. |

| Response | When |
|---|---|
| 200 `data: {delivered, failed, results: [{handler, ok}]}` | At least one handler delivered. The message says how many when some failed. |
| 400 `UNKNOWN_HANDLER`, `details: {unknown: [...]}` | An id in `handlers` isn't registered. |
| 502 `DELIVERY_FAILED`, `details: {results}` | Every handler failed. |
| 503 `NO_HANDLERS` | No handler is configured. |

Handlers run in parallel, each with its own timeout (5 s by default). Remote error text is logged server-side and never returned.

## Status

### `GET /api/status`

*Template (`server/routes/StatusRoute.ts`). Public.* Liveness. 200 `"Server is up and running"`. Doesn't touch the database; a request without a session cookie also costs no session lookup.

### `GET /api/health`

*Framework. Public.* Readiness, including the database, which it checks with `SELECT 1`. It is mounted before the session middleware, so it never touches the session table; the template's Docker `HEALTHCHECK` uses it. It returns a **plain object, not the envelope**:

```json
{"status": "ok", "uptimeSeconds": 1234, "db": "ok"}
```

If the database is unreachable it returns 503 with `{"status": "degraded", "uptimeSeconds": 1234, "db": "down"}`.

## Your own routes

`BaseRoute` subclasses passed in `createServer({routes})` (in a scaffolded app: `server/routes`) are mounted under `/api` after the framework routes and follow the same rules: CSRF, the envelope, auth and roles per endpoint. See [Routes](../packages/stack/README.md#routes) and [Routes in a scaffolded app](../packages/stack/README.md#routes-in-a-scaffolded-app).
