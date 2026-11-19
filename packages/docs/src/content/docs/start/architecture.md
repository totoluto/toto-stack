---
title: Architecture
description: Understand framework boundaries, package entries, the Prisma contract, and server lifecycle.
sidebar:
  order: 2
---

toto-stack is an application foundation, not an identity provider or a hosted service. You own the application, database, deployment, and copied template files. The package supplies the security-sensitive server foundation and browser-safe helpers.

## Package and application boundaries

| Layer | Responsibility | Updated by |
|---|---|---|
| `toto-stack` | Express server, authentication, sessions, CSRF, roles, user management, health, services, scheduling | Updating the dependency |
| `toto-stack/client` | React auth context, role-aware navigation, API requests | Updating the dependency |
| `toto-stack/shared` | Role helpers, auth states, response types, error codes; no Node or React dependency | Updating the dependency |
| Generated server and client | Entry point, custom routes, login and settings screens, layout | Your application changes |
| Prisma schema and migrations | Copied base models plus your own data | Your reviewed migrations |
| Dockerfile, Compose files, scripts | Build and deployment configuration | Your reviewed template updates |

The server entry is ESM-only and requires Node.js 22.22.0+. Import browser code from `toto-stack/client` or `toto-stack/shared`, never the server entry. Client helpers support React 18/19 and React Router 7/8; the generated app uses React 19 and Router 8.

## Built-in versus application routes

The package mounts `/api/auth/*`, `/api/account/*`, `/api/users`, and `/api/health`. They are mounted before custom API routes, so an application route cannot override them.

The scaffolder copies only the additional **notifications** and **status** route implementations into `server/routes`. They are yours to edit or remove. Notifications are an admin/owner API over configured handlers; `/api/status` is public liveness without a database check. `/api/health` is built-in readiness that checks the database.

See the [HTTP reference](/toto-stack/http/overview/) for request and response contracts and [Routes](/toto-stack/guides/routes/) for extension patterns. The [generated TypeScript API](/toto-stack/api/) documents exported signatures, not deployment or security procedures.

## Database contract

Your Prisma client must include `User`, `Role`, `UserRole`, `Session`, and `SetupLock`. Copy these from `toto-stack/prisma/base.prisma`; add application columns, relations, and models without renaming or removing required fields. When a model references `User`, add the corresponding back-relation to `User` too.

Prisma 7 uses the `prisma-client` generator and a driver adapter. MySQL and MariaDB through `@prisma/adapter-mariadb` are the supported databases. The stack accepts structurally compatible clients, including clients extended with `$extends`, through `StackPrismaClient`.

The app owns the client: **the stack never disconnects it**. Release it in `hooks.onShutdown`, and release it explicitly if startup fails. Schema changes shipped with stack releases must be applied to your copied schema; see [Upgrading](/toto-stack/maintain/upgrading/).

## Server lifecycle

```ts
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js"; // your application-owned client

const server = createServer({
    prisma,
    shutdown: {handleSignals: true},
    hooks: {onShutdown: () => prisma.$disconnect()},
});

await server.start();
```

This assumes your app exports `prisma` and supplies the [configuration](/toto-stack/operate/configuration/). For local development, set `NODE_ENV=development`. Production is the default when `NODE_ENV` is unset.

1. `createServer()` resolves and validates configuration, creates dependencies and validates cron definitions. It does not listen or start timers.
2. `start()` initializes setup state and roles, builds the app, creates the HTTP server, calls `onHttpServerCreated`, listens, starts services and jobs, then calls `onReady`.
3. `stop()` calls `beforeShutdown`, drains HTTP requests, aborts and waits for jobs, stops background services in reverse order, releases internal resources, then calls `onShutdown`.

`beforeShutdown` and `onShutdown` run only after readiness succeeded. Close websocket servers in `beforeShutdown` so they do not keep the drain open. Shutdown attempts all steps and aggregates failures; repeated `stop()` calls are safe. A stopped server cannot restart: create a new instance.

Signal handling is opt-in. With `shutdown.handleSignals: true`, SIGINT/SIGTERM initiate shutdown, a second signal exits immediately, and a forced-exit timer handles leaked resources. Allow enough process-manager grace time; see [Deployment](/toto-stack/operate/deployment/#operations).

For HTTP tests, `await server.createApp()` builds the Express app without listening or starting background jobs. It initializes database state, so use `NODE_ENV=test` with an isolated test database or a compatible test double.

## Dependency flow

Routes, hooks, service factories, and jobs receive the same per-server `Dependencies` container. It holds resolved configuration, Prisma, security services, email, notifications, and your [custom services](/toto-stack/guides/services/). Use `dependencies.config` instead of reading stack environment variables in application internals.

Sessions, users, roles, API keys, setup locks, and TOTP replay state live in the database. Rate limits and scheduled work are per instance by default. Logging level, format, and console patching are process-wide exceptions. Read [multi-instance requirements](/toto-stack/operate/security/#running-several-instances) before scaling.
