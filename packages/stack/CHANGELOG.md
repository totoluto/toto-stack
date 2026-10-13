# toto-stack

## 0.1.1

### Patch Changes

- cc611a9: Add a session revoke api for user managed session invalidation

## 0.1.0

Initial release: a security-focused foundation for Express 5 + Prisma 7 apps. ESM only; Node.js ≥ 22.12, so CommonJS apps load it through `require(esm)`.

- **Server (`createServer`):**
  - Configuration is validated once, from options and environment variables, and every problem is reported together in a `ConfigError`. Development mode is opt-in (`NODE_ENV=development|test`).
  - Lifecycle with `beforeShutdown`/`onShutdown` hooks, request draining and optional signal handling.
- **Authentication:**
  - Password login with TOTP MFA via otplib (RFC 6238, ±1 step, persistent replay protection, optional AES-256-GCM encryption of secrets).
  - First-run owner setup protected by a setup token, with atomic owner creation.
  - Argon2id password hashing (`@node-rs/argon2`, OWASP baseline, configurable; rehashed on login when the parameters change) with bounded load shedding (`security.passwordHashing`, 503 `OVERLOADED`).
  - Only established cryptographic libraries and `node:crypto` primitives; no custom algorithms.
- **Sessions:** Prisma-backed, with absolute and idle timeouts and a `__Host-` cookie in production. No resurrection of revoked sessions; one database read per authenticated request.
- **Protection:** CSRF (session-bound and signed anonymous tokens), origin allowlist, helmet/CSP, and rate limits with a pluggable `RateLimitStore`. Login device cookies keep users from being locked out of browsers they signed in from before.
- **Authorization:** configurable string roles with `owner`/`admin` semantics and add-only role sync. Users issue and revoke their own `toto_` API keys (Bearer).
- **Built-in endpoints** only for what the sign-in flow and account security need: auth (setup, login, MFA, logout, current user, CSRF), the signed-in user's account (password, MFA, API key) and health. One error envelope, in which every error carries a stable `ErrorCode`. Everything else, including user management, notifications and status, is app routes; `createUserSchema` and `sendNotificationSchema` are exported for them.
- **Extensibility:** `BaseRoute` with per-endpoint auth, roles and zod 4 body validation; custom services (`CustomServices`); cron jobs (validated, no overlap); background services; notification handlers (webhook, Discord, Slack, Telegram, email); config-driven SMTP email; structured logging.
- **Client and shared entries:**
  - `toto-stack/client`: `apiFetch` with automatic CSRF handling and typed `ApiError`, `configureApiClient`, `UserProvider`/`useUser`, `NavLinkRole` (React 18/19, react-router 7/8).
  - `toto-stack/shared`: client-safe roles, types and error codes.
- **Prisma models** ship in `toto-stack/prisma/base.prisma` (MySQL/MariaDB).
