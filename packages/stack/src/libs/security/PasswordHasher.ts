import crypto from "node:crypto";
import * as argon2 from "@node-rs/argon2";
import {AppError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";
import {Logger} from "@server/libs/Logger";

/**
 * Password hashing with Argon2id (@node-rs/argon2). Hashes are standard PHC
 * strings (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`). The library runs
 * on the libuv threadpool, so hashing never blocks the event loop.
 *
 * Only `$argon2id$` hashes verify. Hashes with other parameters than the
 * configured ones verify and report `needsRehash`. Any other stored value
 * (bcrypt, scrypt, garbage) is an invalid credential: it costs no work and
 * doesn't throw.
 *
 * Load shedding: at most `concurrency` hashes run at once. The threadpool
 * (default 4 threads) is shared with fs and dns: 200 unbounded hashes make an
 * unrelated fs read wait about 1 s. At most `queueLimit` wait; beyond that,
 * hash()/verify() fail fast with a 503 (code OVERLOADED, Retry-After).
 */

export type PasswordVerification = {
    valid: boolean;
    /** The hash should be replaced by hash(password): it uses other Argon2 parameters. */
    needsRehash: boolean;
};

export type PasswordHasherOptions = {
    /** Concurrent hash computations. Default: 2. */
    concurrency?: number;
    /** Hashes allowed to wait for a slot; more are rejected with 503. Default: 32. */
    queueLimit?: number;
    /** Argon2id memory in KiB. Default: 19456 (19 MiB, OWASP). */
    memoryCost?: number;
    /** Argon2id passes. Default: 2 (OWASP). */
    timeCost?: number;
    /** Argon2id lanes. Default: 1 (OWASP). */
    parallelism?: number;
};

export const DEFAULT_HASH_CONCURRENCY = 2;
export const DEFAULT_HASH_QUEUE_LIMIT = 32;
/** OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1. */
export const DEFAULT_ARGON2 = {memoryCost: 19456, timeCost: 2, parallelism: 1} as const;

/** `Algorithm.Argon2id` (a const enum in @node-rs/argon2's types, so it has no runtime value). */
const ARGON2ID = 2;
/** Upper bounds for stored hashes, so a tampered row can't demand gigabytes or minutes. */
const MAX_ARGON2_MEMORY_KIB = 256 * 1024;
const MAX_ARGON2_TIME = 16;
const MAX_ARGON2_PARALLELISM = 16;

export class PasswordHasher {
    private readonly concurrency: number;
    private readonly queueLimit: number;
    private readonly argon2Options: argon2.Options;
    private active = 0;
    private readonly queue: (() => void)[] = [];
    private readonly logger = new Logger("PasswordHasher");
    private lastShedWarning = 0;
    /** A hash of a random password, verified for unknown users (same work as a real check). */
    private dummyHash?: Promise<string>;

    constructor(options: PasswordHasherOptions = {}) {
        this.concurrency = options.concurrency ?? DEFAULT_HASH_CONCURRENCY;
        this.queueLimit = options.queueLimit ?? DEFAULT_HASH_QUEUE_LIMIT;
        this.argon2Options = {
            algorithm: ARGON2ID,
            memoryCost: options.memoryCost ?? DEFAULT_ARGON2.memoryCost,
            timeCost: options.timeCost ?? DEFAULT_ARGON2.timeCost,
            parallelism: options.parallelism ?? DEFAULT_ARGON2.parallelism,
        };
    }

    public hash(password: string): Promise<string> {
        return this.withSlot(() => argon2.hash(password.normalize("NFC"), this.argon2Options));
    }

    public async verify(password: string, encoded: string): Promise<PasswordVerification> {
        if (encoded.startsWith("$argon2id$")) {
            const params = this.argon2Params(encoded);
            if (!params) return {valid: false, needsRehash: false};

            const valid = await this.withSlot(() => argon2.verify(encoded, password.normalize("NFC")).catch(() => false));
            const outdated = params.memoryCost !== this.argon2Options.memoryCost
                || params.timeCost !== this.argon2Options.timeCost
                || params.parallelism !== this.argon2Options.parallelism;
            return {valid, needsRehash: valid && outdated};
        }

        return {valid: false, needsRehash: false};
    }

    /** Spends the same work as verifying a real password (login with an unknown username). Always false. */
    public async verifyDummy(password: string): Promise<false> {
        this.dummyHash ??= this.hash(crypto.randomBytes(32).toString("base64url"));
        await this.verify(password, await this.dummyHash);
        return false;
    }

    private argon2Params(encoded: string): argon2.ParsedHashOptions | null {
        try {
            const params = argon2.parseOptions(encoded);
            const maxMemory = Math.max(MAX_ARGON2_MEMORY_KIB, this.argon2Options.memoryCost ?? 0);
            return params.memoryCost <= maxMemory && params.timeCost <= MAX_ARGON2_TIME && params.parallelism <= MAX_ARGON2_PARALLELISM
                ? params
                : null;
        } catch {
            return null;
        }
    }

    private async withSlot<T>(work: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await work();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.concurrency) {
            this.active++;
            return Promise.resolve();
        }

        if (this.queue.length >= this.queueLimit) {
            const now = Date.now();
            if (now - this.lastShedWarning >= 60_000) {
                this.lastShedWarning = now;
                this.logger.warn(`Password hashing is saturated (${this.concurrency} running, ${this.queueLimit} queued); answering 503 to further password checks.`);
            }

            return Promise.reject(new AppError(503, "The server is busy. Try again in a moment.", {
                code: ErrorCode.OVERLOADED,
                headers: {"Retry-After": "1"},
                expose: true,
            }));
        }

        return new Promise(resolve => this.queue.push(resolve));
    }

    private release(): void {
        const next = this.queue.shift();
        if (next) {
            // The slot passes straight to the next waiter.
            next();
        } else {
            this.active--;
        }
    }
}
