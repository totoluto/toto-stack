---
title: Routes
description: Add validated API routes with authentication, role checks, and consistent responses.
sidebar:
  order: 1
---

Extend `BaseRoute`, then pass your route class to `createServer({routes})`. Routes mount under `/api` after the built-in auth, account, users, and health endpoints.

## Add a route

This example uses only the base models and needs no application schema changes. Add `zod@^4` to your app dependencies when defining schemas.

```ts
// server/routes/EchoRoute.ts
import {z} from "zod";
import {BaseRoute, respond, Role, type Dependencies} from "toto-stack";

const echoSchema = z.object({message: z.string().trim().min(1).max(200)}).strict();

export class EchoRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/echo", dependencies);
    }

    protected registerRoutes(): void {
        this.get("/", (req, res) => {
            return respond(res, 200, "success", "Current user", {
                user: this.currentUser(req),
            });
        });

        this.post("/", echoSchema, (_req, res, body) => {
            return respond(res, 200, "success", "Echo", {message: body.message});
        }, {roles: [Role.ADMIN]});
    }
}
```

Register `EchoRoute` in the generated `server/routes/index.ts` array alongside the routes you keep. In a custom server, pass it directly:

```ts
import {createServer} from "toto-stack";
import {prisma} from "./prisma.js";
import {EchoRoute} from "./routes/EchoRoute.js";

const server = createServer({prisma, routes: [EchoRoute]});
await server.start();
```

`GET /api/echo` admits any signed-in user. `POST /api/echo` admits admins and owners, validates the body, and requires CSRF for cookie-authenticated browser calls.

## Choose guards and body validation

- Authentication is required by default. `{auth: false}` makes a route or endpoint public; roles are ignored in that case.
- Set route defaults in the third `BaseRoute` constructor argument. Endpoint options override those defaults.
- `roles: []` admits any signed-in user. A nonempty list requires any matching role, with the built-in owner/admin hierarchy. See [Authentication](/toto-stack/guides/authentication/#roles).
- `get(path, handler, options?)` and `delete(path, handler, options?)` accept handlers without a parsed body.
- `post`, `put`, and `patch` take `(path, schema, handler, options?)`. The handler receives the parsed body as its third argument.
- `delete` also supports `(path, schema, handler, options?)` for validated JSON, as used by built-in user deletion.
- Use `noPayloadSchema` for a body-less POST. Strict zod 4 schemas reject unknown properties; validation failures return 400 `VALIDATION_FAILED` with `{path, message}` details.

Use `this.currentUser(req)` instead of asserting that `req.user` exists. It returns `{id, username, roles}` or throws a 401. Authentication is not resource ownership: scope database reads and writes by the current user's ID where needed. Validate route parameters before using them in database operations.

## Return errors consistently

```ts
import {AppError} from "toto-stack";

throw new AppError(404, "Record not found.", {code: "RECORD_NOT_FOUND"});
```

Thrown errors and rejected handlers reach the central error handler. `respond()` writes the standard success/error envelope; `sendError()` writes a coded error. `AppError` also accepts `details`, `headers`, and `expose`.

4xx messages and codes are exposed. In production, unexposed 5xx errors return generic status text and a generic code; internal details stay in logs. Never expose database or remote-service error text. Clients should branch on `code`, not `message`. See [HTTP contracts](/toto-stack/http/overview/) and the [TypeScript API](/toto-stack/api/).

## Keep security middleware in the path

All `/api` mutations need `X-CSRF-Token` unless authenticated with a Bearer API key. [apiFetch](/toto-stack/guides/client/) manages browser cookies and tokens. Unknown `/api` paths return JSON 404s.

`hooks.configureApp` runs **before** parsers, sessions, and CSRF. Use it only when that ordering is necessary, such as signed raw-body webhooks, and implement authentication yourself. Do not mount ordinary browser mutations there. See [request pipeline](/toto-stack/operate/configuration/#request-pipeline).

Use `getRequestIP(req)` for a validated proxy-aware client IP, not a manually parsed forwarded header. Every request also receives an `X-Request-Id` for log correlation.
