import crypto from "node:crypto";
import {Logger} from "@server/libs/Logger";
import {MemoryRateLimitStore, RateLimitStore} from "@server/libs/security/RateLimitStore";

export type RateLimitResult = {
    allowed: boolean;
    retryAfterSeconds?: number;
};

type Rule = {
    name: string;
    maxAttempts: number;
    windowMs: number;
};

const MINUTE = 60 * 1000;

/**
 * Limits per window. Login and MFA use three tiers:
 * - per IP (login: per IPv4 address or IPv6 /56): one client guessing
 *   across many accounts;
 * - per account + IP: the strict brute-force lockout;
 * - per account: a much looser ceiling against distributed guessing.
 *   Distributed attackers CAN exhaust it, so a browser with a valid login
 *   device cookie for the account (LoginDeviceTrust) skips it and is limited
 *   per device id instead: the real user is never locked out of a browser
 *   they signed in from before.
 *
 * Failed attempts count; a success refunds its hits and clears the
 * account + IP counter. Attempts are counted before the (slow) password
 * check, so parallel bursts cannot overshoot a limit.
 */
const RULES = {
    loginIp: {name: "login per IP", maxAttempts: 20, windowMs: 15 * MINUTE},
    loginAccountIp: {name: "login per account and IP", maxAttempts: 5, windowMs: 15 * MINUTE},
    loginAccount: {name: "login per account", maxAttempts: 100, windowMs: 15 * MINUTE},
    loginDevice: {name: "login per trusted device", maxAttempts: 10, windowMs: 15 * MINUTE},
    otpIp: {name: "MFA per IP", maxAttempts: 20, windowMs: 10 * MINUTE},
    otpAccountIp: {name: "MFA per account and IP", maxAttempts: 5, windowMs: 10 * MINUTE},
    // Reaching the MFA step needs the password, so this ceiling can be tight.
    otpAccount: {name: "MFA per account", maxAttempts: 10, windowMs: 10 * MINUTE},
    setupIp: {name: "setup token per IP", maxAttempts: 5, windowMs: 15 * MINUTE},
    setupOtpIp: {name: "setup MFA per IP", maxAttempts: 5, windowMs: 10 * MINUTE},
    // Password re-confirmation costs a full hash, so every attempt counts (H9).
    reauthIp: {name: "password confirmation per IP", maxAttempts: 30, windowMs: 15 * MINUTE},
    reauthAccount: {name: "password confirmation per account", maxAttempts: 10, windowMs: 15 * MINUTE},
    csrfIp: {name: "CSRF token per IP", maxAttempts: 120, windowMs: MINUTE},
} satisfies Record<string, Rule>;

/**
 * Rate limits for the authentication endpoints. Counters live in a
 * RateLimitStore: in memory per process by default, or shared via
 * `security.rateLimitStore`. `ip` arguments are rate-limit client keys
 * (see rateLimitClientKey); usernames are normalised and hashed.
 */
export class AuthRateLimiter {
    private readonly store: RateLimitStore;
    private readonly logger = new Logger("AuthRateLimiter");

    constructor(store: RateLimitStore = new MemoryRateLimitStore()) {
        this.store = store;
    }

    public static formatRetryAfter(seconds?: number): string {
        if (!seconds) {
            return "later";
        }

        if (seconds > 60) {
            const minutes = Math.ceil(seconds / 60);
            return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
        }

        return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
    }

    /** Starts store maintenance (pruning for the in-memory store). Called by Server#start(). */
    public start(): void {
        this.store.start?.();
    }

    /** Called by Server#stop(). */
    public async stop(): Promise<void> {
        await this.store.stop?.();
    }

    /**
     * @param trustedDevice - device id from a valid device cookie for this
     *   account: replaces the account-wide ceiling by a per-device limit.
     */
    public consumeLogin(ip: string, username: string, trustedDevice?: string): Promise<RateLimitResult> {
        const account = accountKey(username);
        return this.consumeTiers([
            [RULES.loginIp, `login:ip:${ip}`],
            [RULES.loginAccountIp, `login:account-ip:${account}:${ip}`],
            trustedDevice === undefined
                ? [RULES.loginAccount, `login:account:${account}`]
                : [RULES.loginDevice, `login:device:${trustedDevice}`],
        ]);
    }

    /**
     * After a correct password: the attempt doesn't count (IP and account or
     * device tier are refunded), and the account+IP lockout clears. Pass the
     * same `trustedDevice` as to consumeLogin.
     */
    public async loginSucceeded(ip: string, username: string, trustedDevice?: string): Promise<void> {
        const account = accountKey(username);
        await this.store.decrement(`login:ip:${ip}`);
        await this.store.decrement(trustedDevice === undefined ? `login:account:${account}` : `login:device:${trustedDevice}`);
        await this.store.reset(`login:account-ip:${account}:${ip}`);
    }

    public consumeOtp(ip: string, userId: number): Promise<RateLimitResult> {
        return this.consumeTiers([
            [RULES.otpIp, `otp:ip:${ip}`],
            [RULES.otpAccountIp, `otp:account-ip:${userId}:${ip}`],
            [RULES.otpAccount, `otp:account:${userId}`],
        ]);
    }

    public async otpSucceeded(ip: string, userId: number): Promise<void> {
        await this.store.decrement(`otp:ip:${ip}`);
        await this.store.reset(`otp:account-ip:${userId}:${ip}`);
    }

    /** Setup token attempts (first-run setup). */
    public consumeSetup(ip: string): Promise<RateLimitResult> {
        return this.consumeTiers([[RULES.setupIp, `setup:ip:${ip}`]]);
    }

    public async setupTokenAccepted(ip: string): Promise<void> {
        await this.store.decrement(`setup:ip:${ip}`);
    }

    public consumeSetupOtp(ip: string): Promise<RateLimitResult> {
        return this.consumeTiers([[RULES.setupOtpIp, `setup-otp:ip:${ip}`]]);
    }

    /** Password re-confirmation on /account/* (every attempt counts). */
    public consumeReauth(ip: string, userId: number): Promise<RateLimitResult> {
        return this.consumeTiers([
            [RULES.reauthIp, `reauth:ip:${ip}`],
            [RULES.reauthAccount, `reauth:account:${userId}`],
        ]);
    }

    public consumeCsrf(ip: string): Promise<RateLimitResult> {
        return this.consumeTiers([[RULES.csrfIp, `csrf:ip:${ip}`]]);
    }

    /**
     * Hits the tiers in order and stops at the first one over its limit, so a
     * blocked client creates no further counters (e.g. no per-account bucket
     * once its IP is blocked).
     */
    private async consumeTiers(tiers: [Rule, string][]): Promise<RateLimitResult> {
        for (const [rule, key] of tiers) {
            const counter = await this.store.increment(key, rule.windowMs);

            if (counter.count > rule.maxAttempts) {
                if (counter.count === rule.maxAttempts + 1) {
                    // Exactly once per key and window
                    this.logger.warn(`Rate limit "${rule.name}" reached (${rule.maxAttempts} per ${Math.round(rule.windowMs / MINUTE)} min) for ${JSON.stringify(key)}`);
                }

                return {
                    allowed: false,
                    retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - Date.now()) / 1000)),
                };
            }
        }

        return {allowed: true};
    }
}

/**
 * Usernames are matched case-insensitively and without surrounding spaces
 * (like the default MySQL collation), then hashed: keys stay short, and
 * logs never contain what a user typed into the username field (sometimes a
 * password).
 */
export function accountKey(username: string): string {
    return crypto.createHash("sha256").update(username.trim().toLowerCase()).digest("hex").slice(0, 16);
}
