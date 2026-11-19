---
title: Services
description: Share typed application services and use notifications, email, and structured logging.
sidebar:
  order: 3
---

Use the `services` factory to attach application services to the per-server dependency container. Keep domain logic there rather than duplicating it across routes and jobs. This page also covers the notification, email, and logging services available out of the box.

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

## Notifications

Notification handlers deliver a `{title, message, metadata?}` payload to a destination. Configure them by id:

```ts
import {createServer, EmailHandler, GenericWebhookHandler} from "toto-stack";
import {prisma} from "./prisma.js";

createServer({
    prisma,
    notifications: {
        handlers: deps => ({
            webhook: new GenericWebhookHandler("https://hooks.example.com/notify"),
            email: new EmailHandler(deps.emailService, ["ops@example.com"]),
        }),
    },
});
```

Replace these example destinations with your own, configure SMTP before using the email handler, and keep webhook secrets out of source control. Other built-in adapters are `SlackHandler(url, options?)`, `DiscordHandler(url, options?)`, and `TelegramHandler(botToken, chatId, options?)`.


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

Remote error text is never returned to the client. Details are in the [API reference](/toto-stack/http/overview/).

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
- **Secrets:** the stack never logs passwords, tokens or keys. The generated one-time setup token is written directly to stderr instead of the log, so it stays out of log pipelines. See [Security](/toto-stack/operate/security/#first-run-setup).

## Resource ownership

Services are constructed by `createServer()`, before listening. Start timers and connections in a [background service](/toto-stack/guides/background-jobs/) or lifecycle hook, not as import-time side effects. Close long-lived websocket connections in `beforeShutdown`, and release application resources such as Prisma in `onShutdown`. Also release them if startup fails, because ready-only shutdown hooks do not run on every failed startup.

See [Architecture](/toto-stack/start/architecture/#server-lifecycle) for lifecycle ordering and the [TypeScript API](/toto-stack/api/) for service contracts.
