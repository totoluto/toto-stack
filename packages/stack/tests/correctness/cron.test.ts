import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ConfigError} from "toto-stack";
import {CronJob, CronService, validateCronJobs} from "@server/libs/background/CronService";
import {makeServer} from "../core/support";
import {captureLogs} from "./support";

const job = (name: string, run: CronJob["run"], cronExpression = "* * * * * *"): CronJob => ({name, cronExpression, run});

describe("cron job validation (fails fast, before listen)", () => {
    it("rejects invalid expressions, time zones and names in createServer()", () => {
        const create = () => makeServer({
            cronJobs: () => [
                job("BadMinute", async () => undefined, "61 * * * *"),
                job("Garbage", async () => undefined, "every day"),
                {...job("BadZone", async () => undefined, "0 * * * *"), timezone: "Mars/Olympus"},
                job("Dup", async () => undefined, "0 * * * *"),
                job("Dup", async () => undefined, "0 * * * *"),
            ],
        });

        expect(create).toThrow(ConfigError);
        let issues: readonly string[] = [];
        try {
            create();
        } catch (err) {
            issues = (err as ConfigError).issues;
        }
        expect(issues).toEqual([
            expect.stringMatching(/cron job "BadMinute" has an invalid cron expression "61 \* \* \* \*" \(61 is a invalid expression for minute\)/),
            expect.stringMatching(/cron job "Garbage" has an invalid cron expression "every day"/),
            "cron job \"BadZone\" has an unknown time zone \"Mars/Olympus\".",
            "Duplicate cron job name \"Dup\".",
        ]);
    });

    it("accepts valid jobs", () => {
        expect(validateCronJobs([
            job("Every15", async () => undefined, "*/15 * * * *"),
            {...job("Zurich", async () => undefined, "0 3 * * 1-5"), timezone: "Europe/Zurich"},
        ])).toEqual([]);
        expect(() => makeServer({cronJobs: () => [job("Ok", async () => undefined, "0 0 * * *")]})).not.toThrow();
    });
});

describe("CronService", () => {
    let capture: ReturnType<typeof captureLogs>;
    let service: CronService | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        // Mid-second start: the per-second ticks then fall at fixed offsets.
        // From the real clock, a start just before a second boundary adds a tick.
        vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
        capture = captureLogs();
    });

    afterEach(async () => {
        const stopped = service?.stop();
        await vi.advanceTimersByTimeAsync(20_000);
        await stopped;
        service = undefined;
        vi.useRealTimers();
        capture.restore();
    });

    it("skips a run while the previous one is still in progress", async () => {
        let started = 0;
        let finished = 0;
        service = new CronService([job("Slow", async () => {
            started++;
            await new Promise(resolve => setTimeout(resolve, 3_500));
            finished++;
        })]);

        await service.start();
        await vi.advanceTimersByTimeAsync(3_200);

        // Ticks every second, but the 3.5 s run blocks the next ones.
        expect(started).toBe(1);
        expect(finished).toBe(0);
        expect(capture.stderr.join("").match(/\[WARN\]\[CronService\] Skipping cron job "Slow": the previous run is still in progress\./g)?.length).toBeGreaterThanOrEqual(2);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(finished).toBe(1);
        expect(started).toBe(2);
    });

    it("logs job errors with the job name and keeps scheduling", async () => {
        let runs = 0;
        service = new CronService([job("Exploder", async () => {
            runs++;
            throw new Error("disk full");
        })]);

        await service.start();
        await vi.advanceTimersByTimeAsync(2_100);

        expect(runs).toBe(2);
        const stderr = capture.stderr.join("");
        expect(stderr).toMatch(/\[ERROR\]\[CronService\] Cron job "Exploder" failed \{ job: 'Exploder' \}/);
        expect(stderr).toContain("Error: disk full");
        expect(stderr).not.toContain("NODE-CRON");
    });

    it("stop() aborts the signal and waits for the running job", async () => {
        let signal: AbortSignal | undefined;
        let finished = false;
        let runs = 0;
        service = new CronService([job("Long", async context => {
            runs++;
            signal = context.signal;
            await new Promise(resolve => setTimeout(resolve, 500));
            finished = true;
        })]);

        await service.start();
        await vi.advanceTimersByTimeAsync(1_050);
        expect(signal?.aborted).toBe(false);

        const stopped = service.stop();
        expect(signal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(600);
        await stopped;

        expect(finished).toBe(true);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(runs).toBe(1); // nothing runs after stop()
    });

    it("stop() gives up waiting after stopTimeoutMs", async () => {
        service = new CronService([job("Stuck", () => new Promise(() => undefined))], {stopTimeoutMs: 200});

        await service.start();
        await vi.advanceTimersByTimeAsync(1_050);

        const stopped = service.stop();
        await vi.advanceTimersByTimeAsync(250);
        await stopped;

        expect(capture.stderr.join("")).toMatch(/Cron jobs still running after 200 ms, not waiting any longer: Stuck/);
    });
});
