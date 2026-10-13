import {STATUS_CODES} from "node:http";
import {ErrorRequestHandler, RequestHandler, Response} from "express";
import {Logger} from "@server/libs/Logger";
import {WebErrorResponse} from "@shared/types/web";
import {ErrorCode} from "@shared/errorCodes";

type Code = ErrorCode | (string & {});

export type AppErrorOptions = {
    /**
     * Machine-readable code sent to the client as `code` when the error is
     * exposed. Default, and for unexposed errors outside development: the
     * status's generic code (e.g. 404 NOT_FOUND, 500 INTERNAL_ERROR).
     */
    code?: Code;
    /** Extra details sent to the client as `details` (keep them client-safe). */
    details?: unknown;
    /** Response headers to send with the error, e.g. `{"Retry-After": "1"}`. */
    headers?: Record<string, string>;
    /**
     * Send message/code/details to the client and treat the error as expected
     * (no error log). Default: true for 4xx, false for 5xx. Set it for
     * deliberate 5xx responses such as a 503 "overloaded".
     */
    expose?: boolean;
    cause?: unknown;
};

/**
 * Throw from a route handler to send a specific status. When the error is
 * exposed (default: 4xx; see `expose`) or in development, its message, code
 * and details are sent; otherwise the client gets the status text and the
 * status's generic code.
 */
export class AppError extends Error {
    public readonly code?: Code;
    public readonly details?: unknown;
    public readonly headers?: Record<string, string>;
    public readonly expose: boolean;

    constructor(public readonly status: number, message: string, options: AppErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : {cause: options.cause});
        this.name = "AppError";
        this.code = options.code;
        this.details = options.details;
        this.headers = options.headers;
        this.expose = options.expose ?? status < 500;
    }
}

/** The generic code for an HTTP error status (used when no specific code applies). */
export function errorCodeForStatus(status: number): ErrorCode {
    switch (status) {
        case 401: return ErrorCode.UNAUTHORIZED;
        case 403: return ErrorCode.FORBIDDEN;
        case 404: return ErrorCode.NOT_FOUND;
        case 409: return ErrorCode.CONFLICT;
        case 413: return ErrorCode.PAYLOAD_TOO_LARGE;
        case 415: return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
        case 429: return ErrorCode.RATE_LIMITED;
        case 503: return ErrorCode.SERVICE_UNAVAILABLE;
        default: return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
    }
}

/**
 * Sends the standard error envelope `{status: "error", message, code, details?}`.
 * `code` defaults to the generic code of the status (errorCodeForStatus).
 */
export function sendError(res: Response, statusCode: number, message: string, extra: {code?: Code; details?: unknown} = {}): Response {
    const body: WebErrorResponse = {
        status: "error",
        message,
        code: extra.code ?? errorCodeForStatus(statusCode),
        ...(extra.details !== undefined ? {details: extra.details} : {}),
    };

    return res.status(statusCode).json(body);
}

/** 404 for everything no route handled. */
export const notFoundHandler: RequestHandler = (_req, res) => {
    sendError(res, 404, "Not Found", {code: ErrorCode.NOT_FOUND});
};

type HttpLikeError = Error & {status?: unknown; statusCode?: unknown; expose?: unknown; type?: unknown};

/** Client-facing code and message for body-parser failures (by their `type`). */
const BODY_PARSER_ERRORS: Record<string, {code: ErrorCode; message: string}> = {
    "entity.parse.failed": {code: ErrorCode.INVALID_JSON, message: "Malformed JSON request body."},
    "entity.too.large": {code: ErrorCode.PAYLOAD_TOO_LARGE, message: "Request body is too large."},
    "encoding.unsupported": {code: ErrorCode.UNSUPPORTED_MEDIA_TYPE, message: "Unsupported request body encoding."},
    "charset.unsupported": {code: ErrorCode.UNSUPPORTED_MEDIA_TYPE, message: "Unsupported request body charset."},
};

/**
 * body-parser / raw-body errors (4xx with a string `type`) get a generic
 * message: their own message is parser internals (e.g. the JSON.parse
 * position), which is only logged.
 */
function bodyParserError(err: unknown, status: number): {code: ErrorCode; message: string} | undefined {
    const type = (err as HttpLikeError | null)?.type;
    if (err instanceof AppError || status >= 500 || typeof type !== "string") return undefined;
    return BODY_PARSER_ERRORS[type] ?? {code: errorCodeForStatus(status), message: STATUS_CODES[status] ?? "Bad Request"};
}

function statusOf(err: unknown): number {
    if (err instanceof AppError) {
        return err.status;
    }

    const candidate = (err as HttpLikeError | null)?.status ?? (err as HttpLikeError | null)?.statusCode;
    return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
        ? candidate
        : 500;
}

const logger = new Logger("ErrorHandler");

/**
 * Final error handler. Maps errors to the standard envelope (always with a code):
 * - AppError -> its status/message/code/details
 * - errors carrying a 4xx `status`/`statusCode` -> that status; body-parser
 *   failures get INVALID_JSON (400) / PAYLOAD_TOO_LARGE (413) / UNSUPPORTED_MEDIA_TYPE (415)
 *   with a generic message (the parser's detail is logged at debug level)
 * - anything else -> 500 INTERNAL_ERROR, message hidden outside development, stack logged.
 */
export function createErrorHandler(options: {isDev: boolean}): ErrorRequestHandler {
    return (err, req, res, next) => {
        if (res.headersSent) {
            // Too late to send an error body; let Express abort the response.
            return next(err);
        }

        const status = statusOf(err);
        const error = err instanceof Error ? err : new Error(String(err));
        const isServerError = status >= 500;
        const expected = err instanceof AppError ? err.expose : !isServerError;

        if (!expected) {
            logger.error(`${req.method} ${req.originalUrl} -> ${status}: ${error.stack ?? error.message}`);
        } else {
            logger.debug(`${req.method} ${req.originalUrl} -> ${status}: ${error.message}`);
        }

        const parserError = bodyParserError(err, status);
        if (parserError) {
            return sendError(res, status, parserError.message, {code: parserError.code});
        }

        const exposeMessage = err instanceof AppError
            ? err.expose || options.isDev
            : (!isServerError && (err as HttpLikeError).expose !== false) || options.isDev;
        const message = exposeMessage ? error.message : (STATUS_CODES[status] ?? "Error");

        if (err instanceof AppError && err.headers) {
            res.set(err.headers);
        }

        if (err instanceof AppError && (err.expose || options.isDev)) {
            return sendError(res, status, message, {code: err.code ?? errorCodeForStatus(status), details: err.details});
        }

        // Unexposed errors still get a code, but only the generic one of their status.
        return sendError(res, status, message, {code: errorCodeForStatus(status)});
    };
}
