# toto-stack

A security-focused foundation for full-stack TypeScript web apps on Express 5, Prisma 7 and React. It provides:

- Authentication with TOTP MFA, sessions and role-based access control.
- CSRF protection, an origin allowlist and rate limiting.
- User and API-key management.
- Background jobs, notifications and logging.

Everything is pre-wired, so you start with your own routes and screens.

> **Status: 0.x, pre-1.0.** A minor release may contain breaking changes; see [Upgrading](docs/upgrading.md).

## Packages

| Package | Description |
|---|---|
| [`toto-stack`](packages/stack) | The framework: server core (`toto-stack`), React building blocks (`toto-stack/client`) and client-safe shared types (`toto-stack/shared`). [Documentation](packages/stack/README.md). |
| [`create-toto-app`](packages/create-toto-app) | Scaffolder that generates a ready-to-run app: React client, server entry, Prisma schema and migration, Docker/Compose/Traefik setup and a `.env` with generated secrets. [Documentation](packages/create-toto-app/README.md). |
| [`packages/create-toto-app/template`](packages/create-toto-app/template) | The app template. It is also a workspace member, used as the live example app while developing the framework. |

## Quick start

Requires Node.js ≥ 22.12 and Docker (for the local MariaDB).

```bash
npm create toto-app@latest my-app
cd my-app
npm install                      # also generates the Prisma client
docker compose up -d --wait db   # local MariaDB
npm run db:deploy                # applies the migrations
npm run dev                      # client on http://localhost:3000, API on :3001
```

Open http://localhost:3000/login and create the owner account with the `SETUP_TOKEN` from the generated `.env`. Setup also enrolls an authenticator app. The [create-toto-app README](packages/create-toto-app/README.md) covers other package managers, the generated files and production deployment.

## Supported environments

| | Supported |
|---|---|
| Node.js | `>=22.12` |
| Module format | ESM only. CommonJS apps load it through `require(esm)` (Node ≥ 22.12). |
| Prisma | 7.x (`prisma@^7`, `@prisma/client@^7`). Prisma 8 is not supported, and npm's `latest` tag for `prisma` is currently an 8.x pre-release. |
| Database | MySQL / MariaDB through `@prisma/adapter-mariadb` |
| Client entry | React 18 or 19 with `react-router` 7 or 8 |
| Production | Behind a TLS-terminating reverse proxy |

## Documentation

- [`toto-stack` README](packages/stack/README.md): install, schema, configuration and environment reference, routes, services, roles, jobs, client.
- [API reference](docs/api.md): every endpoint, framework-provided and template-provided.
- [Security model](docs/security.md): threat model, sessions, CSRF, API keys, passwords, TOTP, rate limits, limitations.
- [Configuration details](docs/configuration.md): request pipeline, CSP, static files, sessions.
- [Deployment](docs/deployment.md): Docker Compose, Traefik, migrations, operations.
- [Upgrading](docs/upgrading.md): versioning policy, schema changes.
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md) and [Security policy](SECURITY.md)

## Developing this repository

This is an npm workspaces monorepo (npm with lockfile v3; don't use other package managers here). The template is a workspace member that consumes the **built** `toto-stack`, so build the stack before running or typechecking the template.

```bash
npm ci                 # also generates the template's Prisma client
`npm run build:stack `   # the template imports toto-stack's dist/
npm run dev            # runs the template app (client :3000, API :3001)
```

### Root scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the template app in development mode (Vite client and `tsx watch` server). The template needs its `.env` and a database; see below. |
| `npm run build` | `build:stack`, then `build:app`. |
| `npm run build:stack` | Builds `toto-stack` with tsdown into `packages/stack/dist`. |
| `npm run build:app` | Builds the template: Prisma client, Vite client, esbuild server bundle. |
| `npm run lint` | ESLint over the repository. |
| `npm run typecheck` | `tsc` for the stack, then for the template (server and client configs). |
| `npm test` | The stack's unit and HTTP tests (vitest + supertest), then the CLI tests (`node:test`). |
| `npm run check` | `build:stack`, `lint`, `typecheck`, `test`, `build:app`. CI runs this. |
| `npm start` | Starts the built template app (`node dist/server.js`). |
| `npm run audit` | `npm audit`. |

Release scripts (`npm run changeset` and the release tooling) are described in [CONTRIBUTING.md](CONTRIBUTING.md#changesets).

### Test suites

| Command | Needs | What it covers |
|---|---|---|
| `npm test` | nothing | Stack unit and HTTP tests against an in-memory fake Prisma client, plus the CLI tests. Some stack tests use the built `dist/`, so run `build:stack` first. |
| `npm run test:coverage` | nothing | The stack tests with v8 coverage and thresholds |
| `npm run test:shuffle -w toto-stack` | nothing | The stack tests in random order (no order dependencies) |
| `npm run test:integration` | MariaDB 11 and `TOTO_TEST_DATABASE_URL` | Stack tests against the real Prisma 7 client and the template's real migration. The database is **dropped and recreated**, so its name must contain `test`. Without the variable the suite is skipped; `TOTO_TEST_DB_REQUIRED=1` makes that a failure. |
| `npm run test:artifact` | network on first run | Packs both packages and tests the tarballs as npm users get them: contents, publint/attw, ESM and `require(esm)` imports, consumer typechecks, browser build of the client entry. `-- --node 22,24,26` repeats the runtime checks on other Node versions. |
| `npm run test:scaffold` | network | Scaffolds an app with the packed CLI, installs it against the packed stack, then runs audit, typecheck and build. Options (after `--`):<br>`--db-url mysql://…/…test…` (or `TOTO_TEST_DATABASE_URL`) also migrates, boots the server, and checks health, the SPA, the setup token and SIGTERM.<br>`--docker` builds the `runtime` and `migrate` images.<br>`--docker-db <container>` also runs them against that MariaDB container. |

A disposable MariaDB for the database-backed suites:

```bash
docker run -d --rm --name toto-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=toto_test -p 127.0.0.1:3307:3306 mariadb:11
TOTO_TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/toto_test npm run test:integration
npm run test:scaffold -- --db-url mysql://root:test@127.0.0.1:3307/toto_test
docker stop toto-mariadb-test
```

### Running the template app locally

The template workspace reads `packages/create-toto-app/template/.env`, which is git-ignored and never packed:

```bash
cd packages/create-toto-app/template
cp sample.env .env    # then replace the SESSION_SECRET placeholder and set SETUP_TOKEN and both MYSQL_* passwords
docker compose up -d --wait db
npm run db:deploy
cd ../../.. && npm run dev
```

More details, including conventions and the release process, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

Releases are managed with [Changesets](https://github.com/changesets/changesets). `toto-stack` and `create-toto-app` always share one version. A GitHub Actions workflow publishes them to npm with trusted publishing (OIDC) and provenance. After the first release, which is published manually, nobody publishes from a laptop. See [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## License

[MIT](LICENSE)
