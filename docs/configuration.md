# Configuration details

The option and environment variable tables live in the [package README](../packages/stack/README.md#configuration-reference). This page explains the behaviour behind some of them.

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
| 11 | Built-in API routes (`/api/auth`, `/api/account`), then your `routes`; unknown paths give a JSON 404 | `/api` |
| 12 | 404 handler | everything else |
| 13 | Error handler (standard envelope) | |

**What follows from this order:**
- **`configureApp` routes** see the raw request body: no parser has run yet, which is what signature-checking webhooks need. They also get **no session and no CSRF protection**, and the global rate limit still applies.
  - Authenticate them yourself, for example with an HMAC signature.
  - Don't mount browser-facing state-changing endpoints there.
- **Your API routes** are mounted under `/api` and get the session, CSRF, auth and roles.
- **Static files and health checks** never cost a session lookup.

```ts
import express from "express";
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js";

createServer({
    prisma,
    hooks: {
        configureApp: app => {
            // Raw body for a signed webhook; verify the signature before trusting it.
            app.post("/webhooks/billing", express.raw({type: "application/json", limit: "1mb"}), (req, res) => {
                const payload = req.body as Buffer;
                res.status(payload.length > 0 ? 204 : 400).end();
            });
        },
    },
});
```

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

The semantics are in the [README](../packages/stack/README.md#roles).

## Logging

The logger configuration is **process-wide**, not per server instance, because loggers and `console` are process-global:
- **Level and format:** loggers are module-level, so the most recently created server sets them.
- **Console patch:** installed by the first server started with `logger.patchConsole` (default `true`), and undone when that server stops.

Everything else (rate limits, setup state, sessions, timers, services) belongs to the server instance.
- Before any server exists, the level comes from `LOG_LEVEL` and `NODE_ENV` at the first log call. This covers scripts that only import the package.
- In production, every line is one JSON object on stdout, suitable for Docker logging drivers and log shippers.

## Multiple instances

See [Running several instances](security.md#running-several-instances) for what is shared through the database and what is per process.
