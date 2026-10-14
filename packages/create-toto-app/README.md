# create-toto-app

Scaffolds a new [toto-stack](https://github.com/totoluto/toto-stack/tree/master/packages/stack#readme) app: an Express 5 + Prisma 7 backend with login, TOTP MFA, sessions, roles, CSRF protection, rate limiting and user management, plus a React client. Docker files for local development and production are included.

Requires Node.js ≥ 22.12. The generated app uses MariaDB, which can run in Docker locally (Docker Engine 20.10+ with Docker Compose v2.1+).

## Usage

```bash
npm create toto-app@latest my-app
# or
npx create-toto-app my-app
```

```
Usage: npm create toto-app@latest <directory> [-- options]
       npx create-toto-app <directory> [options]

Creates a new toto-stack app in <directory> (a valid npm package name),
or in the current directory when <directory> is "." (it must be empty).

Options:
  --git          Initialize a git repository in the new app (default)
  --no-git       Do not initialize a git repository
  -h, --help     Show this help
  -v, --version  Show the create-toto-app version
```

- **Directory name:** `<directory>` becomes the package name. It must be lowercase and use only letters, digits, `-`, `_` and `.`. Use `.` to scaffold into the current, empty directory, which is then named after the directory.
- **Options with `npm create`:** pass them after `--`, for example `npm create toto-app@latest my-app -- --git`.
- **Failures:** the CLI refuses non-empty directories and existing files. If scaffolding fails, it removes what it created.
- **Package manager:** the CLI detects the one you invoked it with (npm, pnpm, Yarn, Bun) and prints matching next steps.
- **Colour:** output is plain when it isn't a terminal or `NO_COLOR` is set.

## Next steps

After scaffolding, with npm:

```bash
cd my-app
npm install                      # installs dependencies and generates the Prisma client
docker compose up -d --wait db   # local MariaDB (or point .env at your own)
npm run db:deploy                # applies the database migrations
npm run dev                      # client on :3000, API on :3001
```

| | pnpm | Yarn | Bun |
|---|---|---|---|
| install | `pnpm install` | `yarn` | `bun install` |
| run a script | `pnpm db:deploy`, `pnpm dev` | `yarn db:deploy`, `yarn dev` | `bun run db:deploy`, `bun run dev` |

Then open http://localhost:3000/login and create the **owner** account:
1. Enter a username, a password of at least 10 characters, and the **`SETUP_TOKEN` from `.env`**.
2. Scan the QR code with an authenticator app and confirm with a code.

**Other package managers:**
- **pnpm:** if it reports skipped build scripts, run `pnpm approve-builds` and approve `prisma`, `@prisma/engines` and `esbuild`.
- **Overrides with pnpm and Yarn:** both ignore npm's `overrides`. Move the block to `pnpm.overrides` or `resolutions`. Bun reads `overrides` as is. See [Troubleshooting](https://github.com/totoluto/toto-stack/blob/master/docs/troubleshooting.md#overrides-with-pnpm-yarn-or-bun).
- **The Dockerfile installs with npm.** Commit a `package-lock.json` (`npm install --package-lock-only`) for reproducible images.

## What gets generated

```
my-app/
├── client/                      React 19 + Vite + react-router: login, MFA, setup and settings screens, layout
├── server/
│   ├── index.ts                 createServer({...}): add your services, jobs and hooks here
│   ├── routes/                  the app's API routes (users, notifications, status): yours to edit
│   └── prisma.ts                Prisma client with the MariaDB driver adapter
├── prisma/
│   ├── schema.prisma            toto-stack's models (User, Role, UserRole, Session, SetupLock): add your own
│   └── migrations/              the initial migration (0_init)
├── prisma.config.ts             Prisma 7 config (connection built from MYSQL_* in .env)
├── scripts/                     esbuild server bundle, dev NODE_ENV preload
├── docker/db-init-dev/          dev-only DB init (lets `prisma migrate dev` create its shadow database)
├── docker-compose.yml           MariaDB (development and production)
├── docker-compose.override.yml  development additions (loaded automatically)
├── docker-compose.prod.yml      production: migrations, app, Traefik with HTTPS
├── Dockerfile                   multi-stage build (runtime and migrate targets)
├── sample.env                   every setting, documented
├── .env                         generated, with random secrets (mode 0600, git-ignored)
├── .gitignore
└── package.json                 depends on toto-stack ^<this CLI's version>
```

**The generated `.env`** is `sample.env` with fresh random values for:
- `SESSION_SECRET` (48 bytes);
- `SETUP_TOKEN`;
- `OTP_ENCRYPTION_KEY` (32 bytes, hex);
- `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD`.

The first run therefore works without editing anything. It contains secrets: don't commit it, and **generate new values for production**. Keep `OTP_ENCRYPTION_KEY` stable and backed up: changing or losing it breaks MFA sign-in for every enrolled user.

**API routes.** The `toto-stack` package provides the sign-in flow (`/api/auth/*`), the signed-in user's account endpoints (`/api/account/*`) and `/api/health`. Everything else is app code in `server/routes`, registered in `server/index.ts` through `createServer({routes})`:

| File | Endpoints |
|---|---|
| `server/routes/UsersRoute.ts` | `GET`/`POST /api/users`, `DELETE /api/users/:id` (admins and owners) |
| `server/routes/NotificationRoute.ts` | `GET /api/notifications/handlers`, `POST /api/notifications/send` (admins and owners) |
| `server/routes/StatusRoute.ts` | `GET /api/status` (public) |

Change, remove or add routes there; add new ones to the list in `server/routes/index.ts`. The comments in `UsersRoute.ts` and `NotificationRoute.ts` list the security rules to keep. See [Routes](https://github.com/totoluto/toto-stack/tree/master/packages/stack#routes) for `BaseRoute` and the [API reference](https://github.com/totoluto/toto-stack/blob/master/docs/api.md) for the endpoints.

**Overrides.** `package.json` contains npm `overrides` that replace vulnerable driver versions pinned by `@prisma/adapter-mariadb`. Keep them until Prisma updates its pin.

## Scripts in the generated app

| Script | Description |
|---|---|
| `dev` | Server (`tsx watch`, `NODE_ENV=development` unless set) and Vite client together |
| `dev:server`, `dev:client` | Either one alone |
| `build` | `prisma generate`, then the client (Vite), then the server bundle into `dist/` |
| `start` | `node dist/server.js` (production mode unless `NODE_ENV` says otherwise; reads `.env` if present) |
| `typecheck` | `tsc` for the server and the client |
| `db:deploy` | `prisma migrate deploy`: apply committed migrations |
| `db:migrate` | `prisma migrate dev`: create a migration after changing `schema.prisma` |
| `db:generate` | `prisma generate` |
| `db:studio` | `prisma studio` |
| `postinstall` | Runs automatically: `scripts/generate.js` generates the Prisma client, or prints a notice and skips when the Prisma CLI (a dev dependency) isn't installed, as in production installs |

Prisma 7's `migrate dev` doesn't regenerate the client. After `npm run db:migrate`, run `npm run db:generate`; `npm run dev` doesn't do it for you.

## Docker workflow

**Development.** Only the database runs in Docker, and the app runs on your machine:

```bash
docker compose up -d --wait db
```

The development override publishes MariaDB on `127.0.0.1:${MYSQL_PORT}` and grants the shadow-database rights `prisma migrate dev` needs.

**Production.** On a server with Docker, set `DOMAIN`, `ACME_EMAIL` and fresh secrets in `.env`, then run:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

This starts MariaDB, then a one-shot `migrate` container (`prisma migrate deploy`), then the app (non-root, with a healthcheck on `/api/health` and a 30 s stop grace period for graceful shutdown), then Traefik. Traefik serves HTTPS with Let's Encrypt and compresses responses. Set `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` in the server's `.env` to shorten the command to `docker compose up -d --build`.

See [Deployment](https://github.com/totoluto/toto-stack/blob/master/docs/deployment.md) for the required variables, updates, backups and the Docker socket caveat.

## Updating an app

The `toto-stack` dependency carries the framework: authentication, sessions, security middleware and the client helpers.
- `npm update toto-stack` installs patch releases.
- New minor versions (0.x → 0.y) may be breaking. Install them deliberately, following the [upgrading guide](https://github.com/totoluto/toto-stack/blob/master/docs/upgrading.md).

Everything this CLI copied (UI, server entry and routes, Docker files, schema) is yours: it doesn't update automatically.

## License

MIT
