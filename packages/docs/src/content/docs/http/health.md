---
title: Health and readiness
description: Public framework readiness endpoint with process uptime and a database check.
sidebar:
  order: 5
---

[Shared request rules](/toto-stack/http/overview/) apply, except that health bypasses body parsing, sessions, and CSRF middleware. Origin checks and the global rate limit still run first.

### `GET /api/health`

*Framework. Public.* Readiness, including the database, which it checks with `SELECT 1`. It is mounted before the session middleware, so it never touches the session table; the template's Docker `HEALTHCHECK` uses it. It returns a **plain object, not the envelope**:

```json
{"status": "ok", "uptimeSeconds": 1234, "db": "ok"}
```

If the database is unreachable it returns 503 with `{"status": "degraded", "uptimeSeconds": 1234, "db": "down"}`.


For a database-free liveness check, the generated app includes [the app-owned status endpoint](/toto-stack/http/template/#get-apistatus).

## Source

[HealthRoute](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/routes/api/status/HealthRoute.ts) and [middleware ordering](https://github.com/totoluto/toto-stack/blob/master/packages/stack/src/Server.ts).
