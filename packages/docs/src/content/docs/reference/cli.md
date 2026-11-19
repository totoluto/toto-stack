---
title: CLI reference
description: Scaffolder options, generated files and secrets, package managers, and application scripts.
sidebar:
  order: 1
---

`create-toto-app` copies a complete application template and generates local secrets. It does not install dependencies, apply migrations, or update an existing application. Follow [Quick start](/toto-stack/start/quick-start/) for the complete first-run workflow.

Requires Node.js **22.22.0 or newer**.

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

App names must start with a letter or digit, be at most 214 characters, and contain no path separators or scope. Names such as `node_modules` and `favicon.ico` are rejected. For `.` the CLI derives a valid package name from the current directory. Existing `.git`, `.DS_Store`, and `Thumbs.db` entries do not prevent scaffolding; application files do.

## Generated files

```
my-app/
├── client/                      React 19 + Vite + react-router: login, MFA, setup and settings screens, layout
├── server/
│   ├── index.ts                 createServer({...}): add your services, jobs and hooks here
│   ├── routes/                  the app's API routes (notifications, status): yours to edit
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



The framework owns auth, account security, user management and readiness. The generated `server/routes` contains **only notifications and status**, registered in `server/routes/index.ts`; those implementations belong to your app. See [Architecture](/toto-stack/start/architecture/).

## Package managers

| Task | npm | pnpm | Yarn | Bun |
|---|---|---|---|---|
| Install | `npm install` | `pnpm install` | `yarn` | `bun install` |
| Apply migrations | `npm run db:deploy` | `pnpm db:deploy` | `yarn db:deploy` | `bun run db:deploy` |
| Develop | `npm run dev` | `pnpm dev` | `yarn dev` | `bun run dev` |

pnpm may require `pnpm approve-builds` for Prisma engines and esbuild. pnpm and Yarn do not use npm's `overrides` field; move it to `pnpm.overrides` or `resolutions`. Bun reads `overrides` directly. See [package-manager troubleshooting](/toto-stack/maintain/troubleshooting/#package-managers).

The Dockerfile uses npm. Commit a `package-lock.json` for reproducible images, or adapt the Dockerfile to your package manager.

## Application scripts

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

## Updating generated applications

The CLI is not a template updater. Update `toto-stack` as a dependency, migrate copied Prisma models when necessary, and port selected changes to copied UI, scripts, and deployment files yourself. Follow [Upgrading](/toto-stack/maintain/upgrading/).
