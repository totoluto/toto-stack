import crypto from "node:crypto";
import type {Request, Response} from "express";
import type {ResolvedStackConfig} from "@server/libs/config/StackConfig";
import {accountKey} from "@server/libs/security/AuthRateLimiter";
import {deriveKey} from "@server/libs/security/keys";
import {readCookie, stackCookieName} from "@server/libs/security/cookies";

const DEVICE_COOKIE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const VALUE_PATTERN = /^v1\.([0-9a-f]{16})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/**
 * "Device cookies" (OWASP brute-force guidance) so targeted lockout can't
 * lock a user out of a browser they have signed in from before.
 *
 * After a successful login (password, plus MFA if enabled) the browser gets
 * a signed, HttpOnly cookie naming the account (as a hash of the normalised
 * username) with a random device id and an expiry:
 *
 *     v1.<account>.<expiry36>.<deviceId>.<HMAC-SHA256>
 *
 * The key is derived from the session secret with HKDF. A login attempt for
 * that account from that browser skips the account-wide ceiling (which
 * distributed attackers can exhaust) but stays limited per IP, per
 * account + IP, and per device id. Only the most recent account per browser
 * is remembered. The cookie grants no access; it only changes which rate
 * limits apply.
 */
export class LoginDeviceTrust {
    private readonly key: Buffer;
    private readonly cookieName: string;
    private readonly secure: boolean;

    constructor(config: ResolvedStackConfig) {
        this.key = deriveKey(config.security.sessionSecret, "login device cookie v1");
        this.cookieName = stackCookieName(config.isDev, config.session.cookieName, "device");
        this.secure = !config.isDev;
    }

    /** The device id when the request carries a valid device cookie for `username`, else undefined. */
    public trustedDevice(req: Request, username: string): string | undefined {
        const parsed = this.parse(readCookie(req, this.cookieName));
        return parsed && parsed.account === accountKey(username) ? parsed.deviceId : undefined;
    }

    /** Sets (or renews) the device cookie after a successful login of `username`. */
    public remember(req: Request, res: Response, username: string): void {
        const account = accountKey(username);
        const existing = this.parse(readCookie(req, this.cookieName));
        const deviceId = existing?.account === account ? existing.deviceId : crypto.randomBytes(16).toString("base64url");
        const expiry = (Date.now() + DEVICE_COOKIE_TTL_MS).toString(36);
        const payload = `v1.${account}.${expiry}.${deviceId}`;

        res.cookie(this.cookieName, `${payload}.${this.sign(payload)}`, {
            httpOnly: true,
            sameSite: "strict",
            secure: this.secure,
            path: "/",
            maxAge: DEVICE_COOKIE_TTL_MS,
        });
    }

    private parse(value: string | undefined): {account: string; deviceId: string} | undefined {
        const match = value ? VALUE_PATTERN.exec(value) : null;
        if (!match) return undefined;

        const [, account, expiry, deviceId, signature] = match;
        const expected = Buffer.from(this.sign(`v1.${account}.${expiry}.${deviceId}`));
        if (!crypto.timingSafeEqual(expected, Buffer.from(signature)) || parseInt(expiry, 36) <= Date.now()) {
            return undefined;
        }

        return {account, deviceId};
    }

    private sign(payload: string): string {
        return crypto.createHmac("sha256", this.key).update(payload).digest("base64url");
    }
}
