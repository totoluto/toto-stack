type MaybePromise<T> = T | Promise<T>;

/** A fixed-window counter. */
export type RateLimitCounter = {
    /** Hits in the current window (after the increment that returned it). */
    count: number;
    /** Epoch ms at which the window ends and the counter starts again. */
    resetAt: number;
};

/**
 * Storage for the authentication rate limits (login, MFA, setup, password
 * re-confirmation, CSRF tokens).
 *
 * The default MemoryRateLimitStore keeps counters in the process, so the
 * limits apply per instance. When the app runs several instances behind a
 * load balancer, pass a shared store (`security.rateLimitStore`), e.g. a
 * small Redis adapter using INCR + PEXPIRE NX, DECR and DEL. Keys are short
 * ASCII strings; usernames in keys are hashed.
 */
export interface RateLimitStore {
    /**
     * Atomically adds one hit to `key`. If the key has no live window, one
     * starting now and lasting `windowMs` is created. Returns the new counter.
     */
    increment(key: string, windowMs: number): MaybePromise<RateLimitCounter>;
    /** Removes one hit from a live window (refund after a success). No-op if absent or at zero. */
    decrement(key: string): MaybePromise<void>;
    /** Deletes the counter. */
    reset(key: string): MaybePromise<void>;
    /** Called by Server#start(), e.g. to schedule pruning. */
    start?(): void;
    /** Called by Server#stop(). */
    stop?(): MaybePromise<void>;
}

/** How often expired windows are pruned while the server runs. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * In-process RateLimitStore (the default). Counters live in a Map, which is
 * safe for arbitrary client-supplied keys (no prototype pollution). Expired
 * windows are pruned every minute by an unref()'d timer between start() and
 * stop(); a hit on an expired window starts a new one.
 */
export class MemoryRateLimitStore implements RateLimitStore {
    private readonly counters = new Map<string, RateLimitCounter>();
    private sweepTimer?: NodeJS.Timeout;

    public increment(key: string, windowMs: number): RateLimitCounter {
        const now = Date.now();
        let counter = this.counters.get(key);

        if (!counter || counter.resetAt <= now) {
            counter = {count: 0, resetAt: now + windowMs};
            this.counters.set(key, counter);
        }

        counter.count += 1;
        return {...counter};
    }

    public decrement(key: string): void {
        const counter = this.counters.get(key);
        if (counter && counter.resetAt > Date.now() && counter.count > 0) {
            counter.count -= 1;
        }
    }

    public reset(key: string): void {
        this.counters.delete(key);
    }

    /** Number of stored counters (expired ones included until pruned). */
    public get size(): number {
        return this.counters.size;
    }

    /** Deletes every expired window. Returns how many were removed. */
    public prune(now: number = Date.now()): number {
        let removed = 0;
        for (const [key, counter] of this.counters) {
            if (counter.resetAt <= now) {
                this.counters.delete(key);
                removed++;
            }
        }

        return removed;
    }

    public start(): void {
        if (this.sweepTimer) return;
        this.sweepTimer = setInterval(() => this.prune(), SWEEP_INTERVAL_MS);
        this.sweepTimer.unref();
    }

    public stop(): void {
        clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
    }

    public clear(): void {
        this.counters.clear();
    }
}
