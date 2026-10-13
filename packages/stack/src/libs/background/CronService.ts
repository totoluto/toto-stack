import cron, {ScheduledTask} from "node-cron";
import {BackgroundService} from "@server/libs/background/BackgroundService";
import {ConfigError} from "@server/libs/config/StackConfig";
import {Logger} from "@server/libs/Logger";

export type CronJob = {
    /** Used in logs; must be unique. */
    readonly name: string;
    /** node-cron expression (5 fields, or 6 with seconds). Validated by createServer(). */
    readonly cronExpression: string;
    /** IANA time zone. Default: "UTC". */
    readonly timezone?: string;
    /**
     * Runs the job. A run is skipped while the previous one is still going.
     * `signal` is aborted when the server stops; long jobs should honour it.
     */
    run(context: {readonly signal: AbortSignal}): Promise<void>;
}

export type CronServiceOptions = {
    /** How long stop() waits for running jobs after aborting them. Default: 10000 ms. */
    stopTimeoutMs?: number;
};

/** Returns the problems with a list of cron jobs (empty when valid). */
export function validateCronJobs(jobs: readonly CronJob[]): string[] {
    const issues: string[] = [];
    const names = new Set<string>();

    for (const job of jobs) {
        const name = typeof job?.name === "string" ? job.name.trim() : "";
        const label = name ? `cron job "${name}"` : "a cron job";

        if (!name) {
            issues.push("Every cron job needs a non-empty name.");
        } else if (names.has(name)) {
            issues.push(`Duplicate cron job name "${name}".`);
        }
        names.add(name);

        if (typeof job?.run !== "function") {
            issues.push(`${label} has no run() method.`);
        }

        const expression = job?.cronExpression;
        if (typeof expression !== "string" || !safeValidate(expression)) {
            const detail = typeof expression === "string" ? describeInvalid(expression) : "";
            issues.push(`${label} has an invalid cron expression "${String(expression)}"${detail}.`);
        }

        if (job?.timezone !== undefined && !isValidTimeZone(job.timezone)) {
            issues.push(`${label} has an unknown time zone "${String(job.timezone)}".`);
        }
    }

    return issues;
}

function safeValidate(expression: string): boolean {
    try {
        return cron.validate(expression);
    } catch {
        return false;
    }
}

function describeInvalid(expression: string): string {
    try {
        const messages = cron.validateDetailed(expression).errors.map(error => error.message);
        return messages.length > 0 ? ` (${messages.join("; ")})` : "";
    } catch (err) {
        return err instanceof Error ? ` (${err.message})` : "";
    }
}

function isValidTimeZone(timeZone: unknown): boolean {
    if (typeof timeZone !== "string" || !timeZone) return false;
    try {
        new Intl.DateTimeFormat("en-US", {timeZone});
        return true;
    } catch {
        return false;
    }
}

/**
 * Runs cron jobs while the server is started. Jobs are validated when the
 * service is created (so createServer() fails fast with a ConfigError), runs
 * never overlap, failures are logged with the job name, and stop() aborts and
 * waits for running jobs (bounded by `stopTimeoutMs`).
 */
export class CronService implements BackgroundService {
    public readonly name = "CronService";
    private readonly logger = new Logger("CronService");
    private readonly jobs: readonly CronJob[];
    private readonly stopTimeoutMs: number;
    private readonly tasks: ScheduledTask[] = [];
    private readonly running = new Map<CronJob, Promise<void>>();
    private abort = new AbortController();

    constructor(jobs: readonly CronJob[], options: CronServiceOptions = {}) {
        const issues = validateCronJobs(jobs);
        if (issues.length > 0) {
            throw new ConfigError(issues);
        }

        this.jobs = [...jobs];
        this.stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    }

    public async start(): Promise<void> {
        if (this.tasks.length > 0) return;
        this.abort = new AbortController();

        for (const job of this.jobs) {
            const task = cron.createTask(job.cronExpression, () => this.runJob(job), {
                name: job.name,
                timezone: job.timezone ?? "UTC",
                // Route node-cron's own messages (e.g. missed executions) through the stack logger.
                logger: {
                    debug: message => this.logger.debug(String(message)),
                    info: message => this.logger.debug(message),
                    warn: message => this.logger.warn(`${job.name}: ${message}`),
                    error: (message, err) => this.logger.error(`${job.name}: ${String(message)}`, err),
                },
            });
            this.tasks.push(task);
            await task.start();
        }
    }

    public async stop(): Promise<void> {
        // Abort first (synchronously): running jobs see it at once and no new run starts.
        this.abort.abort();
        const tasks = this.tasks.splice(0);
        await Promise.all(tasks.map(task => task.destroy()));

        if (this.running.size === 0) return;

        const names = () => [...this.running.keys()].map(job => job.name).join(", ");
        this.logger.info(`Waiting for running cron jobs: ${names()}`);

        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<boolean>(resolve => {
            timer = setTimeout(() => resolve(true), this.stopTimeoutMs);
            timer.unref();
        });
        const finished = Promise.all(this.running.values()).then(() => false);

        if (await Promise.race([finished, timedOut])) {
            this.logger.warn(`Cron jobs still running after ${this.stopTimeoutMs} ms, not waiting any longer: ${names()}`);
        }
        clearTimeout(timer);
    }

    /** Runs a job unless its previous run is still in progress. Never rejects. */
    private async runJob(job: CronJob): Promise<void> {
        const signal = this.abort.signal;
        if (signal.aborted) return; // stopping

        if (this.running.has(job)) {
            this.logger.warn(`Skipping cron job "${job.name}": the previous run is still in progress.`);
            return;
        }

        const run = (async () => {
            const startedAt = Date.now();
            try {
                await job.run({signal});
                this.logger.debug(`Cron job "${job.name}" finished in ${Date.now() - startedAt} ms`);
            } catch (err) {
                this.logger.error(`Cron job "${job.name}" failed`, {err, job: job.name});
            }
        })();

        this.running.set(job, run);
        try {
            await run;
        } finally {
            this.running.delete(job);
        }
    }
}
