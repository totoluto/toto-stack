# create-toto-app

## 0.1.2

### Patch Changes

- Refine Changesets configuration, update Git ignore rules, and improve script defaults [#13](https://github.com/totoluto/toto-stack/pull/13) by [@totoluto](https://github.com/totoluto)

## 0.1.1

No changes in this release.

## 0.1.0

Initial release: scaffolds a ready-to-run toto-stack app (`npm create toto-app@latest <directory>`).

- **CLI:**
  - Zero dependencies, with `--help`, `--version` and `--git`, and `.` for the current directory.
  - Validates the app name, cleans up after a failed run, and prints next steps for npm, pnpm, Yarn or Bun.
- **Generated app:**
  - A `.env` with random `SESSION_SECRET`, `SETUP_TOKEN`, `OTP_ENCRYPTION_KEY` and database passwords.
  - Depends on `toto-stack` at the same version as the CLI.
- **Template:**
  - React 19 + Vite client with accessible login, MFA and setup screens (setup token field). The one-time-code input supports typing, Backspace, arrow keys, paste and one-time-code autofill, and submits once.
  - App-owned API routes in `server/routes`: user management (`/api/users`), notifications (`/api/notifications`) and status (`/api/status`), registered with `createServer({routes})`.
  - ESM server bundle (esbuild).
  - Prisma 7 schema and initial migration (`0_init`) for MariaDB.
  - npm `overrides` for vulnerable transitive driver versions.
- **Docker:**
  - Multi-stage Dockerfile with a lean, non-root runtime image, a healthcheck and a separate `migrate` target.
  - Compose files for development (MariaDB) and production (one-shot migrations, the app with a 30 s stop grace period, and Traefik with HTTPS and compression). Requires Docker Engine 20.10+ and Compose v2.1+.
  - `postinstall` generates the Prisma client and skips cleanly in production installs.
