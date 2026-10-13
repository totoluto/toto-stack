import type {Request, Response} from "express";
import {AppError, sendError} from "@server/libs/ErrorHandler";
import {AuthRateLimiter, RateLimitResult} from "@server/libs/security/AuthRateLimiter";
import {usesBearerAuth} from "@server/libs/security/RequestSecurity";
import {ErrorCode} from "@shared/errorCodes";

/**
 * Endpoints that read or write session state (login, MFA, setup, logout,
 * MFA enrollment) refuse Bearer requests. Those skip CSRF and are
 * authenticated only by their key, so they must not touch a session.
 */
export function rejectBearer(req: Request): void {
    if (usesBearerAuth(req)) {
        throw new AppError(400, "This endpoint uses the session; send it without an Authorization header.", {code: ErrorCode.BEARER_NOT_ALLOWED});
    }
}

/** Sends a 429 (code RATE_LIMITED) with Retry-After when the limit is exceeded. Returns true if the request may proceed. */
export function checkRateLimit(res: Response, result: RateLimitResult, what: string): boolean {
    if (result.allowed) {
        return true;
    }

    if (result.retryAfterSeconds) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
    }

    sendError(res, 429, `Too many ${what}. Try again in ${AuthRateLimiter.formatRetryAfter(result.retryAfterSeconds)}.`, {code: ErrorCode.RATE_LIMITED});
    return false;
}
