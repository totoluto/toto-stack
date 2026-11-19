---
title: Quick start
description: Generate an app, start MariaDB, and create the first owner account.
sidebar:
  order: 1
---

The scaffolder creates an Express 5 + Prisma 7 server and a React 19 + React Router 8 client, with authentication, account settings, database migrations, and Docker files already connected.

## Requirements

- Node.js **22.22.0 or newer** and npm.
- MariaDB or MySQL. The generated app runs MariaDB locally through Docker.
- For the Docker workflow: Docker Engine 20.10+ and Docker Compose v2.1+.

## Create and run an app

```bash
npm create toto-app@latest my-app
cd my-app
npm install
docker compose up -d --wait db
npm run db:deploy
npm run dev
```

`npm install` generates the Prisma client. The database command applies the committed initial migration. Development runs the client on port **3000** and the API on **3001**; Vite proxies `/api` to the server.

The CLI creates a git-ignored `.env` with random session, setup, TOTP-encryption, and database secrets. Do not commit it. If you use another database, update `MYSQL_*` in `.env` before applying migrations.

## Create the owner

1. Open `http://localhost:3000/login`.
2. Enter a username, a password of at least 10 characters, and the **`SETUP_TOKEN` from `.env`**.
3. Scan the QR code with an authenticator app and confirm a current code.

The owner always enrolls MFA during setup. Keep access to the authenticator and back up `OTP_ENCRYPTION_KEY`: changing or losing the encryption key breaks sign-in for users with encrypted MFA secrets.

If you start a server without `SETUP_TOKEN` and no user exists yet, it prints a one-time token directly to stderr. That token changes on restart. See [Authentication](/toto-stack/guides/authentication/).

## Make your first change

- Add API routes under `server/routes`, then register them in `server/routes/index.ts`. Start with [Routes](/toto-stack/guides/routes/).
- Add models to `prisma/schema.prisma`, keeping the stack's existing models and fields. After changing the schema, run:

  ```bash
  npm run db:migrate -- --name add-feature
  npm run db:generate
  ```

  Prisma 7 does not regenerate the client after `migrate dev`.
- Edit the client in `client/`. Use [client helpers](/toto-stack/guides/client/) for authenticated requests and CSRF handling.
- Add services, background jobs, and hooks in `server/index.ts`.

Run `npm run typecheck` and `npm run build` before deploying. The full list of generated scripts is in the [CLI reference](/toto-stack/reference/cli/).

## Before production

Generate fresh production secrets, serve HTTPS through a trusted proxy, and apply migrations before starting the new app. Follow [Deployment](/toto-stack/operate/deployment/) rather than exposing the development server.

For pnpm or Yarn, move the generated dependency overrides to your package manager's supported field. For pnpm build approval, native-module failures, or database setup errors, see [Troubleshooting](/toto-stack/maintain/troubleshooting/).

## Already have an app?

Install the framework directly when integrating an existing Express/Prisma application. The steps below assume ESM TypeScript, Node.js 22.22.0+, and a MySQL or MariaDB database. Express 5, express-session, helmet, zod 4, and Express type definitions ship as regular stack dependencies; add `zod@^4` to your own dependencies if your app defines request schemas.

```bash
npm install toto-stack @prisma/client@^7 @prisma/adapter-mariadb@^7
npm install --save-dev prisma@^7
```

> Keep both `prisma` and `@prisma/client` on `^7`; unpinned installs can select an unsupported major.

The Prisma CLI is a dev dependency: in production you only run `prisma migrate deploy`, from a build or migration image (the scaffolded app ships one).

Generated apps retain npm `overrides` for affected Prisma adapter transitive dependencies. Copy the same block into your app's root `package.json` until the upstream pins have been updated:

```json
{
  "overrides": {
    "mariadb": "^3.5.4",
    "mysql2": "^3.24.5",
    "deepmerge-ts": "^8.0.2"
  }
}
```

npm applies `overrides` only from the root `package.json`. pnpm and Yarn ignore it and use their own fields (`pnpm.overrides`, `resolutions`), while Bun reads `overrides` as is. See [Troubleshooting](/toto-stack/maintain/troubleshooting/#overrides-with-pnpm-yarn-or-bun).

### Prisma schema

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

   - `migrate dev` needs a throwaway **shadow database**. The database user must be allowed to create one, or you set `shadowDatabaseUrl`; see [Troubleshooting](/toto-stack/maintain/troubleshooting/#prisma-migrate-dev-fails-creating-the-shadow-database).
   - In production, apply the committed migrations with `npx prisma migrate deploy`.
   - When a toto-stack release changes `base.prisma`, follow the [schema change procedure](/toto-stack/maintain/upgrading/#schema-changes).

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

### Start the server

Follow the [minimal server and lifecycle example](/toto-stack/start/architecture/#server-lifecycle). Add `frontend: {dir: absolutePathToBuiltSpa}` to serve a client, or omit it for an API-only server. Run locally with `NODE_ENV=development`; production needs `SESSION_SECRET`, `ALLOWED_ORIGINS`, HTTPS, and a correctly trusted proxy. The framework does not load your app's `.env` file for you.

