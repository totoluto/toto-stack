---
title: Background jobs
description: Register scheduled jobs and long-running services with bounded shutdown.
sidebar:
  order: 4
---

Use `cronJobs` for scheduled work and `backgroundServices` for workers that live as long as the server. Both factories receive the server dependencies, including your [custom services](/toto-stack/guides/services/).

## Register work

```ts
import {createServer, Logger, type BackgroundService, type CronJob, type Dependencies} from "toto-stack";
import {prisma} from "./prisma.js";

class NightlyReport implements CronJob {
    readonly name = "NightlyReport";        // unique, used in logs
    readonly cronExpression = "0 3 * * *";  // node-cron syntax (5 fields, or 6 with seconds)
    readonly timezone = "Europe/Zurich";    // IANA zone; default "UTC"

    constructor(private readonly deps: Dependencies) {}

    async run({signal}: {signal: AbortSignal}): Promise<void> {
        const users = await this.deps.prisma.user.count();
        if (signal.aborted) return; // the server is stopping
        new Logger("NightlyReport").info("Report", {users});
    }
}

class QueueWorker implements BackgroundService {
    readonly name = "QueueWorker";
    private timer?: NodeJS.Timeout;

    start(): void {
        this.timer = setInterval(() => { /* poll */ }, 5000);
    }

    stop(): void {
        clearInterval(this.timer);
    }
}

createServer({
    prisma,
    cronJobs: deps => [new NightlyReport(deps)],
    backgroundServices: () => [new QueueWorker()],
});
```

**Cron jobs:**
- **Validation:** `createServer()` throws a `ConfigError` for a missing or duplicate name, an invalid expression or an unknown time zone, before anything listens.
- **No overlap:** a run is skipped, with a warning, while the previous run of the same job is still going.
- **Failures** are logged with the job name and never crash the process.
- **Stopping:** `stop()` aborts `signal`, then waits up to `shutdown.timeoutMs` (10 s by default) for running jobs.

**Background services** start in order after the server listens and stop in reverse order. A failure in one `stop()` doesn't prevent the others from stopping; all failures are rethrown together.

The built-in `SessionCleanup` job deletes expired session rows every 15 minutes, in batches.

**Per instance:** cron jobs and background services run in every process that calls `start()`. If you run several instances, make your jobs idempotent or guard them with a database lock. `SessionCleanup` is idempotent.

## Choose safe shutdown behavior

`createServer()` constructs and validates job definitions; work begins only after the HTTP server listens. Do not start timers in constructors or at import time.

Cron's `AbortSignal` is cooperative: check it around long operations and pass it to APIs that support cancellation. A shutdown timeout stops waiting; it cannot undo a database write or forcibly cancel arbitrary code. Keep work resumable and release resources in the service's `stop()`.

The example worker is a timer skeleton, not a queue implementation. Add your own queue, error handling, overlap policy, and waiting for in-flight work. The cron scheduler's no-overlap guarantee does not automatically cover timers created by a background service.

For container grace periods and signal handling, see [Deployment](/toto-stack/operate/deployment/#operations). For multiple replicas, use idempotency or a shared lock; there is no built-in distributed scheduler or leader election.
