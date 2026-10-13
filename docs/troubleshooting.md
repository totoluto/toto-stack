# Troubleshooting

- [Startup and configuration](#startup-and-configuration)
- [Prisma and the database](#prisma-and-the-database)
- [Package managers](#package-managers)
- [Login, cookies and CSRF](#login-cookies-and-csrf)
- [Setup and MFA](#setup-and-mfa)
- [Docker](#docker)
- [TypeScript](#typescript)

## Startup and configuration

### `ConfigError: Invalid toto-stack configuration`

`createServer()` validates the whole configuration and lists every problem at once. The `ConfigError` has an `issues` array. Common causes:

| Message (abridged) | Fix |
|---|---|
| `SESSION_SECRET is required in production` and `NODE_ENV is not set, so production mode is assumed` | Locally, set `NODE_ENV=development`; the template's `npm run dev` does this. In production, set the secret. |
| `SESSION_SECRET looks like a placeholder (contains "…")` / `must be at least 32 characters` / `is not random enough (only N distinct characters)` | Generate one: `openssl rand -base64 48`. Rejected are values with `change-me`, `replace`, `example`, `placeholder` or `not-secure` written as words, and values made only of separated words containing `secret`, `todo`, `your` or `xxx` ([exact rules](security.md#production-mode-node_env)). |
| `ALLOWED_ORIGINS is required in production` | Set your public origin, e.g. `ALLOWED_ORIGINS=https://app.example.com`. |
| `ALLOWED_ORIGINS must contain comma-separated https origins without paths or trailing slashes` | Use `https://app.example.com`, not `https://app.example.com/` or a URL with a path. Production requires `https`. |
| `SETUP_TOKEN must be at least 16 characters` / `looks like a placeholder` / `is not random enough` | `openssl rand -base64 24`. This is checked in development too. |
| `OTP_ENCRYPTION_KEY must be 32 bytes as 64 hex characters or base64` / `is not random enough` | `openssl rand -base64 32` or `openssl rand -hex 32`. This is checked in development too. |
| `TOTP_ISSUER must be at most 64 characters without ":"` | Remove the colon. |
| `frontend.dir must be an absolute path` | `path.join(import.meta.dirname, "public")`, not `"./public"`. |
| `session.cookieName … must not carry a cookie prefix` | Use a base name such as `sid`; `__Host-` is added in production. |
| `session.idleTimeout … must not exceed session.absoluteTimeout` | Make the idle timeout ≤ the absolute timeout. The touch interval must be shorter than the idle timeout. |
| `SMTP_FROM (email.from) is required when SMTP is configured` / `SMTP_USER and SMTP_PASS … must be set together` | Complete the SMTP settings, or unset `SMTP_HOST` to disable email. |
| `cron job "X" has an invalid cron expression` / `unknown time zone` / `Duplicate cron job name` | Fix the job definition (node-cron syntax, IANA zone names). |
| `LOG_LEVEL / logger.level must be one of debug, info, warn, error, silent` | Use one of those values. |
| `security.passwordHashing.<name> must be an integer >= <min>` | Fix the value. Defaults: `memoryCost` 19456 (KiB, at least 8 × `parallelism`), `timeCost` 2, `parallelism` 1, `concurrency` 2, `queueLimit` 0 or more (32). |
| Warning: `security.passwordHashing.memoryCost … is below the OWASP Argon2id baseline` | Not an error. Raise `memoryCost` to at least 19456 unless you deliberately accept weaker hashes. |

A custom service whose name clashes with a built-in dependency throws `services: "<name>" conflicts with a built-in dependency`.

### `listen EADDRINUSE`

Another process uses the port. `start()` rejects with the original error. Change `PORT`, or stop the other process.

### `@node-rs/argon2` fails to load its native binding

Password hashing uses a native module that ships as prebuilt, platform-specific optional dependencies, for example `@node-rs/argon2-linux-x64-musl`. They cover Linux (glibc and musl/Alpine, x64 and arm64), macOS and Windows. No compiler or install script is needed, so `npm ci --ignore-scripts` works. If loading fails:
- **Optional dependencies were omitted** (`--omit=optional`, `--no-optional`, or a package manager configured to skip them). Reinstall with them.
- **`node_modules` was copied from another OS or CPU architecture**, for example from macOS into a Linux container. Install inside the target environment; the template's Dockerfile does.
- **The lockfile is missing the platform packages.** `package-lock.json` normally lists all of them, whatever platform it was created on. If yours doesn't (a known npm issue with some older lockfiles), regenerate it with `npm install` and commit it.
- **Unsupported platform.** There is no automatic compile fallback. Building the bindings from source needs a Rust toolchain; see [napi-rs/node-rs](https://github.com/napi-rs/node-rs).

### `ERR_REQUIRE_ESM` or `require() of ES Module`

`toto-stack` is ESM-only, and CommonJS can load it only on Node ≥ 22.12 (`require(esm)`). Upgrade Node, or make your server an ES module.

### The process doesn't exit after `stop()`, or logs `Forcing exit`

The stack clears its own timers in `stop()` but never disconnects your Prisma client, and an open connection keeps Node alive.
- Disconnect it in `hooks.onShutdown: () => prisma.$disconnect()`.
- Close your own timers and sockets in your background services' `stop()`.
- Close websocket servers in `hooks.beforeShutdown`; otherwise they hold the HTTP drain open until `shutdown.timeoutMs`.

With `shutdown.handleSignals: true`, a process still alive `timeoutMs` + 5 s after the signal is force-exited, with the log line `Process still running … Forcing exit.` That points at one of the leaks above. A second Ctrl-C exits immediately.

### Non-API pages return 404 in production

- `frontend` isn't configured. The default is API-only.
- Or `frontend.dir` has no `index.html`: build the client first. The server logs a warning at startup.
- In the template, `npm run build` copies the client to `dist/public`.

## Prisma and the database

### `Cannot find module '…/client'` or `@prismaClient/client` after migrating

Since Prisma 7, `prisma migrate dev` **no longer generates the client**. Run:

```bash
npx prisma generate
```

The template runs it on `npm install` (`postinstall`) and in `npm run build`. `prisma generate` needs no database or environment variables.

### `npm install prisma` installed 8.x

npm's `latest` tag for `prisma` points to an 8.x release candidate. Pin version 7 with `npm install --save-dev prisma@^7 && npm install @prisma/client@^7`.

### `prisma migrate dev` fails creating the shadow database

`migrate dev` creates a temporary shadow database (`prisma_migrate_shadow_db_<uuid>`) to detect drift. A least-privilege database user can't create it, and you get an error such as `P3014 Prisma Migrate could not create the shadow database`.

- **Template, Docker database.** The dev compose override grants `MYSQL_USER` the rights on `prisma\_migrate\_shadow\_db\_%`. The init script runs **only when the volume is first created**. If your `db_data` volume predates it, either recreate the volume (`docker compose down -v`, which **deletes local data**) or run the grant once:

  ```bash
  docker compose exec db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "GRANT ALL PRIVILEGES ON \`prisma\\_migrate\\_shadow\\_db\\_%\`.* TO \"$MARIADB_USER\"@\"%\";"'
  ```

- **Any other server.** Set `SHADOW_DATABASE_URL` (template) or `datasource.shadowDatabaseUrl` in `prisma.config.ts` to a database a privileged user may reset.
- **Production** never needs a shadow database: use `prisma migrate deploy`.

### postinstall prints `Prisma CLI not installed (production install?)`

The template's `postinstall` (`scripts/generate.js`) prints this when the Prisma CLI, a dev dependency, isn't installed, e.g. `npm ci --omit=dev` or `NODE_ENV=production npm ci`. That's expected for production installs: the built `dist/server.js` already contains the generated client. To build, install with dev dependencies.

### `prisma migrate … needs a database connection. Missing environment variable(s): …`

This is the template's `prisma.config.ts`: commands that talk to the database (`migrate`, `db`, `studio`) need `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_HOST`, `MYSQL_PORT` and `MYSQL_DATABASE`, from the environment or `.env`.

### Can't connect to the database (`ECONNREFUSED 127.0.0.1:3306`)

- Start the database with `docker compose up -d --wait db`.
- In `.env`, `MYSQL_HOST=127.0.0.1` is for `npm run dev` on your machine; inside Compose the app uses `db`.
- If port 3306 is taken locally, change `MYSQL_PORT`; the dev override publishes that port on `127.0.0.1`.

### `npm audit` reports `mariadb` vulnerabilities

Your app is missing the `overrides` block from the template ([details](upgrading.md#keeping-the-dependency-overrides)). With pnpm, Yarn or Bun, see below.

## Package managers

### pnpm skipped build scripts (`pnpm approve-builds`)

pnpm 10 doesn't run dependencies' install scripts until you approve them. If it reports ignored build scripts, the Prisma engines and esbuild may be missing, and `prisma` commands or `npm run build` fail. Run:

```bash
pnpm approve-builds
```

Approve `prisma`, `@prisma/engines` and `esbuild` (the exact list pnpm shows may differ), then run `pnpm install` again. Your own `postinstall` (`prisma generate`) is not affected by this setting.

### Overrides with pnpm, Yarn or Bun

pnpm and Yarn ignore npm's `overrides` field, while Bun reads it. Move the template's overrides where your package manager expects them:

- **pnpm:** `"pnpm": {"overrides": {...}}` in `package.json`. Newer pnpm versions can also read `overrides` from `pnpm-workspace.yaml`.
- **Yarn:** `"resolutions": {...}`.
- **Bun:** nothing to move; Bun honours the `overrides` block as is (it also supports `resolutions`).

Verify with `npm ls mariadb` or your package manager's equivalent.

### Docker image uses npm

The template's Dockerfile installs with `npm ci` when a `package-lock.json` exists, and otherwise falls back to an unpinned `npm install`. Commit an npm lockfile (`npm install --package-lock-only`), or adapt the Dockerfile.

## Login, cookies and CSRF

### Login succeeds, but the next request is unauthenticated

The session cookie wasn't stored. Typical causes:

- **Production mode over plain HTTP.** In production the cookie is `__Host-connect.sid` and `Secure`; browsers reject it on `http://`. Use HTTPS, or run locally with `NODE_ENV=development`.
- **Behind a TLS proxy without `TRUST_PROXY`.** Express then sees an insecure connection, and express-session doesn't send the `Secure` cookie. In production the server logs this once: `A request arrived through an HTTPS proxy (X-Forwarded-Proto: https), but the proxy is not trusted …`. Set `TRUST_PROXY=1` (one proxy) and make sure the proxy sends `X-Forwarded-Proto`.
- **Frontend and API on different sites.** The cookies are `SameSite=Lax` (session) and `SameSite=Strict` (anonymous CSRF nonce). Serve the SPA and the API from the same site, as the template does (Vite proxies `/api` in development).
- **Session ended.** The absolute timeout (7 days from sign-in) or the idle timeout (24 hours) has passed. `GET /api/auth/me` then answers `login`.

### 403 `ORIGIN_NOT_ALLOWED`

The browser's `Origin` isn't listed exactly in `ALLOWED_ORIGINS`: scheme, host and port must match, with no trailing slash. Browsers send `Origin` on same-origin POSTs too, so your own public origin must be listed. In development, `http://localhost:3000/3001` and `http://127.0.0.1:3000/3001` are allowed automatically; other dev ports aren't.

### 403 `CSRF_INVALID`

- The request didn't send `X-CSRF-Token`. Use `apiFetch`, or fetch a token from `GET /api/auth/csrf`.
- The token belongs to an older session. After login, MFA, setup or logout, fetch a new one. `apiFetch` retries once automatically, and `UserProvider`'s setters clear the cached token.
- The anonymous nonce cookie was blocked, for example by third-party-cookie settings when the API runs on another site.

### 503 `OVERLOADED` on login or password confirmation

More password checks arrived than the hashing queue allows: `security.passwordHashing`, by default 2 running and 32 waiting, with a warning `Password hashing is saturated …` logged at most once a minute. Clients should retry after `Retry-After` (1 s).
- Under a credential-stuffing burst this is intended load shedding.
- For legitimate peaks, raise `queueLimit`, or raise `concurrency` together with `UV_THREADPOOL_SIZE` (keep it below the threadpool size). Each running hash needs `memoryCost` (19 MiB by default) of memory.

### 429 `RATE_LIMITED` for everyone

If the app sits behind a proxy and `TRUST_PROXY` is unset, every client appears with the proxy's IP and shares one rate-limit bucket. Set `TRUST_PROXY` to the number of proxies.

In development, many reloads from one machine can reach the global limit of 1000 requests per minute. Wait for the `Retry-After` period.

## Setup and MFA

### Where is the setup token?

- `SETUP_TOKEN` in `.env`; `create-toto-app` generates it.
- If it's unset, the server prints a one-time token **to stderr** at startup while no user exists. It is printed regardless of `LOG_LEVEL`; the regular log only says a token was printed:

  ```
  toto-stack: no user exists yet. Create the owner account in the app with this one-time setup token:

      <token>

  It is valid until setup completes or the server restarts. Set SETUP_TOKEN to choose your own.
  ```

  With Docker: `docker compose logs app | grep -A2 "setup token:"`. If your process manager discards stderr, set `SETUP_TOKEN` instead.

`SETUP_TOKEN_CHANGED` means the server restarted with a newly generated token, or `SETUP_TOKEN` changed, after you started the setup. Start the setup again.

### TOTP codes are rejected

- **Clock drift.** Codes from the previous and the next 30-second step are accepted. Check that both the server's and the phone's clocks are synchronised (NTP).
- **Reused code.** Each code works once. Wait for the next one.
- **Rate limit.** Too many attempts give 429; wait for `Retry-After`.
- **`OTP_ENCRYPTION_KEY` changed or removed.** If it changed after users enrolled, their stored secrets can't be decrypted, and MFA logins fail with a server error. Restore the original key. Without it, the affected users must re-enroll (see below).

### A user lost their authenticator

There is no recovery flow yet. An operator with database access can disable MFA for the user, who then signs in with their password and enrolls again under Settings:

```sql
UPDATE `User` SET otpEnabled = 0, otpSecret = NULL, otpLastUsedStep = NULL WHERE username = 'alice';
DELETE FROM `Session` WHERE userId = (SELECT id FROM `User` WHERE username = 'alice');
```

For the owner account, re-enable MFA right after signing in.

## Docker

| Symptom | Fix |
|---|---|
| `required variable MYSQL_ROOT_PASSWORD is missing a value: Set MYSQL_ROOT_PASSWORD in .env` (or `DOMAIN`, `ACME_EMAIL`, `SESSION_SECRET`) | Fill in `.env`. `DOMAIN`, `ACME_EMAIL` and `SESSION_SECRET` are only required by `docker-compose.prod.yml`. |
| `dependency failed to start: container …-db is unhealthy` | Check `docker compose logs db`: wrong credentials for an existing volume, disk full, or an incompatible data directory. |
| `migrate` exits non-zero and `app` doesn't start | `docker compose logs migrate`: a migration failed. Fix it and run `up` again. |
| `no such service: totostack-db` | The service is called `db` (`docker compose up -d --wait db`). |
| Let's Encrypt certificate not issued | `DOMAIN` must resolve to the server, and port 80 must be reachable from the internet (HTTP challenge). See `docker compose logs proxy`. |
| The app container is `unhealthy` | `GET /api/health` returns 503 when the database is unreachable. See `docker compose logs app`. |

## TypeScript

### `Property 'myService' does not exist on type 'Dependencies'`

The `declare module "toto-stack" { interface CustomServices {...} }` augmentation is either:
- in a file without any top-level `import` or `export` (it then declares a separate ambient module), or
- in a file your `tsconfig.json` doesn't include.

Put it in a module file next to the service class ([example](../packages/stack/README.md#custom-services)).

### Body schema type errors in `this.post(path, schema, …)`

The route helpers take zod **4** schemas. Install `zod@^4` in your app; zod 3 schemas have incompatible types.

### `req.user` is `any`, or `Cannot find module 'express'` types

`toto-stack` ships the Express type definitions as dependencies. Make sure you import from `"toto-stack"` (which loads the augmentation of `Express.Request.user`), and that `skipLibCheck` doesn't hide a broken install. Reinstall if `node_modules/@types/express` is missing.
