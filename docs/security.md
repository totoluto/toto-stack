# Security model

This page describes what `toto-stack` protects against, which assumptions it relies on, and where its limits are. It reflects the code in [`packages/stack/src`](../packages/stack/src); if the two disagree, the code wins, so please report the discrepancy.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Contents

- [Threat model](#threat-model)
- [Production mode (`NODE_ENV`)](#production-mode-node_env)
- [TLS, reverse proxy and `TRUST_PROXY`](#tls-reverse-proxy-and-trust_proxy)
- [Origins and security headers](#origins-and-security-headers)
- [First-run setup](#first-run-setup)
- [Sessions](#sessions)
- [CSRF](#csrf)
- [API keys](#api-keys)
- [Passwords](#passwords)
- [TOTP (MFA)](#totp-mfa)
- [Authorization](#authorization)
- [Rate limits](#rate-limits)
- [Running several instances](#running-several-instances)
- [Logging and errors](#logging-and-errors)
- [Cryptography](#cryptography)
- [Known limitations and deferred items](#known-limitations-and-deferred-items)

## Threat model

**Trusted:**
- The host and container runtime.
- The database server.
- The process environment: `SESSION_SECRET`, `OTP_ENCRYPTION_KEY`, `SETUP_TOKEN`, database credentials.
- The reverse proxy you operate in front of the app.
- The app's own code: routes, services and hooks run with full privileges.

**Untrusted:**
- Everything that arrives over the network: browsers, scripts, other origins, forwarded headers from proxies you don't run.
- Users. Each is limited to their roles; admins are partially trusted (see [Authorization](#authorization)).

**What the stack defends against:**
- Credential guessing (rate limits, slow password hashing).
- Username enumeration by timing.
- TOTP replay.
- Session fixation, theft and replay beyond their lifetime.
- CSRF, clickjacking and cross-origin credentialed requests.
- Privilege escalation between `admin` and `owner`.
- A takeover race during first-run setup.
- Leaking secrets in logs and error responses.
- Exposure of TOTP secrets in database dumps (optional).

**Out of scope:**
- A compromised host, environment or database server.
- Malicious app code.
- XSS in the app's own frontend. The CSP limits it, but the frontend must not render untrusted HTML.
- Denial of service beyond the per-IP flood guard; use your proxy or CDN.
- Phishing.
- Lost authenticators (there are no recovery codes yet; see [limitations](#known-limitations-and-deferred-items)).

The stack is designed for a single application with a modest number of users and a few privileged accounts. It is not a general identity provider.

## Production mode (`NODE_ENV`)

Development mode is **opt-in**: only `NODE_ENV=development` or `NODE_ENV=test` enables it. Any other value, **including an unset `NODE_ENV`**, is production mode, so a forgotten variable can't silently weaken a deployment.

| | Production | Development |
|---|---|---|
| `SESSION_SECRET` | Required: at least 32 characters, varied, not a recognisable placeholder (see the secret checks below) | Optional (random per process if unset); weak values warn |
| `SETUP_TOKEN`, `OTP_ENCRYPTION_KEY` | If set: validated (length, variety, no placeholders); weak values are errors | Same: weak values are errors in every mode |
| `ALLOWED_ORIGINS` | Required; https only | Optional; `http://localhost:3000/3001` and `http://127.0.0.1:3000/3001` always allowed |
| Cookies | `Secure`; session cookie `__Host-<name>`; CSRF nonce cookie `__Host-<name>.csrf` | Not `Secure`, no prefix (plain HTTP on localhost) |
| CSP | Includes `upgrade-insecure-requests` | Without it |
| 5xx responses | Generic status text | Real error message |
| Logs | JSON, level `info` | Readable, level `debug` |

Configuration problems are collected and thrown together as one `ConfigError` before the server listens.

**Secret checks.** The checks on configured secrets catch placeholders and obviously non-random values; they are not an entropy estimate, and values from `openssl rand` or `crypto.randomBytes` pass.
The rules are tuned so that generated values never trip them, and they apply independently:
- **Long markers** match anywhere in the value, but only as a person would write them: `replace`, `example`, `placeholder`, `change me` and `not secure`, with the words joined by nothing, `-`, `_` or a space.
  - Each word must be lower case, UPPER case or Capitalized, and not glued into a longer run of letters in the same case.
  - `change-me-…`, `CHANGE_ME` and `pleaseReplaceThis` are rejected; a random-case `rEpLaCe` is not.
- **Short markers** (`secret`, `todo`, `your` and runs of 3 or more `x`) count only when the **whole value** is words or numbers separated by `-`, `_`, `.` or spaces, as in `my-secret-value-1234` or `TODO_SET_ME`.
- **Length:** at least 32 characters for `SESSION_SECRET`, 16 for `SETUP_TOKEN`.
- **Variety:** at least min(10, ⌈length / 4⌉) distinct characters, so 8 for a 32-character value. The decoded `OTP_ENCRYPTION_KEY` must be 32 bytes with at least 16 distinct byte values.

**Trade-off:** the marker check is deliberately narrow, so that random values never fail it. A hand-made value without separators, such as `SuperSecretSessionKey2024`, passes the marker check (and length and variety). Generate secrets; don't type them.

## TLS, reverse proxy and `TRUST_PROXY`

The app speaks plain HTTP. **Production requires HTTPS terminated by a reverse proxy** (Traefik, nginx, a cloud load balancer), and the app port must be reachable only by that proxy. The scaffolded deployment does this with Traefik and Let's Encrypt; see [Deployment](deployment.md).

`TRUST_PROXY` (`http.trustProxy`) sets Express' `trust proxy`. It decides whether `X-Forwarded-For` and `X-Forwarded-Proto` are believed, which affects:
- `req.ip`, which rate limits and session metadata use;
- `req.secure`. express-session refuses to send a `Secure` cookie over a connection it considers insecure, so a wrong setting behind a TLS proxy means **logins never stick**. In production the stack detects the typical case: the first time a request carries `X-Forwarded-Proto: https` while `req.secure` is false, it logs a one-time warning telling you to set `TRUST_PROXY`.

| Deployment | Setting |
|---|---|
| Clients connect to Node directly (not recommended in production) | unset / `false` (default) |
| One proxy in front (the template's Traefik) | `1` |
| CDN → load balancer → app | the number of hops you operate, e.g. `2` |
| Fixed proxy addresses | comma-separated addresses or subnets, e.g. `10.0.0.0/8` |

Never use `true` in production (the stack logs a warning). With `true`, every hop in `X-Forwarded-For` is trusted, so any client can choose its own IP and get around the per-IP rate limits. Rate-limit keys are additionally validated as IP addresses (an invalid forwarded value falls back to the socket address), and IPv6 clients are grouped per /64 (per /56 for login and setup start).

## Origins and security headers

**Origin allowlist.**
- Each request's `Origin` header must exactly match an allowed origin: scheme, host and port, no path.
- `null` and unlisted origins get 403 `ORIGIN_NOT_ALLOWED`.
- Browsers also send `Origin` on same-origin POSTs, so **the app's own public origin must be in `ALLOWED_ORIGINS`**.
- Allowed origins get `Access-Control-Allow-Credentials: true`.
- Requests without `Origin` (non-browser clients) are not affected; CSRF and authentication still apply.

**Headers** (helmet):
- A strict Content-Security-Policy: `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`.
- `X-Frame-Options: DENY`.
- `Referrer-Policy: same-origin`.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- `X-Content-Type-Options: nosniff`.
- `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`.

Adjust the CSP with `security.csp`; see [Configuration](configuration.md#content-security-policy).

**Request bodies** are limited to 10 KB by default. Every built-in endpoint, and every route of the template, validates its body with a strict zod schema.

## First-run setup

A fresh database has no users, and the first account created becomes the **owner**. Without protection, whoever reaches the setup form first owns the app, so setup requires a **setup token**.

**Where the token comes from:**
- `SETUP_TOKEN` (`security.setupToken`): at least 16 characters, varied, no placeholders, enforced in every mode. Recommended; `create-toto-app` generates one into `.env`.
- Otherwise, if no user exists at boot, the server generates a random token and prints it **once, directly to stderr**, regardless of `LOG_LEVEL` or the log transport. The logger only receives a notice without the token, so the token doesn't end up in log pipelines. It stays valid until setup completes or the process restarts, and it is useless once an owner exists.

**Flow:**
1. `GET /api/auth/me` reports `setup`. This is public, so the SPA can show the setup form; the token is what protects the step.
2. `POST /api/auth/setup/start {username, password, setupToken}`.
   - The token is compared in constant time (SHA-256 digests with `timingSafeEqual`), with 5 attempts per IP per 15 minutes.
   - The normal password policy applies (10–256 characters).
   - The response is a TOTP enrollment (QR code and secret). The pending setup lives in a regenerated session for at most 10 minutes; the password is stored there only as its Argon2id hash.
   - The session also stores a fingerprint of the active token. If the token changes (a restart with a generated token, or a new `SETUP_TOKEN`), the pending setup is rejected with `SETUP_TOKEN_CHANGED`.
3. `POST /api/auth/setup/verify {token}` with the TOTP code.
   - The owner is created **atomically**: one transaction checks that no user exists, creates the owner and inserts a singleton `SetupLock` row with a fixed primary key.
   - A concurrent setup, on this instance or another, fails and rolls back, gets 403 `SETUP_COMPLETED`, and exactly one owner results. The losing transaction fails on the lock key, the username, or the database's write-conflict check; the stack then confirms in the database that an owner exists, and treats any other failure as a real error.
   - The owner always has MFA enabled, and the session is regenerated.

Each instance keeps "setup complete" as a cache. Until it is true, every check asks the database, so another instance completing setup is noticed.

**With several instances, set `SETUP_TOKEN`.** Otherwise each instance generates and prints its own token.

## Sessions

**Storage.** Sessions are stored server-side in the `Session` table, through express-session and the stack's Prisma store. The cookie holds only the signed session id.

**Cookie.**

| Attribute | Value |
|---|---|
| Name | `__Host-connect.sid` in production, `connect.sid` in development (base name: `session.cookieName`) |
| `HttpOnly` | yes |
| `Secure` | in production |
| `SameSite` | `Lax` |
| `Path` | `/`, no `Domain` (required by the `__Host-` prefix: no other subdomain or plain-HTTP response can set or overwrite it) |
| `Max-Age` | `session.absoluteTimeout` (default 7 days) |

The stack sets two more cookies, both HttpOnly, `__Host-` prefixed in production, with the same base name: the anonymous CSRF nonce (`<name>.csrf`, see [CSRF](#csrf)) and the login device cookie (`<name>.device`, see [Rate limits](#rate-limits)).

**Session id regeneration.** The session id is regenerated, with the old row deleted:
- at password login;
- when a pending MFA login starts and when it completes;
- at setup start and completion.

This prevents session fixation. Login, MFA completion and setup completion also record the sign-in time (`authenticatedAt`).

**Timeouts, enforced server-side:**
- **Absolute** (`session.absoluteTimeout`, 7 days): counted from sign-in and never extended. The database expiry never passes it, and a re-sent cookie is clamped to it.
- **Idle** (`session.idleTimeout`, 24 hours): a session without requests ends.
  - Activity is recorded at most every `session.touchInterval` (5 minutes), so a session can idle out up to that much **early, never late**.
  - Lowering a limit applies to existing sessions.
- **Pending state:** a pending MFA login, a setup in progress, or an MFA enrollment expires after 10 minutes.

**Revocation.**
- Logout destroys the session and clears the cookie.
- A password change, enabling MFA and disabling MFA delete all of the user's other sessions.
- A **pending MFA login** started with the old password is invalidated by a password change: `/login/verify` then answers `login`. The pending state stores an HMAC fingerprint of the password hash it was verified against.
- Deleting a user deletes their sessions (cascade).
- A revoked session is never recreated by a request that was still in flight: rows loaded from the database are only ever updated, never re-inserted.

**Cost.** An authenticated API request costs one database read (the session row joined with the user and role names) and no writes within the touch interval. Anonymous requests, static files and health checks cost no session queries. The session middleware runs only under `/api`.

## CSRF

State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api` need an `X-CSRF-Token` header. There are two token types.

**Session-bound token (signed-in users).**
- 32 random bytes stored in the session, compared in constant time.
- Fetched from `GET /api/auth/csrf`.
- It changes with the session, so clients refetch after login, MFA, setup and logout.

**Signed anonymous token (login, MFA and setup forms).**
- Issuing a session-bound token to every anonymous visitor would create a database row per visit. Anonymous visitors instead get a stateless token: `a.<expiry>.<HMAC-SHA256(key, expiry.nonce)>`.
- The key is derived from `SESSION_SECRET`.
- The nonce is 32 random bytes in an HttpOnly, SameSite=Strict cookie (`__Host-<cookieName>.csrf` in production), so the token is bound to that browser.
- It is valid for 12 hours, and **only while the session is not signed in**.
- `GET /api/auth/csrf` writes nothing to the database and is limited to 120 requests per minute per IP.

**Bearer requests skip CSRF.**
- A request with `Authorization: Bearer <key>` is authenticated **only** by that key: its cookies are ignored, and a malformed or unknown key is a 401 with no fallback to the session. Browsers never attach a Bearer header on their own, so a cross-site request can't carry one.
- Other `Authorization` schemes, such as Basic credentials a browser caches for a protecting proxy, do **not** skip CSRF.
- Endpoints that read or write session state (login, MFA, setup, logout, MFA enrollment) refuse Bearer requests with `BEARER_NOT_ALLOWED`.

**Defence in depth:** the `SameSite=Lax` session cookie and the origin allowlist.

**Your routes.** The CSRF middleware covers everything under `/api`. It does not cover routes you mount in `hooks.configureApp`, which run before the session and CSRF middleware and must protect themselves (for example signed webhooks).

## API keys

- **Issued by the user, not by admins.** A signed-in user issues a key with `POST /api/account/api-key`, confirming their password. Users created by an admin have no key, and the admin never sees one.
- **Format.** `toto_` + 32 random bytes in base64url (43 characters). The prefix lets secret scanners recognise leaked keys.
- **Storage.** Only the SHA-256 hash is stored, under a unique index. The plaintext appears once, in the issuing response.
- **Lookup.** Lookup by hash is fast and needs no slow KDF, because the key has 256 bits of entropy. Malformed keys are rejected before any database query.
- **One key per user.** Issuing a new key replaces the old one. `DELETE /api/account/api-key` revokes it. A **password change revokes it** too, as does deleting the user.
- **Scope.** A key acts as its user, with the user's current roles. There are no scopes or expiry dates, and a key does not require MFA.
- **Bearer-only.** Key-authenticated requests can't use session endpoints.

## Passwords

- **Hashing.** Argon2id via [`@node-rs/argon2`](https://www.npmjs.com/package/@node-rs/argon2), the RustCrypto implementation, with the OWASP baseline parameters: **m = 19 MiB (19456 KiB), t = 2, p = 1**.
  - Hashes are standard PHC strings: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
  - Passwords are NFC-normalised, and there is no 72-byte limit.
  - The parameters are configurable (`security.passwordHashing.{memoryCost,timeCost,parallelism}`). A hash with other parameters is rehashed at the user's next successful login, so raising them upgrades accounts gradually. A `memoryCost` below the baseline logs a production warning.
- **Only Argon2id.** A stored value that isn't an `$argon2id$` hash is treated as invalid credentials: no work is done and the login simply fails.
- **Stored-hash caps.** Argon2id hashes with t > 16, p > 16, or memory above 256 MiB (or above the configured `memoryCost`, if that is higher) are rejected without being computed, so a tampered row can't demand gigabytes or minutes.
- **Event loop and load shedding.** Hashing runs on the libuv threadpool, so it never blocks the event loop.
  - At most `security.passwordHashing.concurrency` hashes run at a time (default **2**, so fs and dns keep the rest of the default 4-thread pool). Each uses `memoryCost` (19 MiB), so peak hashing memory ≈ `concurrency × memoryCost`.
  - At most `queueLimit` wait (default **32**). Further password checks fail fast with **503 `OVERLOADED`** and `Retry-After: 1`, with a warning logged at most once a minute.
  - So a flood of logins can neither block the event loop nor make every login wait for seconds.
- **Policy.** New passwords are 10–256 characters. There is no complexity rule and no breached-password check.
- **Timing.** Unknown usernames are checked against a random dummy hash, so login takes the same time and returns the same response whether or not the user exists.
- **Re-confirmation.** Sensitive account changes require the current password and are rate-limited (see below).

## TOTP (MFA)

- **Implementation.** [otplib](https://github.com/yeojz/otplib) v13 (`@otplib/totp`), with HMAC from `node:crypto` and RFC 4648 base32 from `@scure/base`. These are the RFC 6238 defaults authenticator apps implement: HMAC-SHA1, 6 digits, 30-second steps. Secrets are 160 bits. The setup is tested against the RFC test vectors.
- **Drift.** Codes from **±1 step** are accepted.
- **Replay protection.** The accepted step is stored per user (`otpLastUsedStep`) with a conditional update. A code, or an older one, can't be used twice, even by two concurrent requests or on two instances.
- **Enrollment.** The QR code carries an `otpauth://` URI with the issuer (`TOTP_ISSUER`, default: the host of the first allowed origin).
- **Changes.** Enabling MFA requires the password and a valid code. Disabling it requires both again. Either change signs out the user's other sessions.
- **Who has MFA.** It is mandatory for the owner (part of setup) and optional for other users. There is no policy to require it for a role yet.

**Encryption at rest (optional).** With `OTP_ENCRYPTION_KEY` (32 random bytes, hex or base64), TOTP secrets are stored as `enc:v1:<iv>.<tag>.<ciphertext>`, using AES-256-GCM with a random 96-bit IV, a 128-bit tag and associated data.
- Plaintext secrets stored before a key was set keep working and are encrypted on their next successful use.
- **What it protects:** TOTP secrets in database dumps, backups and SQL-read bugs, as long as the environment isn't leaked too. It doesn't help an attacker who has both.
- **Losing or changing the key disables MFA login for every enrolled user**, and they must re-enroll. A sealed value without a key fails loudly instead of being treated as plaintext. Back the key up with your other secrets.
- Key rotation is not supported.

## Authorization

- **Default.** Endpoints require authentication unless they opt out with `{auth: false}`. Roles are checked per endpoint, and the user and roles are **loaded from the database on every request**, never cached or trusted from the session.
- **Role semantics:**
  - `owner` satisfies every requirement.
  - `admin` satisfies everything except `owner`-only requirements.
  - Other roles satisfy only themselves.
  - An empty role list means any signed-in user.
- **Granting** (`canGrantRole`; enforced by the built-in `/api/users` endpoints):
  - Only owners may grant `owner` or `admin`; admins may grant app roles.
  - Deleting a user requires being able to grant all of its roles, so admins can't delete admins.
  - Owners can't be deleted through the API, and users can't delete themselves there.
- **Trust in admins.** Admins are trusted to manage ordinary users and see the user list. They can't touch owners or other admins.
- **Role changes** of an existing user aren't exposed by the API. Change roles in the database, or delete and recreate the user.

## Rate limits

| Limit | Window | Scope |
|---|---|---|
| All requests | 1000 per minute | per IP (global flood guard, every path incl. static files) |
| Login | 20 / 5 / 100 per 15 min | per IP (IPv6 /56) / per account + IP / per account |
| Login from a trusted device (instead of the per-account ceiling) | 10 per 15 min | per device cookie |
| Login MFA code, MFA enrollment and disable | 20 / 5 / 10 per 10 min | per IP / per account + IP / per account |
| Setup token | 5 per 15 min | per IP, IPv6 /56 (an accepted token is refunded) |
| Setup MFA code | 5 per 10 min | per IP |
| Password re-confirmation (`/api/account/*`) | 30 / 10 per 15 min | per IP / per account (every attempt counts) |
| `GET /api/auth/csrf` | 120 per minute | per IP |

**Counting.**
- Login and MFA attempts are counted **before** the slow check, so parallel bursts can't overshoot.
- A success doesn't count: a correct password refunds the IP and account (or device) attempt and clears the account + IP counter.
- The tiers stop at the first exceeded limit, so a blocked IP creates no per-account counters.

**Targeted lockout (device cookies).** Distributed attackers can exhaust the loose per-account ceiling (100 per 15 minutes), so the stack follows OWASP's device-cookie approach.
- After a complete sign-in (password plus MFA if enabled, or setup), the browser receives `__Host-<cookieName>.device`.
  - It is HttpOnly, SameSite=Strict and valid for 180 days.
  - It holds an HMAC signature over a hash of the account name, a random device id and the expiry; the HMAC key is derived from `SESSION_SECRET`.
- Login attempts for that account from that browser skip the account-wide ceiling. They are still limited per IP, per account + IP, and to 10 per device per 15 minutes.
- So the real user can always sign in from a browser they used before, while the per-IP and per-account + IP limits still stop guessing.
- The cookie grants no access by itself, and only the most recently signed-in account per browser is remembered.

**Logging and keys.**
- Each limit logs one warning per key and window.
- Usernames in keys are normalised and hashed, so a password typed into the username field never reaches the logs.

**Storage.** Counters live **in process memory by default**, so the limits apply per instance. For several instances, pass a shared `security.rateLimitStore`:

```ts
import type {RateLimitCounter, RateLimitStore} from "toto-stack";

/** Shape of a shared store (e.g. Redis: INCR + PEXPIRE NX / DECR / DEL). */
export class SharedRateLimitStore implements RateLimitStore {
    async increment(key: string, windowMs: number): Promise<RateLimitCounter> {
        // atomically: count = INCR key; if new, PEXPIRE key windowMs; resetAt = now + PTTL key
        void key;
        return {count: 1, resetAt: Date.now() + windowMs};
    }
    async decrement(key: string): Promise<void> { void key; /* DECR if the key exists and > 0 */ }
    async reset(key: string): Promise<void> { void key; /* DEL key */ }
}
```

The global flood guard always stays in memory per instance. The thresholds are constants and can't be configured yet.

## Running several instances

**Shared through the database:**
- Sessions, including revocations.
- The setup state and the setup lock.
- The TOTP replay guard.
- Users, roles and API keys.

**Per instance:**

| Per instance | Consequence | What to do |
|---|---|---|
| Authentication rate limits (default store) | Limits multiply by the number of instances | Provide `security.rateLimitStore` |
| Global flood guard | 1000 requests per minute **per instance** | Rate-limit at the proxy as well |
| Generated setup token | Each instance prints its own | Set `SETUP_TOKEN` |
| Cron jobs and background services | Run on **every** instance | Make jobs idempotent or use a database lock (the built-in `SessionCleanup` is idempotent) |
| Log level and format, console patch | Process-wide, not per server: the most recently created server sets the level and format; the first server started with `patchConsole` installs the patch, and stopping it undoes it | Configure logging the same way in every server of a process |

All instances must share the same `SESSION_SECRET` (cookie signatures, anonymous CSRF tokens) and the same `OTP_ENCRYPTION_KEY`.

## Logging and errors

**Logs:**
- No passwords, password hashes, session ids, CSRF tokens, API keys or TOTP secrets are logged. The generated setup token is written to stderr directly, not to the logger.
- Rate-limit logs contain hashed account keys.
- Notification failures (which can contain remote response text) are logged server-side by the notification service. The template's notification route returns only each handler's ok flag, never the error.
- Every request has a random `X-Request-Id`, never taken from the client, which is included in JSON logs.

**Errors:**
- Every error response carries a stable `code` (`ErrorCode`); 4xx responses also carry a specific message.
- 5xx responses in production carry only the status text and the status's generic code (`INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`), unless the error is deliberately exposed (e.g. `OVERLOADED`). The stack trace is logged.
- Body-parser failures get generic messages; the parser's detail is only logged.

## Cryptography

The stack uses only established primitives and libraries. It contains no custom cryptographic algorithms.

| Purpose | Implementation |
|---|---|
| Password hashing | Argon2id: `@node-rs/argon2` |
| TOTP (RFC 6238) | otplib v13 (`@otplib/totp`, `@otplib/plugin-crypto-node`, `@otplib/plugin-base32-scure`) |
| TOTP secrets at rest | AES-256-GCM (`node:crypto`), 96-bit random IV, 128-bit tag, fixed associated data |
| Anonymous CSRF tokens, device cookies, pending-MFA credential fingerprint | HMAC-SHA256 (`node:crypto`) with HKDF-SHA256 subkeys of `SESSION_SECRET` (`crypto.hkdfSync`) |
| API keys, setup-token comparison | SHA-256 (`node:crypto`) |
| All secret comparisons | `crypto.timingSafeEqual` |
| Random tokens, salts, ids | `crypto.randomBytes` / `randomUUID` |
| Session cookie signature | express-session |

## Known limitations and deferred items

**Accounts and credentials:**
- **No account recovery.** There is no password reset, no email verification and no MFA recovery codes, and admins can't reset another user's MFA or API key.
  - A user who loses their authenticator needs database intervention ([Troubleshooting](troubleshooting.md#a-user-lost-their-authenticator)).
  - Keep the owner's TOTP secret backed up.
- **API keys:** one per user, no scopes, no expiry, no last-used tracking.
- **No role-change endpoint**, and no "require MFA for role X" policy.
- **Fixed policy constants.** Rate-limit thresholds and the password length policy aren't configurable yet. The Argon2id parameters and the hashing queue are configurable.
- **`OTP_ENCRYPTION_KEY` rotation** isn't supported (users re-enroll).

**Operations:**
- **Per-instance defaults:** the global flood guard, the default rate-limit store and cron jobs (see above).
- **Public setup state.** `GET /api/auth/me` reveals whether an instance still needs setup. Complete setup right after deploying.
- **Pending MFA logins** are not deleted by "sign out other sessions" (they have no user yet). They can't complete after a password change or after MFA is disabled, and they expire after 10 minutes.
- **No audit log** of security events beyond application logs, and no UI to list or revoke your own sessions.

**Platform:**
- **CSP** allows inline styles (`'unsafe-inline'` in `style-src`).
- **Compression** is left to the reverse proxy.
- **Docker socket.** The template's Traefik container mounts the Docker socket read-only, which is effectively root on the host ([Deployment](deployment.md#the-docker-socket)).
- **Databases:** only MySQL and MariaDB are tested.
