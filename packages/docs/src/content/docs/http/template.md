---
title: Template endpoints
description: App-owned notification sending, handler discovery, and liveness examples.
sidebar:
  order: 6
---

These endpoints are **app-owned examples**, not framework guarantees. They ship in the `create-toto-app` template and are mounted only when the app passes its `routes` to `createServer`. They can be edited or removed. [Shared request rules](/toto-stack/http/overview/) still apply, including CSRF for cookie-session mutations and the global rate limit.

## Notifications

*Template (`server/routes/NotificationRoute.ts`). Admin.* When this template route is registered, it is mounted whether or not handlers are configured. If no handlers are configured and `handlers` is omitted or empty, `send` answers 503 `NO_HANDLERS`. Configure handlers with `createServer({notifications: {handlers}})`.

### `GET /api/notifications/handlers`

200 `data: {handlers: ["ops", "email", …]}`.

### `POST /api/notifications/send`

Body (strict):

| Field | Type |
|---|---|
| `title` | string, 1–200 characters (trimmed) |
| `message` | string, 1–2000 characters (trimmed) |
| `handlers` | optional array of handler ids (1–100 characters each, at most 50); omitted or empty selects all handlers |
| `metadata` | optional object with at most 25 keys (1–64 characters each). Values are strings (at most 1024 characters), numbers or booleans. `color: "#rrggbb"` sets the Discord/Slack accent colour. |

| Response | When |
|---|---|
| 200 `data: {delivered, failed, results: [{handler, ok}]}` | At least one handler delivered. The message says how many when some failed. |
| 400 `UNKNOWN_HANDLER`, `details: {unknown: [...]}` | An id in `handlers` isn't registered. |
| 502 `DELIVERY_FAILED`, `details: {results}` | Every handler failed. |
| 503 `NO_HANDLERS` | No handler is configured and `handlers` is omitted or empty. A nonempty list of unregistered IDs instead returns `UNKNOWN_HANDLER`. |

Handlers run in parallel, each with its own timeout (5 s by default). Remote error text is logged server-side and never returned.

## Status

### `GET /api/status`

*Template (`server/routes/StatusRoute.ts`). Public.* Liveness. 200 `"Server is up and running"`. Doesn't touch the database; a request without a session cookie also costs no session lookup.


## Source

[Template registration](https://github.com/totoluto/toto-stack/blob/master/packages/create-toto-app/template/server/routes/index.ts), [NotificationRoute](https://github.com/totoluto/toto-stack/blob/master/packages/create-toto-app/template/server/routes/NotificationRoute.ts), and [StatusRoute](https://github.com/totoluto/toto-stack/blob/master/packages/create-toto-app/template/server/routes/StatusRoute.ts).
