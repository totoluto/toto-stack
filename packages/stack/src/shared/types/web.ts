import type {ErrorCode} from "../errorCodes";

/**
 * The JSON envelope of every toto-stack API response, including errors
 * (validation failures, 401/403/404/413/429 and 5xx). One exception:
 * GET /api/health answers `{status: "ok" | "degraded", uptimeSeconds, db}`
 * (503 when the database is down), the raw shape health checkers expect.
 */
export type WebResponse<T = undefined> = {
    status: 'success' | 'error';
    message: string;
    data?: T;
    /** Machine-readable error code: always set on errors sent by the stack (see ErrorCode). */
    code?: ErrorCode | (string & {});
    /** Extra error details, e.g. validation issues (errors only). */
    details?: unknown;
}

/** A WebResponse describing an error. */
export type WebErrorResponse = Omit<WebResponse<never>, "status" | "data"> & {status: 'error'};
