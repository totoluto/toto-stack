import crypto from "node:crypto";
import {NextFunction, Request, Response} from "express";
import {sendError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";
import {deriveKey} from "@server/libs/security/keys";
import {readCookie, stackCookieName} from "@server/libs/security/cookies";
import type {ResolvedStackConfig} from "@server/libs/config/StackConfig";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_HEADER = "x-csrf-token";
const BEARER_PATTERN = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)[ \t]*$/i;
const ANON_PREFIX = "a.";
const ANON_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether the request authenticates with an `Authorization: Bearer` API key.
 * Such requests are authenticated ONLY by the key (the session is ignored),
 * which is why they may skip CSRF: browsers never attach a Bearer header on
 * their own. Other schemes (e.g. Basic credentials a browser caches for a
 * proxy) are treated like no header at all, so they cannot switch off CSRF.
 */
export function bearerToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (header === undefined || !/^Bearer(\s|$)/i.test(header)) {
        return null;
    }

    // A malformed Bearer header still counts as Bearer: authentication fails instead of falling back to the session.
    return BEARER_PATTERN.exec(header)?.[1] ?? "";
}

export function usesBearerAuth(req: Request): boolean {
    return bearerToken(req) !== null;
}

/**
 * Origin allowlist and CSRF protection.
 *
 * CSRF tokens:
 * - Authenticated sessions use a random 32-byte token stored in the session
 *   (`session.csrfToken`), compared in constant time.
 * - Anonymous visitors (login, MFA and setup forms) get a stateless token,
 *   so GET /api/auth/csrf writes no session row. The token is
 *   `a.<expiry>.<HMAC(expiry, nonce)>`. The HMAC key is derived from the
 *   session secret with HKDF, and the nonce is a random value in an HttpOnly,
 *   SameSite=Strict cookie (`__Host-<cookieName>.csrf` in production), so the
 *   token is bound to the browser. It is only accepted while the session is
 *   not authenticated. After login the client fetches a session token.
 */
export class RequestSecurity {
    private readonly isDev: boolean;
    private readonly allowedOrigins: Set<string>;
    private readonly anonKey: Buffer;
    private readonly anonCookieName: string;

    constructor(config: ResolvedStackConfig) {
        this.isDev = config.isDev;
        this.allowedOrigins = this.parseAllowedOrigins(config.security.allowedOrigins);
        this.anonKey = deriveKey(config.security.sessionSecret, "anonymous csrf v1");
        this.anonCookieName = stackCookieName(config.isDev, config.session.cookieName, "csrf");
    }

    public originMiddleware(req: Request, res: Response, next: NextFunction): void | Response {
        const origin = req.headers.origin;

        if (origin && !this.isAllowedOrigin(origin)) {
            return sendError(res, 403, "Origin is not allowed.", {code: ErrorCode.ORIGIN_NOT_ALLOWED});
        }

        if (origin) {
            res.header("Access-Control-Allow-Origin", origin);
            res.header("Access-Control-Allow-Credentials", "true");
            res.header("Vary", "Origin");
        }

        res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-CSRF-Token");

        if (req.method === "OPTIONS") {
            return res.sendStatus(204);
        }

        next();
    }

    public csrfMiddleware(req: Request, res: Response, next: NextFunction): void | Response {
        if (SAFE_METHODS.has(req.method) || usesBearerAuth(req)) {
            return next();
        }

        const requestToken = req.header(CSRF_HEADER);
        const sessionToken = req.session.csrfToken;

        const valid = requestToken !== undefined && (
            (sessionToken !== undefined && this.constantTimeEqual(sessionToken, requestToken))
            || (!req.session.userId && this.isValidAnonymousToken(req, requestToken))
        );

        if (!valid) {
            return sendError(res, 403, "Invalid CSRF token.", {code: ErrorCode.CSRF_INVALID});
        }

        next();
    }

    /**
     * A CSRF token for the request: the session token for an authenticated
     * session (created on first use), otherwise a stateless anonymous token
     * (sets or refreshes the nonce cookie; no session write).
     */
    public getCsrfToken(req: Request, res: Response): string {
        if (req.session.userId) {
            req.session.csrfToken ??= crypto.randomBytes(32).toString("base64url");
            return req.session.csrfToken;
        }

        const existing = readCookie(req, this.anonCookieName);
        const nonce = existing && NONCE_PATTERN.test(existing) ? existing : crypto.randomBytes(32).toString("base64url");

        res.cookie(this.anonCookieName, nonce, {
            httpOnly: true,
            sameSite: "strict",
            secure: !this.isDev,
            path: "/",
            maxAge: ANON_TOKEN_TTL_MS,
        });

        const expiresAt = Date.now() + ANON_TOKEN_TTL_MS;
        return `${ANON_PREFIX}${expiresAt.toString(36)}.${this.anonSignature(expiresAt, nonce)}`;
    }

    private isValidAnonymousToken(req: Request, token: string): boolean {
        if (!token.startsWith(ANON_PREFIX)) return false;

        const [expiry, signature, extra] = token.slice(ANON_PREFIX.length).split(".");
        const nonce = readCookie(req, this.anonCookieName);
        const expiresAt = parseInt(expiry ?? "", 36);

        if (extra !== undefined || !signature || !nonce || !NONCE_PATTERN.test(nonce)) return false;
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt.toString(36) !== expiry) return false;

        return this.constantTimeEqual(this.anonSignature(expiresAt, nonce), signature);
    }

    private anonSignature(expiresAt: number, nonce: string): string {
        return crypto.createHmac("sha256", this.anonKey).update(`${expiresAt}.${nonce}`).digest("base64url");
    }

    private parseAllowedOrigins(configuredOrigins: readonly string[]): Set<string> {
        const origins = new Set(configuredOrigins);

        if (this.isDev) {
            origins.add("http://localhost:3000");
            origins.add("http://localhost:3001");
            origins.add("http://127.0.0.1:3000");
            origins.add("http://127.0.0.1:3001");
        }

        return origins;
    }

    private isAllowedOrigin(origin: string): boolean {
        return this.allowedOrigins.has(origin);
    }

    private constantTimeEqual(left: string, right: string): boolean {
        const leftBuffer = Buffer.from(left);
        const rightBuffer = Buffer.from(right);

        return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
    }
}
