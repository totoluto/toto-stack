---
title: Configuration
description: Server options, environment variables, middleware order, sessions, and frontend delivery.
sidebar:
  order: 1
---

Configure `createServer()` with explicit options or environment variables. This page is the manual reference for both, followed by middleware, frontend and session behavior. For exported type signatures, use the [TypeScript API](/toto-stack/api/).

## Configuration reference

`createServer(config)` resolves the configuration once, in this order: the config value, then the environment variable, then the default. After that the stack reads no environment variables.

- An invalid configuration throws a `ConfigError` whose `issues` lists every problem at once.
- The resolved values are available as `server.config` and `dependencies.config`.

| Option | Type | Default | Description |
|---|---|---|---|
| `prisma` | `StackPrismaClient` | required | Your generated Prisma client, including the base models. The app owns it; the stack never disconnects it. |
| `routes` | `RouteClass[]` | `[]` | Your `BaseRoute` subclasses, mounted under `/api` after the built-in routes. A scaffolded app passes the routes of `server/routes`. |
| `services` | `(deps) => CustomServices` | none | Factory for app services, attached to the dependencies. See [Custom services](/toto-stack/guides/services/#custom-services). |
| `backgroundServices` | `(deps) => BackgroundService[]` | none | Started after the server listens, stopped in reverse order on shutdown. |
| `cronJobs` | `(deps) => CronJob[]` | none | Jobs for the built-in scheduler. Validated by `createServer()`. |
| `roles` | `readonly string[]` | `[]` | App roles, added to the built-in `owner` and `admin`. Missing roles are created at boot; roles are never deleted. |
| `hooks.configureApp` | `(app, deps) => void \| Promise<void>` | none | Runs before body parsing, session and CSRF. Use it for raw-body webhooks. Routes mounted here have **no session and no CSRF protection**. |
| `hooks.onHttpServerCreated` | `(httpServer, deps) => void \| Promise<void>` | none | After the HTTP server is created, before it listens (attach websockets here). |
| `hooks.onReady` | `(deps) => void \| Promise<void>` | none | After listening and starting background services. |
| `hooks.beforeShutdown` | `(deps) => void \| Promise<void>` | none | First step of `stop()`, while requests are still served (only if `onReady` ran). Close websocket servers and other long-lived connections here, or they hold the drain open until `shutdown.timeoutMs`. |
| `hooks.onShutdown` | `(deps) => void \| Promise<void>` | none | Last step of `stop()` (only if `onReady` ran): requests are drained and jobs and services are stopped. Release app resources here, e.g. `() => prisma.$disconnect()`. |
| `http.port` | `number` | `PORT`, else `3001` | `0` picks a free port. |
| `http.host` | `string` | `HOST`, else all interfaces | Listen address. |
| `http.trustProxy` | `boolean \| number \| string \| string[]` | `TRUST_PROXY`, else `false` | Express `trust proxy`. Set it to the number of proxies in front of the app, for example `1` behind one Traefik or nginx. |
| `http.bodyLimit` | `string \| number` | `"10kb"` | Maximum JSON and urlencoded body size (413 above it). |
| `security.allowedOrigins` | `readonly string[]` | `ALLOWED_ORIGINS` | Origins allowed to send credentialed requests. **Required in production**, https only. In development `http://localhost:3000/3001` and `http://127.0.0.1:3000/3001` are always allowed. |
| `security.csp` | `Record<string, string[] \| null> \| false` | strict defaults | Content-Security-Policy directives merged over the defaults (helmet format; `null` removes a directive), or `false` to disable CSP. |
| `security.sessionSecret` | `string` | `SESSION_SECRET` | Signs cookies and anonymous CSRF tokens. **Required in production**: at least 32 characters, varied, not a recognisable placeholder. In development a random per-process secret is used if unset. |
| `security.setupToken` | `string` | `SETUP_TOKEN` | Required for first-run owner setup. At least 16 characters and not a placeholder, in every mode. If unset while no user exists, a random one-time token is generated and printed to stderr once per boot. |
| `security.totpIssuer` | `string` | `TOTP_ISSUER`, else the host of the first allowed origin, else `"toto-stack"` | Issuer shown in authenticator apps. At most 64 characters, no `:`. |
| `security.otpEncryptionKey` | `string` | `OTP_ENCRYPTION_KEY` | 32 bytes as 64 hex characters or base64. Encrypts TOTP secrets at rest with AES-256-GCM. Unset stores them in plaintext. |
| `security.rateLimitStore` | `RateLimitStore` | in memory, per process | Shared store for the authentication rate limits when you run several instances. |
| `security.passwordHashing` | `{memoryCost?, timeCost?, parallelism?, concurrency?, queueLimit?}` (integers) | `{memoryCost: 19456, timeCost: 2, parallelism: 1, concurrency: 2, queueLimit: 32}` | Argon2id parameters, OWASP baseline by default: `memoryCost` in KiB (19 MiB), `timeCost` passes, `parallelism` lanes. A lower `memoryCost` logs a production warning; hashes with other parameters are rehashed at the user's next login. `concurrency`: hashes running at once, so peak hashing memory ≈ `concurrency × memoryCost`; keep it below the libuv threadpool size (`UV_THREADPOOL_SIZE`, default 4). `queueLimit`: hashes allowed to wait; beyond it, password checks fail fast with 503 `OVERLOADED` and `Retry-After: 1`. |
| `session.absoluteTimeout` | `number` (ms) | 7 days | Maximum session lifetime from sign-in, never extended. Also the cookie `Max-Age`. |
| `session.idleTimeout` | `number` (ms) | `min(24 h, absoluteTimeout)` | A session without requests for this long ends. Must not exceed `absoluteTimeout`. |
| `session.touchInterval` | `number` (ms) | `min(5 min, idleTimeout / 2)` | Minimum time between activity writes of an unchanged session. Must be shorter than `idleTimeout`; `0` writes on every request. |
| `session.cookieName` | `string` | `"connect.sid"` | Base cookie name. In production the cookie is `__Host-<name>`. Don't include a prefix yourself. |
| `frontend` | `{dir: string} \| false` | `false` | Absolute path of the built SPA (the directory containing `index.html`), or `false` for API-only. |
| `notifications.handlers` | `Record<string, NotificationHandler> \| (deps) => Record<…>` | none | Notification handlers keyed by id. |
| `logger.patchConsole` | `boolean` | `true` | Route `console.*` through the logger while the server runs. |
| `logger.level` | `"debug" \| "info" \| "warn" \| "error" \| "silent"` | `LOG_LEVEL`, else `debug` in development and `info` in production | Minimum level logged. |
| `email.smtp` | `SmtpConfig \| false` | from `SMTP_*`; disabled if `SMTP_HOST` is unset | `{host, port?, secure?, user?, pass?}`. The port defaults to 465 if `secure`, else 587. `user` and `pass` must be set together. `false` disables email. |
| `email.from` | `string` | `SMTP_FROM` | Sender address; required when SMTP is configured. |
| `shutdown.handleSignals` | `boolean` | `false` | If `true`, SIGINT/SIGTERM run `stop()` and set the exit code (0, or 1 if `stop()` failed); the process then exits by itself. If it is still alive `timeoutMs` + 5 s later, it is force-exited. A second signal exits at once with code 128 + the signal number. |
| `shutdown.timeoutMs` | `number` (ms) | `10000` | How long `stop()` waits for in-flight requests (then closes the connections), and separately for running cron jobs. |

Middleware order, the CSP defaults, static file caching and session timing are explained in [the behavior sections below](#request-pipeline).

## Environment variables

These are the only variables the stack reads. Every one has a config equivalent that takes precedence. Values are trimmed, and empty values count as unset.

| Variable | Config | Notes |
|---|---|---|
| `NODE_ENV` | none | `development` or `test` enables development mode. **Anything else, including unset, is production mode.** |
| `PORT` | `http.port` | Default `3001`. |
| `HOST` | `http.host` | Default: all interfaces. |
| `TRUST_PROXY` | `http.trustProxy` | `true`, `false`, a hop count (`1`), or comma-separated addresses or subnets. Default `false`. `true` logs a production warning, because clients can then spoof their IP. |
| `ALLOWED_ORIGINS` | `security.allowedOrigins` | Comma-separated origins (`https://app.example.com`), no paths or trailing slashes. Required in production, https only. |
| `SESSION_SECRET` | `security.sessionSecret` | Required in production. At least 32 characters, at least min(10, length/4) distinct characters, and not a recognisable placeholder: `change-me`, `replace`, `example`, `placeholder` or `not-secure` written as words anywhere (e.g. `CHANGE_ME`, `pleaseReplaceThis`), or a value made only of separated words containing `secret`, `todo`, `your` or `xxx`. The check is narrow, so a hand-made value like `SuperSecretSessionKey2024` isn't caught; generate secrets ([rules](/toto-stack/operate/security/#production-mode-node_env)). A weak value is an error in production and a warning in development. Generate one with `openssl rand -base64 48`. |
| `SETUP_TOKEN` | `security.setupToken` | At least 16 characters, varied, no placeholder markers. Weak values are rejected **in every mode**. If unset, a one-time token is generated and printed to stderr while no user exists. Generate one with `openssl rand -base64 24`. |
| `TOTP_ISSUER` | `security.totpIssuer` | At most 64 characters, no `:`. |
| `OTP_ENCRYPTION_KEY` | `security.otpEncryptionKey` | 32 bytes as hex or base64 (`openssl rand -base64 32` or `openssl rand -hex 32`), with varied bytes and no placeholder markers; rejected otherwise in every mode. Keep it stable and backed up. |
| `LOG_LEVEL` | `logger.level` | `debug`, `info`, `warn`, `error` or `silent`. |
| `SMTP_HOST` | `email.smtp.host` | Enables email. |
| `SMTP_PORT` | `email.smtp.port` | Default 465 if secure, else 587. |
| `SMTP_SECURE` | `email.smtp.secure` | `true` or `false` (implicit TLS). |
| `SMTP_USER`, `SMTP_PASS` | `email.smtp.user` / `.pass` | Set both or neither. |
| `SMTP_FROM` | `email.from` | Required when `SMTP_HOST` is set, for example `"App <noreply@example.com>"`. |

**What development mode changes:**
- Cookies are not `Secure` and have no `__Host-` prefix.
- Localhost origins are allowed, and `http` origins are accepted in `ALLOWED_ORIGINS`.
- `SESSION_SECRET` is optional, and a weak one only warns. (`SETUP_TOKEN` and `OTP_ENCRYPTION_KEY` are validated the same way in both modes.)
- 5xx error messages are shown to the client, and logs are human-readable instead of JSON.

Because an unset `NODE_ENV` means production, a server started without it fails fast if production settings are missing. The error says so.

The database variables (`MYSQL_*`, `DATABASE_URL`) belong to your app's Prisma setup; the stack never reads them.

## Request pipeline

`createApp()` assembles the Express app in this order:

| # | Middleware | Applies to |
|---|---|---|
| 1 | Request id (`X-Request-Id`, available via `getRequestId()`) | everything |
| 2 | helmet security headers and CSP | everything |
| 3 | Origin allowlist and CORS headers; `OPTIONS` answers 204 | everything |
| 4 | Global flood guard (1000 requests/min per IP) | everything |
| 5 | **`hooks.configureApp(app, deps)`** | whatever you mount |
| 6 | `/api/health` (no session) | `/api/health` |
| 7 | Static SPA and `index.html` fallback (if `frontend` is set) | non-`/api` paths |
| 8 | JSON and urlencoded body parsers (`http.bodyLimit`) | everything below |
| 9 | Session (express-session with the Prisma store) | `/api` only |
| 10 | CSRF check | `/api` only |
| 11 | Built-in API routes (`/api/auth`, `/api/account`, `/api/users`), then your `routes`; unknown paths give a JSON 404 | `/api` |
| 12 | 404 handler | everything else |
| 13 | Error handler (standard envelope) | |

**What follows from this order:**
- **`configureApp` routes** see the raw request body: no parser has run yet, which is what signature-checking webhooks need. They also get **no session and no CSRF protection**, and the global rate limit still applies.
  - Authenticate them yourself, for example with an HMAC signature.
  - Don't mount browser-facing state-changing endpoints there.
- **Your API routes** are mounted under `/api` and get the session, CSRF, auth and roles.
- **Static files and health checks** never cost a session lookup.

For signed webhooks, add a route-specific raw body parser in `configureApp`, verify the provider signature against those bytes, and reject unauthenticated requests before handling the event.


## Content-Security-Policy

**The defaults:**
- `default-src 'self'`, `base-uri 'self'`, `connect-src 'self'`, `font-src 'self'`, `form-action 'self'`, `script-src 'self'`.
- `frame-ancestors 'none'`, `object-src 'none'`.
- `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`.
- In production also `upgrade-insecure-requests`.

**`security.csp`** is merged over the defaults **per directive**:
- A directive you set replaces the default for that directive.
- `null` removes it.
- Directive names use helmet's camelCase form.
- `security.csp: false` disables the CSP header entirely.

```ts
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js";

createServer({
    prisma,
    security: {
        csp: {
            connectSrc: ["'self'", "https://api.example.com"],
            imgSrc: ["'self'", "data:", "https://images.example.com"],
        },
    },
});
```

The CSP applies to every response, including the SPA's `index.html`. Vite's production build needs no inline scripts, so `script-src 'self'` works for the template.

## Serving the frontend

`frontend: {dir}` serves a built SPA from an **absolute** directory containing `index.html`. Resolve it from the server file, not from `process.cwd()`, for example `path.join(import.meta.dirname, "public")`.

| Path | Served as | `Cache-Control` |
|---|---|---|
| `/assets/*` | files from `<dir>/assets`; a missing file is a JSON 404 (never `index.html`) | `public, max-age=31536000, immutable` |
| `/index.html` and every unmatched non-API `GET` (SPA fallback) | `index.html` | `no-cache` |
| other files (`/favicon.svg`, `/robots.txt`, …) | static | `public, max-age=0` + ETag revalidation |
| `/api/*` | never served from `dir` | |

**Notes:**
- **Hashed assets only.** Only content-hashed files may live in `assets/`; that is Vite's default `build.assetsDir`. Anything there is cached by browsers for a year.
- **Missing build.** If `dir` has no `index.html`, the server still starts (with a warning in production), and non-API paths answer 404.
- **Compression** is left to the reverse proxy (the template enables Traefik's `compress` middleware).
- **API-only.** `frontend: false` (the default) serves only the API.

## Sessions

| Option | Default | Notes |
|---|---|---|
| `session.absoluteTimeout` | 7 days | Counted from sign-in (login, MFA completion or setup). Also the cookie's `Max-Age`. |
| `session.idleTimeout` | `min(24 h, absoluteTimeout)` | Must be ≤ `absoluteTimeout`. |
| `session.touchInterval` | `min(5 min, idleTimeout / 2)` | Must be < `idleTimeout`. `0` writes activity on every request. |
| `session.cookieName` | `connect.sid` | Base name; `__Host-` is prepended in production. Must not start with `__Host-` or `__Secure-`. |

**Precision:**
- An unchanged session writes its activity (`lastSeenAt`, `expiresAt`) at most once per `touchInterval`. It can therefore time out for idleness up to `touchInterval` **early, but never late**.
- The database `expiresAt` is `min(last activity + idle, sign-in + absolute)`.
- Both limits are checked on every read with the current configuration, so lowering them applies to existing sessions immediately.

**Pending state.** A pending MFA login, a setup in progress and an MFA enrollment last 10 minutes; that is a constant.

**Cookie name.** The effective name differs between development and production. Nothing in the browser reads it (the cookie is HttpOnly), but upstream tools that match cookies by name must use `__Host-connect.sid` in production.

**Websockets and other non-API paths.** The session middleware is mounted only on `/api`. `dependencies.sessionService.middleware()` returns the same middleware instance, which you can reuse, for example with socket.io's `io.engine.use(...)` inside `hooks.onHttpServerCreated`. Then call `dependencies.authService.authenticate(req)` to get the user. Apply your own origin and CSRF considerations to websocket handshakes.

## Roles

`roles: ["editor", …]` adds app roles to `owner` and `admin`.
- Names are 1–64 characters and are trimmed.
- At boot, missing roles are created with an upsert, which is safe when several instances boot at once.
- Unconfigured roles found in the database are kept. Remove a role by deleting it in the database yourself.

The semantics are in the [README](/toto-stack/guides/authentication/#roles).

## Logging

The logger configuration is **process-wide**, not per server instance, because loggers and `console` are process-global:
- **Level and format:** loggers are module-level, so the most recently created server sets them.
- **Console patch:** installed by the first server started with `logger.patchConsole` (default `true`), and undone when that server stops.

Everything else (rate limits, setup state, sessions, timers, services) belongs to the server instance.
- Before any server exists, the level comes from `LOG_LEVEL` and `NODE_ENV` at the first log call. This covers scripts that only import the package.
- In production, every line is one JSON object on stdout, suitable for Docker logging drivers and log shippers.

## Multiple instances

See [Running several instances](/toto-stack/operate/security/#running-several-instances) for what is shared through the database and what is per process.
