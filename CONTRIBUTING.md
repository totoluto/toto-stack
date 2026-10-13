# Contributing

Thanks for your interest in improving toto-stack. This guide covers the development setup, the conventions in use, and how releases work.

To report a security vulnerability, **don't open an issue**; follow [SECURITY.md](SECURITY.md).

## Development setup

**Requirements:**
- **Node.js ≥ 22.12.** CI tests 22.12.0, 22.x, 24.x and 26.x, and `.nvmrc` selects 24. Building with tsdown is smoothest on Node ≥ 22.18; earlier 22.x versions work but print `EBADENGINE` warnings at install.
- **npm**, which comes with Node. The repository uses npm workspaces and a v3 lockfile; please don't commit pnpm, Yarn or Bun lockfiles.
- **Docker** for the MariaDB integration tests and for running the template app locally. On macOS, Docker Desktop or [Colima](https://github.com/abiosoft/colima) (`colima start`) both work.

```bash
git clone https://github.com/totoluto/toto-stack.git
cd toto-stack
npm ci
npm run build:stack
npm run check
```

**Repository layout:**
- `packages/stack`: the `toto-stack` package.
  - `src/`: the server code.
  - `src/client/` and `src/client.ts`: the `toto-stack/client` entry.
  - `src/shared/` and `src/shared.ts`: the `toto-stack/shared` entry.
  - `prisma/base.prisma`: the models apps copy.
  - `tests/`: the test suites. They also cover the template's code: the test servers mount the template's `server/routes` (so the user management and notification tests exercise those files), and `tests/template` tests its client components (happy-dom).
- `packages/create-toto-app`: the CLI (`index.js`, zero dependencies) and its tests (`test/`).
- `packages/create-toto-app/template`: the generated app. It is a workspace member, so in this repository it consumes the local `toto-stack` build exactly like an app consumes the published package.
- `scripts/`: repository tooling, such as the packed-artifact tests.
- `docs/`: user documentation.

## Scripts and test suites

The root scripts and test suites are listed in the [README](README.md#developing-this-repository). In short:

| Command | When |
|---|---|
| `npm run build:stack` | Before running the template, typechecking it, or running the tests that use `dist/` |
| `npm run check` | Before every pull request: build, lint, typecheck, tests, template build |
| `npm run test:integration` | When touching sessions, setup, users, the Prisma contract or the schema. Needs MariaDB; see the README. |
| `npm run test:artifact` | When touching packaging: `package.json` `exports`/`files`, the build config, dependencies |
| `npm run test:scaffold` | When touching the CLI or the template (`-- --db-url …` boots the app; `--docker` builds the images) |

**CI** runs the unit tests on Node 22.12.0, 22.x, 24.x and 26.x. The CLI tests also run on **Windows**, so keep `create-toto-app` free of POSIX-only paths and shell commands. Dependabot proposes updates for npm dependencies, GitHub Actions, and the template's Node base image and Compose images.

**Writing tests:**
- **Bug fixes** come with a regression test.
- **New suites** go in new files grouped by topic (`packages/stack/tests/<topic>/*.test.ts`).
- **Fakes:** HTTP tests use the in-memory fake Prisma client (`tests/fakePrisma.ts`). Each test app gets its own fake database, and tests must not depend on their order; `npm run test:shuffle -w toto-stack` checks that.
- **Real database:** behaviour that depends on real database semantics (transactions, unique constraints, JSON columns) belongs in the integration suite.

## Coding conventions

- **TypeScript strict mode** everywhere. Avoid `any`, non-null assertions on request data, and casts that hide real type errors. In routes, use `this.currentUser(req)` rather than `req.user!`.
- **Formatting:** follow the style of the file you edit (4-space indentation, double quotes, `import {x} from "y"` without spaces inside braces in the stack). Don't reformat files wholesale. ESLint (`npm run lint`) must pass.
- **Imports:**
  - Inside `packages/stack/src`, use the `@server/*` and `@shared/*` path aliases.
  - Every runtime import must be a declared `dependency` or `peerDependency`. The build fails if code from `node_modules` would be bundled.
  - Re-export types with `export type {…}`.
- **Public API:** everything exported from `src/index.ts`, `src/client.ts` and `src/shared.ts` is public contract.
  - Export services as types only.
  - Keep `client` and `shared` free of Node and server code.
  - Changing the public API needs a changeset that says so.
- **Errors:**
  - Send errors through `AppError`/`sendError` in the standard envelope.
  - New client-visible error conditions get a stable `code` in `ErrorCode` (`packages/stack/src/shared/errorCodes.ts`, exported from all three entries).
  - Every error response the stack sends carries a code; unexposed 5xx errors send only the status's generic code.
  - Never return internal or remote error text to clients.
- **Validation:** request bodies are validated with strict zod schemas, through the `BaseRoute` helpers.
- **Logging:** use `new Logger("Service")`, not `console`. Never log secrets, tokens, password hashes or raw usernames in security contexts.
- **Configuration:** new settings go through `StackConfig` and `resolveConfig`, which also handles any environment fallback. Code outside the config layer doesn't read `process.env`. Invalid values become `ConfigError` issues.
- **No custom cryptography.** Use established libraries (`@node-rs/argon2`, otplib) and standard `node:crypto` primitives (AES-GCM, HMAC, HKDF, `timingSafeEqual`, `randomBytes`). Don't implement algorithms or invent formats; see [Cryptography](docs/security.md#cryptography).
- **No import-time side effects.** The package is `sideEffects: false`; timers start in `start()` and stop in `stop()`.
- **Schema changes:**
  - Change `packages/stack/prisma/base.prisma` and the models in the template's `prisma/schema.prisma` together.
  - Add a template migration.
  - Describe the change in the changeset ([upgrade procedure](docs/upgrading.md#schema-changes)).
- **Documentation:**
  - Update the README, `docs/` and the changeset in the same pull request as the behaviour change.
  - Code snippets in the docs must compile against the package.

### Why there are `overrides` in two places

`@prisma/adapter-mariadb@7.10.0` pins a `mariadb` driver version with known vulnerabilities, and pulls in other affected transitive versions. npm `overrides` replace them (`mariadb`, `mysql2`, `deepmerge-ts`).

**npm honours `overrides` only in the root `package.json` of the project being installed**, so the override has to live in two places:
- **The root `package.json`** covers installs of this monorepo, including the template as a workspace member. npm ignores overrides in workspace `package.json` files.
- **The template's `package.json`** ships the same overrides to every generated app, where the app is the root project.

Keep the two blocks identical, and remove both once Prisma updates its pin. Check with `npm ls mariadb` and `npm audit --omit=dev`, in the repository and in a freshly scaffolded app.

## Commits and pull requests

- Use **[Conventional Commits](https://www.conventionalcommits.org/)**: `type(scope): summary`.
  - Types in use: `feat`, `fix`, `perf`, `refactor`, `test`, `build`, `ci`, `docs`, `chore`.
  - Mark breaking changes with `!` (`fix(sessions)!: …`) and explain them in the body.
- Keep commits small and logical.
- Before opening a pull request, run `npm run check`.
- Add a changeset for any user-visible change (below).

## Changesets

Releases are managed with [Changesets](https://github.com/changesets/changesets). For every pull request that changes published behaviour (`toto-stack`, `create-toto-app` or the template it ships), add a changeset:

```bash
npm run changeset
```

1. Pick the affected package(s) and the bump. While we are on 0.x, use **minor** for anything breaking, including Prisma schema changes, and **patch** for everything else.
2. Write the summary for users: what changed, and what they must do.
3. Call out schema changes and breaking changes explicitly.

The two packages form a **fixed group**: they are always released together with the same version. The CLI stamps that version into generated apps as `toto-stack: ^<version>`.

Docs-only and test-only changes don't need a changeset. The changelogs (`packages/*/CHANGELOG.md`) are written by Changesets from then on. Each has a hand-written `0.1.0` entry for the initial release, which has no changeset; don't edit them otherwise.

## Releases

The full procedure, including the workflow's gates, is in [`.github/RELEASING.md`](.github/RELEASING.md). In short, publishing happens only from GitHub Actions, except for the very first, manual publish:

1. Merged changesets accumulate on `master`. On every push, [`release.yml`](.github/workflows/release.yml) opens or updates a **"chore(release): version packages"** pull request (`npm run version-packages`). It bumps both versions, writes the changelogs, updates the template's `toto-stack` range and refreshes the lockfile.
2. A maintainer reviews and merges that pull request.
3. The workflow then runs `npm run check` on the merged commit, packs both packages, and publishes them with **npm trusted publishing** (GitHub OIDC, in the `npm` environment) with provenance. No long-lived npm token exists. It then pushes the `toto-stack@x.y.z` and `create-toto-app@x.y.z` tags and creates GitHub releases.

### One-time maintainer setup

These steps need the maintainer's npm and GitHub accounts and **can't be automated**. Nothing is published until all of them are done; see [`.github/RELEASING.md`](.github/RELEASING.md#one-time-setup-maintainer).

1. **Make the repository public.** npm provenance (which the workflow requires) and GitHub private vulnerability reporting both need a public repository.
2. **Enable two-factor authentication** on the npm account that will own the packages (`npm profile enable-2fa auth-and-writes`).
3. **Publish 0.1.0 by hand.** npm can only configure a trusted publisher for a package that already exists. The first release stays **0.1.0** and has no changeset.
   - From a clean checkout of `master`, run `npm ci && npm run check`.
   - Then `npx changeset publish`, which publishes both packages, asks for the 2FA code and creates the tags, and `git push --follow-tags`.
   - Don't merge a version pull request before this, or the first version becomes 0.1.1.
4. **Configure the trusted publisher** for each package. On npmjs.com, go to *Package → Settings → Trusted publishing → GitHub Actions* and enter:
   - user `totoluto`;
   - repository `toto-stack`;
   - workflow file `release.yml`;
   - environment `npm`.

   Then set *Publishing access* to "Require two-factor authentication and disallow tokens".
5. **On GitHub:**
   - create the `npm` environment, restricted to `master`, optionally with required reviewers;
   - allow GitHub Actions to create pull requests;
   - set the repository variable `NPM_PUBLISH_ENABLED=true`;
   - protect `master` (required reviews and status checks);
   - enable private vulnerability reporting and code scanning (then `CODE_SCANNING_ENABLED=true`);
   - fill in the fallback contact in [SECURITY.md](SECURITY.md).

After that, every release goes through the version pull request.
