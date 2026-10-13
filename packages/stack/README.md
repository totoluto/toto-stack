# toto-stack

A security-focused foundation for Express 5 + Prisma 7 web apps with a React frontend. It provides:

- Password login with TOTP MFA and a first-run owner setup protected by a setup token.
- Database-backed sessions with absolute and idle timeouts.
- Role-based access control.
- CSRF protection, an origin allowlist and rate limiting.
- User and API-key management (the user service, the signed-in user's account endpoints), and a health endpoint.
- Cron jobs and background services, notifications, email and structured logging.
- React building blocks for the client.

You add your own routes, services and jobs on top.

> **Status: 0.x.** Until 1.0, a **minor** release (0.1 → 0.2) may contain breaking changes; patch releases don't. See [Upgrading](https://github.com/totoluto/toto-stack/blob/master/docs/upgrading.md).

The fastest start is the scaffolder, which generates a complete app (client, server, schema, Docker setup, `.env` with secrets):

```bash
npm create toto-app@latest my-app
```

The rest of this page documents the package itself.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Prisma schema](#prisma-schema)
- [Minimal server](#minimal-server)
- [Configuration reference](#configuration-reference)
- [Environment variables](#environment-variables)
- [Routes](#routes)
- [Custom services](#custom-services)
- [Roles](#roles)
- [Background services and cron jobs](#background-services-and-cron-jobs)
- [Notifications](#notifications)
- [Email](#email)
- [Logging](#logging)
- [Lifecycle](#lifecycle)
- [Client entry: `toto-stack/client`](#client-entry-toto-stackclient)
- [Shared entry: `toto-stack/shared`](#shared-entry-toto-stackshared)
- [Errors](#errors)
- [Testing your app](#testing-your-app)
- [Further documentation](#further-documentation)

## Requirements

| | Supported |
|---|---|
| Node.js | `>=22.12` |
| Module format | ESM only. CommonJS apps can `require("toto-stack")` through Node's `require(esm)` (Node ≥ 22.12). |
| Prisma | `prisma@^7` and `@prisma/client@^7` with the `prisma-client` generator and a driver adapter |
| Database | MySQL or MariaDB (through `@prisma/adapter-mariadb`). Other Prisma providers aren't tested or supported. |
| Client entry (optional) | `react` 18 or 19, `react-router` 7 or 8 (optional peer dependencies) |
| Native modules | Password hashing uses `@node-rs/argon2` (Argon2id), which ships prebuilt binaries for Linux (glibc and musl/Alpine, x64 and arm64), macOS and Windows. No compiler or install script is needed. Don't omit optional dependencies (they carry the binaries). |
| Production | HTTPS, terminated by a reverse proxy (see [Security](https://github.com/totoluto/toto-stack/blob/master/docs/security.md)) |

Express 5, express-session, helmet, zod 4 and the Express type definitions are regular dependencies; you don't install them separately. If you write request schemas, add `zod@^4` to your own dependencies (the route helpers expect zod 4 schemas).

## Install

```bash
npm install toto-stack @prisma/client@^7 @prisma/adapter-mariadb@^7
npm install --save-dev prisma@^7
```

> **Pin `prisma@^7`.** The `latest` tag of the `prisma` package on npm currently points to an 8.x release candidate, which toto-stack does not support. A plain `npm install prisma` installs it.

The Prisma CLI is a dev dependency: in production you only run `prisma migrate deploy`, from a build or migration image (the scaffolded app ships one).

`@prisma/adapter-mariadb@7.10.0` pins a `mariadb` driver version with known vulnerabilities. Generated apps therefore carry npm `overrides` for it. Copy them into your app's `package.json` until Prisma updates the pin:

```json
{
  "overrides": {
    "mariadb": "^3.5.4",
    "mysql2": "^3.24.5",
    "deepmerge-ts": "^8.0.2"
  }
}
```

npm applies `overrides` only from the root `package.json`. pnpm and Yarn ignore it and use their own fields (`pnpm.overrides`, `resolutions`), while Bun reads `overrides` as is. See [Troubleshooting](https://github.com/totoluto/toto-stack/blob/master/docs/troubleshooting.md#overrides-with-pnpm-yarn-or-bun).

## Prisma schema

The stack reads and writes five models: `User`, `Role`, `UserRole`, `Session` and `SetupLock`. They ship as `node_modules/toto-stack/prisma/base.prisma` (also exported as `toto-stack/prisma/base.prisma`).

1. **Copy the models** from `base.prisma` into your `prisma/schema.prisma`.
   - You may add columns to `User`, and your own models.
   - Don't remove or rename existing fields.
   - When one of your models references `User`, add the back-relation field to the copied `User` model; Prisma requires both sides of a relation.

   ```prisma
   generator client {
     provider     = "prisma-client"
     output       = "../src/generated/prisma"
     moduleFormat = "esm"
   }

   datasource db {
     provider = "mysql"
   }

   // ... the models from toto-stack/prisma/base.prisma ...
   // In User, add the back-relation:  todos Todo[]

   model Todo {
     id      Int    @id @default(autoincrement())
     title   String
     ownerId Int
     owner   User   @relation(fields: [ownerId], references: [id], onDelete: Cascade)
   }
   ```

2. **Configure the connection in `prisma.config.ts`.** Prisma 7 doesn't read the URL from the schema, and it doesn't load `.env` files itself.

   ```ts
   import {defineConfig, env} from "prisma/config";

   // Prisma 7 doesn't load .env files. Load one yourself if you use it.
   try {
       process.loadEnvFile();
   } catch {
       // no .env file: rely on the real environment
   }

   export default defineConfig({
       schema: "prisma/schema.prisma",
       migrations: {path: "prisma/migrations"},
       datasource: {url: env("DATABASE_URL")}, // mysql://user:password@host:3306/db
   });
   ```

   URL-encode credentials that contain special characters.

3. **Create the database tables and generate the client:**

   ```bash
   npx prisma migrate dev --name init   # development: creates and applies a migration
   npx prisma generate                  # Prisma 7: migrate dev no longer generates the client
   ```

   - `migrate dev` needs a throwaway **shadow database**. The database user must be allowed to create one, or you set `shadowDatabaseUrl`; see [Troubleshooting](https://github.com/totoluto/toto-stack/blob/master/docs/troubleshooting.md#prisma-migrate-dev-fails-creating-the-shadow-database).
   - In production, apply the committed migrations with `npx prisma migrate deploy`.
   - When a toto-stack release changes `base.prisma`, follow the [schema change procedure](https://github.com/totoluto/toto-stack/blob/master/docs/upgrading.md#schema-changes).

4. **Create the client with the adapter:**

   ```ts
   // src/prisma.ts
   import {PrismaMariaDb} from "@prisma/adapter-mariadb";
   import {PrismaClient} from "./generated/prisma/client.js";

   const adapter = new PrismaMariaDb({
       host: process.env.MYSQL_HOST,
       port: Number(process.env.MYSQL_PORT) || 3306,
       user: process.env.MYSQL_USER,
       password: process.env.MYSQL_PASSWORD,
       database: process.env.MYSQL_DATABASE,
       connectionLimit: 5,
   });

   export const prisma = new PrismaClient({adapter});
   ```

`createServer` accepts any client that structurally matches the stack's models (the `StackPrismaClient` type). A generated client that includes the base models matches, including clients extended with `$extends`.

## Minimal server

```ts
// src/server.ts
import path from "node:path";
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js";

const server = createServer({
    prisma,
    // Serve the built SPA from <this file's directory>/public; omit for an API-only server.
    frontend: {dir: path.join(import.meta.dirname, "public")},
    // SIGINT/SIGTERM: drain requests, stop jobs, then run onShutdown and exit.
    shutdown: {handleSignals: true},
    // The app owns the Prisma client; onShutdown runs last, when nothing uses it anymore.
    hooks: {onShutdown: () => prisma.$disconnect()},
});

await server.start();
```

- In development, run it with `NODE_ENV=development`; no other variables are needed.
- In production you need at least `SESSION_SECRET` and `ALLOWED_ORIGINS`. See [Environment variables](#environment-variables).

On first start with an empty database, the server prints a one-time **setup token** to stderr (unless `SETUP_TOKEN` is set). It is printed regardless of `LOG_LEVEL`; the log only gets a notice without the token. The first-run setup needs it to create the owner account.

Built-in endpoints, the ones the sign-in flow and its security guarantees depend on:
- `/api/auth/*`: setup, login, MFA, logout, current user, CSRF token.
- `/api/account/*`: password, MFA and API key of the signed-in user.
- `/api/health`: readiness, including the database (mounted before the session middleware).

Everything else is app code you pass in `routes`. An app scaffolded by `create-toto-app` starts with three route files in `server/routes` that it owns and can change or remove: `/api/users` (user management for admins), `/api/notifications/*` and `/api/status`. See [Routes in a scaffolded app](#routes-in-a-scaffolded-app).

Every endpoint is documented in the [API reference](https://github.com/totoluto/toto-stack/blob/master/docs/api.md).

## Configuration reference

`createServer(config)` resolves the configuration once, in this order: the config value, then the environment variable, then the default. After that the stack reads no environment variables.

- An invalid configuration throws a `ConfigError` whose `issues` lists every problem at once.
- The resolved values are available as `server.config` and `dependencies.config`.

| Option | Type | Default | Description |
|---|---|---|---|
| `prisma` | `StackPrismaClient` | required | Your generated Prisma client, including the base models. The app owns it; the stack never disconnects it. |
| `routes` | `RouteClass[]` | `[]` | Your `BaseRoute` subclasses, mounted under `/api` after the built-in routes. A scaffolded app passes the routes of `server/routes`. |
| `services` | `(deps) => CustomServices` | none | Factory for app services, attached to the dependencies. See [Custom services](#custom-services). |
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

Middleware order, the CSP defaults, static file caching and session timing are explained in [Configuration details](https://github.com/totoluto/toto-stack/blob/master/docs/configuration.md).

## Environment variables

These are the only variables the stack reads. Every one has a config equivalent that takes precedence. Values are trimmed, and empty values count as unset.

| Variable | Config | Notes |
|---|---|---|
| `NODE_ENV` | none | `development` or `test` enables development mode. **Anything else, including unset, is production mode.** |
| `PORT` | `http.port` | Default `3001`. |
| `HOST` | `http.host` | Default: all interfaces. |
| `TRUST_PROXY` | `http.trustProxy` | `true`, `false`, a hop count (`1`), or comma-separated addresses or subnets. Default `false`. `true` logs a production warning, because clients can then spoof their IP. |
| `ALLOWED_ORIGINS` | `security.allowedOrigins` | Comma-separated origins (`https://app.example.com`), no paths or trailing slashes. Required in production, https only. |
| `SESSION_SECRET` | `security.sessionSecret` | Required in production. At least 32 characters, at least min(10, length/4) distinct characters, and not a recognisable placeholder: `change-me`, `replace`, `example`, `placeholder` or `not-secure` written as words anywhere (e.g. `CHANGE_ME`, `pleaseReplaceThis`), or a value made only of separated words containing `secret`, `todo`, `your` or `xxx`. The check is narrow, so a hand-made value like `SuperSecretSessionKey2024` isn't caught; generate secrets ([rules](https://github.com/totoluto/toto-stack/blob/master/docs/security.md#production-mode-node_env)). A weak value is an error in production and a warning in development. Generate one with `openssl rand -base64 48`. |
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

## Routes

Routes are classes extending `BaseRoute`, mounted under `/api/<path>`.

- Every endpoint requires an authenticated user (session or Bearer API key) unless the route or the endpoint passes `{auth: false}`.
- `roles` lists the roles that may call it (see [Roles](#roles)); endpoint options override the route's.
- Body schemas are zod 4 schemas. Invalid bodies get a 400 with code `VALIDATION_FAILED` and `details`.
- Errors thrown in handlers reach the error handler.

```ts
// src/routes/TodoRoute.ts
import {z} from "zod";
import {AppError, BaseRoute, respond, Role, type Dependencies} from "toto-stack";
import {prisma} from "../prisma.js";

const todoSchema = z.object({title: z.string().trim().min(1).max(200)}).strict();

export class TodoRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        // Defaults for every endpoint of this route: any signed-in user.
        super("/todos", dependencies);
    }

    protected registerRoutes(): void {
        this.get("/", async (req, res) => {
            const user = this.currentUser(req);
            const todos = await prisma.todo.findMany({where: {ownerId: user.id}});
            return respond(res, 200, "success", "Todos", {todos});
        });

        this.post("/", todoSchema, async (req, res, body) => {
            const todo = await prisma.todo.create({data: {title: body.title, ownerId: this.currentUser(req).id}});
            return respond(res, 201, "success", "Todo created", {todo});
        });

        this.put("/:id", todoSchema, async (req, res, body) => {
            const {count} = await prisma.todo.updateMany({
                where: {id: Number(req.params.id), ownerId: this.currentUser(req).id},
                data: {title: body.title},
            });
            if (count === 0) throw new AppError(404, "Todo not found.", {code: "TODO_NOT_FOUND"});
            return respond(res, 200, "success", "Todo updated");
        });

        // Per-endpoint override: only admins (and owners) may purge.
        this.delete("/", async (_req, res) => {
            await prisma.todo.deleteMany({});
            return respond(res, 200, "success", "All todos deleted");
        }, {roles: [Role.ADMIN]});

        // Per-endpoint override: public.
        this.get("/count", async (_req, res) => {
            return respond(res, 200, "success", "Count", {count: await prisma.todo.count()});
        }, {auth: false});
    }
}
```

Register it with `createServer({prisma, routes: [TodoRoute]})`.

- **Methods:**
  - `get` and `delete` take `(path, handler, options?)`.
  - `post`, `put` and `patch` take `(path, schema, handler, options?)`, and the handler receives the parsed body as its third argument.
  - Use `noPayloadSchema` for a body-less POST.
- **`this.currentUser(req)`** returns `{id, username, roles}` on authenticated endpoints and throws a 401 `AppError` otherwise. `req.user` is typed as well.
- **Errors:** `throw new AppError(status, message, {code?, details?, headers?, expose?})` sends that status, plus any `headers` (e.g. `Retry-After`).
  - For 4xx, the message, code and details reach the client.
  - For 5xx they appear only in development, unless you pass `expose: true`; production otherwise sends the status text and its generic code.
  - Without a `code`, the status's generic code is used (`NOT_FOUND` for 404, …).
- **Helpers:**
  - `respond(res, status, "success" | "error", message, data?)` and `sendError(res, status, message, {code?, details?})` write the standard [envelope](#errors).
  - `getRequestIP(req)` returns the validated client IP (honouring `TRUST_PROXY`, with IPv4-mapped IPv6 unwrapped), or `undefined`. Never parse `X-Forwarded-For` yourself.
- **CSRF:** state-changing requests (anything but GET/HEAD/OPTIONS) to any `/api` route, yours included, need an `X-CSRF-Token` header unless they authenticate with `Authorization: Bearer`. `apiFetch` handles this in the browser.
- **Route order:** the built-in routes (`/api/auth`, `/api/account`, `/api/health`) are mounted before yours, so don't reuse their paths.
- **Unknown paths:** unknown `/api` paths return a JSON 404.

### Routes in a scaffolded app

The stack only mounts the routes the sign-in flow and account security depend on. A `create-toto-app` app keeps its own routes in `server/routes` and registers them in `server/index.ts`:

```ts
// server/routes/index.ts
export const routes: RouteClass[] = [StatusRoute, UsersRoute, NotificationRoute];

// server/index.ts
createServer({prisma, routes, /* ... */});
```

| File | Endpoints | Notes |
|---|---|---|
| `StatusRoute.ts` | `GET /api/status` | Public liveness check; an example of `{auth: false}`. |
| `UsersRoute.ts` | `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id` | Admin. Uses `userService`, `createUserSchema` (the stack's password policy and the configured roles) and `canGrantRole`. |
| `NotificationRoute.ts` | `GET /api/notifications/handlers`, `POST /api/notifications/send` | Admin. Uses `notificationService` and `sendNotificationSchema`. |

The files are yours: change them, delete them, or add routes next to them. The doc comments in `UsersRoute.ts` and `NotificationRoute.ts` list the security rules to keep if you change them (who may grant and delete what, no secrets in responses, no remote error text). Everything they use is public API: `BaseRoute`, `respond`, `sendError`, `ErrorCode`, `Role`, `canGrantRole`, the schemas and the services on `this.dependencies`.

## Custom services

The `services` factory returns your app services. They are attached to the dependencies object every route, hook and job receives. To type them, augment `CustomServices` **in a module file**, that is, a `.ts` file with at least one top-level `import` or `export`. In a file without one, `declare module "toto-stack"` declares a new ambient module that replaces the package's types instead of extending them.

```ts
// src/services.ts
import {Logger, type Dependencies} from "toto-stack";

export class AuditLog {
    private readonly log = new Logger("Audit");

    constructor(private readonly deps: Dependencies) {}

    record(userId: number, action: string): void {
        this.log.info(action, {userId, production: !this.deps.config.isDev});
    }
}

declare module "toto-stack" {
    interface CustomServices {
        auditLog: AuditLog;
    }
}
```

```ts
// src/server.ts
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js";
import {AuditLog} from "./services.js";

const server = createServer({
    prisma,
    services: deps => ({auditLog: new AuditLog(deps)}),
    hooks: {
        onReady: deps => deps.auditLog.record(0, "server started"),
    },
});

await server.start();
```

- In routes, the services are available as `this.dependencies.auditLog`, fully typed.
- The file holding the augmentation must be part of your TypeScript program (imported, or covered by `include`).
- A service name that clashes with a built-in dependency throws at construction.
- The built-in dependencies are `config`, `state`, `prisma`, `sessionStore`, `sessionService`, `notificationService`, `emailService`, `userService`, `mfaService`, `authRateLimiter`, `authService`, `setupService` and `requestSecurity`.

## Roles

A role is a string. The built-in roles are `owner` and `admin` (`Role.OWNER`, `Role.ADMIN`). Declare app roles in the config and keep them in a constant:

```ts
import {createServer, Role} from "toto-stack";
import {prisma} from "./prisma.js";

export const AppRole = {...Role, EDITOR: "editor", VIEWER: "viewer"} as const;

createServer({prisma, roles: [AppRole.EDITOR, AppRole.VIEWER]});
```

**Who satisfies a requirement:**
- `owner` satisfies **every** requirement.
- `admin` satisfies every requirement **except `owner`**.
- Any other role satisfies only itself.
- `roles: []` (or omitted) means "any signed-in user", on routes, in `hasAnyRole` and in `NavLinkRole`.
- `{roles: [AppRole.EDITOR, AppRole.VIEWER]}` admits editors, viewers, admins and owners.

**Who can grant roles** (`canGrantRole`, enforced by the scaffolded app's `POST /api/users`; enforce it in any route of yours that assigns roles):
- Only an owner may grant `owner` or `admin`.
- An admin may grant app roles.
- Other users can't create users.

In the scaffolded app's `/api/users`, deleting a user requires being allowed to grant every role it holds, so admins can't delete admins. Owners can't be deleted through the API, and nobody can delete their own account there.

**Sync is add-only.** At boot, configured roles missing from the database are created. Roles in the database that are no longer configured are kept (and logged at debug level), so removing a role from the config never deletes data. The first owner is created by the setup flow.

## Background services and cron jobs

```ts
import {createServer, Logger, type BackgroundService, type CronJob, type Dependencies} from "toto-stack";
import {prisma} from "./prisma.js";

class NightlyReport implements CronJob {
    readonly name = "NightlyReport";        // unique, used in logs
    readonly cronExpression = "0 3 * * *";  // node-cron syntax (5 fields, or 6 with seconds)
    readonly timezone = "Europe/Zurich";    // IANA zone; default "UTC"

    constructor(private readonly deps: Dependencies) {}

    async run({signal}: {signal: AbortSignal}): Promise<void> {
        const users = await this.deps.prisma.user.count();
        if (signal.aborted) return; // the server is stopping
        new Logger("NightlyReport").info("Report", {users});
    }
}

class QueueWorker implements BackgroundService {
    readonly name = "QueueWorker";
    private timer?: NodeJS.Timeout;

    start(): void {
        this.timer = setInterval(() => { /* poll */ }, 5000);
    }

    stop(): void {
        clearInterval(this.timer);
    }
}

createServer({
    prisma,
    cronJobs: deps => [new NightlyReport(deps)],
    backgroundServices: () => [new QueueWorker()],
});
```

**Cron jobs:**
- **Validation:** `createServer()` throws a `ConfigError` for a missing or duplicate name, an invalid expression or an unknown time zone, before anything listens.
- **No overlap:** a run is skipped, with a warning, while the previous run of the same job is still going.
- **Failures** are logged with the job name and never crash the process.
- **Stopping:** `stop()` aborts `signal`, then waits up to `shutdown.timeoutMs` (10 s by default) for running jobs.

**Background services** start in order after the server listens and stop in reverse order. A failure in one `stop()` doesn't prevent the others from stopping; all failures are rethrown together.

The built-in `SessionCleanup` job deletes expired session rows every 15 minutes, in batches.

**Per instance:** cron jobs and background services run in every process that calls `start()`. If you run several instances, make your jobs idempotent or guard them with a database lock. `SessionCleanup` is idempotent.

## Notifications

Notification handlers deliver a `{title, message, metadata?}` payload to a destination. Configure them by id:

```ts
import {createServer, DiscordHandler, EmailHandler, GenericWebhookHandler, SlackHandler, TelegramHandler} from "toto-stack";
import {prisma} from "./prisma.js";

createServer({
    prisma,
    notifications: {
        // A factory, because EmailHandler needs the email service.
        handlers: deps => ({
            ops: new SlackHandler(process.env.SLACK_WEBHOOK_URL!),
            discord: new DiscordHandler(process.env.DISCORD_WEBHOOK_URL!, {timeoutMs: 3000}),
            telegram: new TelegramHandler(process.env.TELEGRAM_BOT_TOKEN!, process.env.TELEGRAM_CHAT_ID!),
            webhook: new GenericWebhookHandler("https://hooks.example.com/notify"),
            email: new EmailHandler(deps.emailService, ["ops@example.com"]),
        }),
    },
});
```

**Handlers:**
- Invalid URLs, tokens or recipients throw at construction.
- The HTTP handlers time out after 5 s by default (`{timeoutMs}`) and don't follow redirects.
- Text is escaped for each target's markup.
- A custom handler is any object with `send(payload): Promise<void>` that rejects when delivery fails.

**From server code:** `await deps.notificationService.sendToAll(payload)` or `.sendToHandlers(["ops"], payload)`.
- Handlers run in parallel and never throw for delivery failures.
- The result is `{results: [{handler, ok, error?}], delivered, failed}`.
- Failures are logged. Keep `error` server-side: it can contain remote response text.

**HTTP endpoints.** The stack mounts none; the scaffolded app's `server/routes/NotificationRoute.ts` provides them (admin and owner) and validates the body with the exported `sendNotificationSchema`:
- `GET /api/notifications/handlers` lists the handler ids.
- `POST /api/notifications/send` takes `{title, message, handlers?, metadata?}` and answers:
  - **200** when at least one handler delivered, with `{delivered, failed, results: [{handler, ok}]}`.
  - **502 `DELIVERY_FAILED`** when all handlers failed.
  - **503 `NO_HANDLERS`** when none are configured.
  - **400 `UNKNOWN_HANDLER`** for unknown ids.

Remote error text is never returned to the client. Details are in the [API reference](https://github.com/totoluto/toto-stack/blob/master/docs/api.md#notifications).

## Email

Email is enabled when `email.smtp` is configured or `SMTP_HOST` is set; `SMTP_FROM` is then required.

```ts
import type {Dependencies} from "toto-stack";

export async function sendWelcome(deps: Dependencies, to: string): Promise<void> {
    if (!deps.emailService.isConfigured) return;
    await deps.emailService.send({to, subject: "Welcome", text: "Your account is ready."});
}
```

- `send()` rejects when email isn't configured or the SMTP server refuses the message. When email isn't configured, a single warning is logged at the first attempt.
- nodemailer is loaded on the first send and uses one pooled connection, which closes after 30 s idle and on `stop()`.
- **Escape every value you interpolate into `html`.** The stack doesn't template your HTML.

## Logging

```ts
import {getRequestId, Logger} from "toto-stack";

const log = new Logger("Billing");
log.info("Invoice created", {invoiceId: 42});
log.error("Charge failed", new Error("card declined")); // Errors are serialized under `err`
log.debug(`request ${getRequestId() ?? "-"}`);
```

- **Production:** one JSON object per line on stdout (pino): `{level, time, service, requestId?, msg, ...fields}`.
- **Development:** readable lines. Warnings and errors go to stderr.
- **Levels:** `debug`, `info`, `warn`, `error` and `silent`. Set the level with `logger.level` or `LOG_LEVEL`.
- **Process-wide.** Loggers and `console` are process-global, so two things are not per server instance:
  - the level and format: the most recently created server sets them;
  - the console patch: the first server started with `logger.patchConsole` (default `true`) installs it, and stopping that server undoes it.
- **Console:** while the patch is active, `console.log/info/debug/warn/error` go through the logger, tagged `console`.
- **Request ids:** every request gets a random id, never taken from the client and echoed in the `X-Request-Id` response header. `getRequestId()` returns it inside a request, and JSON logs include it.
- **Secrets:** the stack never logs passwords, tokens or keys. The generated one-time setup token is written directly to stderr instead of the log, so it stays out of log pipelines. See [Security](https://github.com/totoluto/toto-stack/blob/master/docs/security.md#first-run-setup).

## Lifecycle

```ts
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js";

const server = createServer({
    prisma,
    shutdown: {handleSignals: true, timeoutMs: 10_000},
    hooks: {
        beforeShutdown: () => { /* close websocket servers, long-poll connections */ },
        onShutdown: () => prisma.$disconnect(),
    },
});
await server.start();
```

**`createServer(config)`** validates the configuration and builds the dependencies. Nothing listens, and no timer runs yet.

**`start()`**, in order:
1. Reads the setup state and creates missing roles.
2. Builds the Express app.
3. Creates the HTTP server and calls `onHttpServerCreated`.
4. Listens.
5. Starts the rate-limit cleanup, cron and background services.
6. Installs signal handlers, if `handleSignals` is set.
7. Calls `onReady`.

If any step fails, it cleans up and rejects with the original error (for example `EADDRINUSE`). A stopped server can't be started again; create a new one.

**`stop()`**, in order:
1. Calls `beforeShutdown`, if `onReady` ran. Requests are still served at this point.
2. Stops accepting connections and lets in-flight requests finish. Connections still open after `shutdown.timeoutMs` are closed.
3. Stops cron jobs (aborted, then awaited up to `shutdown.timeoutMs`) and background services, in reverse start order.
4. Releases the stack's own resources (rate-limit timers, SMTP pool) and restores the console.
5. Calls `onShutdown`, if `onReady` ran. Nothing uses the database anymore.

Every step runs even if an earlier one fails, and the failures are rethrown together. `stop()` is idempotent.

**The app owns the Prisma client.** The stack never disconnects it. Disconnect it in `onShutdown`, or after `await server.stop()` if you handle signals yourself.

**Signals.** With `handleSignals: true`, SIGINT and SIGTERM run `stop()` and set `process.exitCode` (0, or 1 if `stop()` failed); the process then exits by itself.
- If anything still keeps it alive `timeoutMs` + 5 s after the signal (a hung hook, an open database connection), it is force-exited.
- A second signal exits immediately with code 128 + the signal number.
- Give your process manager enough time before it sends SIGKILL. Draining and stopping cron jobs can each take up to `timeoutMs`, and Docker's default grace period is 10 s.

With `handleSignals: false` (the default), install your own handlers and call `stop()`.

**Also available:**
- `server.createApp()` builds the Express app without listening, for tests. It is idempotent.
- `server.httpServer` is the Node HTTP server while the server is started.
- `server.dependencies` and `server.config` give access to the dependencies and the resolved configuration.

## Client entry: `toto-stack/client`

Browser-safe React building blocks (no server code). Peer dependencies: `react` 18/19 and `react-router` 7/8.

```tsx
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {apiFetch, ApiError, configureApiClient, ErrorCode, NavLinkRole, Role, UserAuthState, UserProvider, useUser} from "toto-stack/client";

configureApiClient({baseUrl: "", csrfPath: "/api/auth/csrf"}); // optional; these are the defaults

type Todo = {id: number; title: string};

function Todos() {
    const {user, authStage, loading, logout} = useUser();
    if (loading) return <p>Loading…</p>;
    if (authStage !== UserAuthState.AUTHENTICATED || !user) return <p>Please sign in.</p>;

    const add = async () => {
        try {
            const data = await apiFetch<{todo: Todo}>("/api/todos", {method: "POST", body: JSON.stringify({title: "Write docs"})});
            console.log(data.todo.id);
        } catch (err) {
            if (err instanceof ApiError && err.code === ErrorCode.RATE_LIMITED) alert("Slow down");
            else throw err;
        }
    };

    return (
        <nav>
            <span>{user.username}</span>
            <NavLinkRole to="/admin" requiredRoles={[Role.ADMIN]}>Admin</NavLinkRole>
            <button onClick={add}>Add</button>
            <button onClick={() => void logout()}>Log out</button>
        </nav>
    );
}

createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
        <UserProvider>
            <Todos />
        </UserProvider>
    </BrowserRouter>,
);
```

### `apiFetch(url, options?)`

`fetch` for the toto-stack API. It resolves to the envelope's `data`, or `undefined` for 204 and empty responses.
- **Cookies and CSRF:** it sends cookies (`credentials: "include"`). For unsafe methods it attaches `X-CSRF-Token`. The token is fetched once and shared by concurrent requests, and a 403 with code `CSRF_INVALID` is retried once with a fresh token (not for streamed bodies).
- **Content-Type:** string bodies are sent as `application/json` unless you set a Content-Type. `FormData`, `Blob` and `URLSearchParams` keep the browser's.
- **`options.parse`** validates the response, for example a zod schema's `parse`. Without it, the type argument is an unchecked assertion.
- **Errors:** every failure response rejects with an **`ApiError`** carrying `status`, `code` (typed `ApiErrorCode`: one of the stack's `ErrorCode`s, including the client-side `INVALID_RESPONSE`, or your routes' own codes) and `details`. A non-JSON body (for example a proxy error page) gets `code: "INVALID_RESPONSE"`. Network errors and aborts propagate unchanged (`TypeError`/`AbortError`).

### Other exports

- **`configureApiClient({baseUrl?, csrfPath?})`:** for an API on another origin, or a different CSRF path. Call it once at startup.
- **`clearCsrfToken()`:** drops the cached token. Call it whenever the session changes outside `UserProvider`.
- **`UserProvider` / `useUser()`:** `{user, loading, authStage, setUser, setAuthStage, logout}`.
  - It loads `GET /api/auth/me` on mount. A failure leaves you signed out (`authStage: "login"`).
  - `setUser` and `setAuthStage` also drop the cached CSRF token, because the server issues a new session on login, MFA and setup.
  - `logout(): Promise<void>` posts `/api/auth/logout` and resets the local state, even if the request fails.
  - A 401 or `authStage: "login"` after an absolute or idle timeout means the session ended.
- **`NavLinkRole`:** a react-router `NavLink` rendered only for signed-in users matching `requiredRoles`. Same semantics as `hasAnyRole`; `[]` or omitted means any signed-in user.
- **Re-exports:** also exported are `Role`, `BUILTIN_ROLES`, `hasAnyRole`, `canGrantRole`, `UserAuthState`, `ErrorCode`, and the types `SessionUserType`, `UserStatusType`, `WebResponse`, `WebErrorResponse`, `BuiltinRole`, `ApiClientOptions`, `ApiFetchOptions`, `ApiErrorCode` and `UserContextType`.

Visibility is not access control: `NavLinkRole` only hides links. The server enforces roles.

## Shared entry: `toto-stack/shared`

Client-safe constants and types, with no Node or React dependencies: `Role`, `BUILTIN_ROLES`, `hasAnyRole`, `canGrantRole`, `UserAuthState` (`authenticated`, `login`, `otp`, `setup`, `setup-verify`), `ErrorCode`, `SessionUserType`, `UserStatusType`, `PrismaUserType`, `PrismaRoleType`, `WebResponse` and `WebErrorResponse`.

```ts
import {hasAnyRole, Role, type SessionUserType} from "toto-stack/shared";

export const canModerate = (user: SessionUserType | null) => hasAnyRole(user?.roles, [Role.ADMIN, "moderator"]);
```

The three entries share one module instance, so `Role` from `toto-stack` and from `toto-stack/shared` are the same object.

## Errors

Every API response uses one envelope:

```ts
type WebResponse<T> = {
    status: "success" | "error";
    message: string;
    data?: T;        // success responses
    code?: string;   // machine-readable error code: set on every error the stack sends (an ErrorCode)
    details?: unknown; // e.g. validation issues: [{path, message}]
};
```

`GET /api/health` is the only exception: health checkers expect a plain object, so it returns one. Branch on `code` in clients, never on `message`.

**`ErrorCode`** is exported from all three entries (`toto-stack`, `toto-stack/client`, `toto-stack/shared`). Every error response the stack sends carries one; your own routes may add codes of their own (`AppError(status, message, {code})`).

**Generic codes,** sent by any route, or derived from the status when nothing more specific applies:

| Code | Status | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed request (no more specific code). |
| `INVALID_JSON` | 400 | The body is not valid JSON (`"Malformed JSON request body."`). |
| `VALIDATION_FAILED` | 400 | The body failed schema validation; `details` lists `{path, message}` issues. |
| `UNAUTHORIZED` | 401 | Not signed in: no, expired or ended session, or an invalid API key. |
| `FORBIDDEN` | 403 | Signed in, but missing the required role. |
| `NOT_FOUND` | 404 | No such endpoint or resource (`"API endpoint does not exist"` under `/api`, `"Not Found"` elsewhere). |
| `CONFLICT` | 409 | Conflicts with the current state (no more specific code). |
| `PAYLOAD_TOO_LARGE` | 413 | The body exceeds `http.bodyLimit`. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Unsupported body encoding or charset. |
| `RATE_LIMITED` | 429 | A rate limit was hit; see `Retry-After`. |
| `OVERLOADED` | 503 | Too many password checks are queued (`security.passwordHashing`); retry after `Retry-After: 1`. |
| `INTERNAL_ERROR` | 500 | Unexpected server error. Details are logged, not sent. |
| `SERVICE_UNAVAILABLE` | 503 | Temporarily unavailable (no more specific code). |

**5xx responses.** In production, a 5xx carries its own message and code only if the error is exposed (`AppError(..., {expose: true})`, like `OVERLOADED`). Otherwise it gets the status text and the status's generic code (`INTERNAL_ERROR` or `SERVICE_UNAVAILABLE`). In development the real message and code are sent. Body-parser failures always get the generic messages above; the parser's detail goes only to the log.

**Specific codes:**

| Code | Status | Meaning |
|---|---|---|
| `CSRF_INVALID` | 403 | Missing or invalid `X-CSRF-Token`. Fetch a new token from `GET /api/auth/csrf` and retry (`apiFetch` does this). |
| `ORIGIN_NOT_ALLOWED` | 403 | The `Origin` header isn't in the allowlist. |
| `BEARER_NOT_ALLOWED` | 400 | A session-only endpoint was called with `Authorization: Bearer`. |
| `SETUP_COMPLETED` | 403 | Setup is already done (also when a concurrent setup won). |
| `SETUP_TOKEN_INVALID` | 403 | Wrong setup token. |
| `SETUP_TOKEN_CHANGED` | 403 | The setup token changed since `/setup/start` (for example a restart with a generated token); start again. |
| `SETUP_NOT_STARTED` | 400 | `/setup/verify` without a live `/setup/start`. |
| `MFA_NOT_PENDING` | 401 | `/login/verify` without a live pending MFA login; log in again. |
| `MFA_INVALID` | 400 | Wrong, expired or already used TOTP code (account endpoints). |
| `MFA_ALREADY_ENABLED` | 409 | |
| `MFA_NOT_ENABLED` | 409 | |
| `MFA_ENROLLMENT_NOT_STARTED` | 400 | `/account/mfa/verify` without a live `/account/mfa/start`. |
| `PASSWORD_CONFIRMATION_FAILED` | 403 | The current password given for a sensitive change is wrong. |
| `USERNAME_TAKEN` | 409 | |
| `ROLE_NOT_GRANTABLE` | 403 | Only an owner may grant `owner`/`admin`. |
| `INVALID_USER_ID` | 400 | |
| `USER_NOT_FOUND` | 404 | |
| `CANNOT_DELETE_SELF` | 400 | |
| `USER_PROTECTED` | 403 | Owners can't be deleted; admins can't delete admins. |
| `NO_HANDLERS` | 503 | The scaffolded app's `POST /api/notifications/send` with no handler configured. |
| `UNKNOWN_HANDLER` | 400 | `handlers` names an unknown id; `details.unknown` lists them. |
| `DELIVERY_FAILED` | 502 | Every targeted handler failed; `details.results` has the per-handler flags. |
| `INVALID_RESPONSE` | (client only) | `apiFetch`: the response wasn't the API's JSON envelope, e.g. a proxy's HTML error page. Never sent by the server. |

A wrong password or TOTP code at login is **not** an error. `POST /api/auth/login` answers 200 with `authState: "login"` (wrong credentials) or `"otp"` (MFA required); `/login/verify` answers `"otp"` again for a wrong code.

## Testing your app

`server.createApp()` returns the Express app without listening, so you can drive it with supertest. Use `NODE_ENV=test` (development mode) and a real test database, or any object that satisfies `StackPrismaClient`.

```ts
import request from "supertest";
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js";
import {routes} from "./routes/index.js";

const app = await createServer({prisma, routes, security: {setupToken: "test-setup-token-0123"}}).createApp();
const res = await request(app).get("/api/status");
console.log(res.status, res.body.message);
```

## Further documentation

- [API reference](https://github.com/totoluto/toto-stack/blob/master/docs/api.md): every endpoint, request and response.
- [Security model](https://github.com/totoluto/toto-stack/blob/master/docs/security.md): threat model, sessions, CSRF, passwords, TOTP, rate limits, limitations.
- [Configuration details](https://github.com/totoluto/toto-stack/blob/master/docs/configuration.md): middleware order, CSP, static files, sessions, multiple instances.
- [Deployment](https://github.com/totoluto/toto-stack/blob/master/docs/deployment.md): Docker, Compose, Traefik, migrations.
- [Upgrading](https://github.com/totoluto/toto-stack/blob/master/docs/upgrading.md): versioning policy and schema changes.
- [Troubleshooting](https://github.com/totoluto/toto-stack/blob/master/docs/troubleshooting.md)
- [Security policy](https://github.com/totoluto/toto-stack/blob/master/SECURITY.md): reporting vulnerabilities.

## License

MIT
