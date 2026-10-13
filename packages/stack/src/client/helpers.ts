import type {WebResponse} from "../shared/types/web";
import {ErrorCode} from "../shared/errorCodes";

/**
 * `code` of an ApiError: one of the stack's ErrorCodes (including the
 * client-side `INVALID_RESPONSE`), or a code sent by an app route.
 */
export type ApiErrorCode = ErrorCode | (string & {});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Thrown by apiFetch for every non-success response: HTTP errors, error
 * envelopes, empty or non-JSON bodies. Network failures and aborts are not
 * wrapped (fetch's own TypeError / AbortError propagate).
 */
export class ApiError extends Error {
    /** HTTP status (e.g. 403, 502). */
    public readonly status: number;
    /** Machine-readable code from the error envelope, or `INVALID_RESPONSE` when the body wasn't the API's JSON. */
    public readonly code?: ApiErrorCode;
    /** `details` from the error envelope (e.g. validation issues). */
    public readonly details?: unknown;

    constructor(status: number, message: string, options: {code?: ApiErrorCode; details?: unknown} = {}) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = options.code;
        this.details = options.details;
    }
}

export type ApiClientOptions = {
    /**
     * Prefix for relative request paths (those starting with "/"), e.g.
     * "https://api.example.com". Default: "" (same origin).
     */
    baseUrl?: string;
    /** Path of the CSRF token endpoint (relative to `baseUrl`). Default: "/api/auth/csrf". */
    csrfPath?: string;
};

export type ApiFetchOptions<T> = RequestInit & {
    /**
     * Validates and converts the response `data` (e.g. a zod schema's
     * `parse`). Without it the type argument is an unchecked assertion about
     * what the server returns.
     */
    parse?: (data: unknown) => T;
};

const settings: Required<ApiClientOptions> = {baseUrl: "", csrfPath: "/api/auth/csrf"};

let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;
// Incremented by clearCsrfToken() so a token fetched for an older session is never cached.
let csrfGeneration = 0;

/** Configures apiFetch (call once at startup). Unset options keep their defaults. */
export function configureApiClient(options: ApiClientOptions): void {
    if (options.baseUrl !== undefined) settings.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (options.csrfPath !== undefined) settings.csrfPath = options.csrfPath;
    clearCsrfToken();
}

/**
 * Forgets the cached CSRF token. The server binds the token to the session,
 * so call this whenever the session changes (UserProvider does it on
 * setUser/setAuthStage/logout).
 */
export function clearCsrfToken(): void {
    csrfToken = null;
    csrfRequest = null;
    csrfGeneration++;
}

function resolveUrl(url: string): string {
    return url.startsWith("/") && !url.startsWith("//") ? `${settings.baseUrl}${url}` : url;
}

/** The cached token, or one shared in-flight request for it. */
function getCsrfToken(): Promise<string> {
    if (csrfToken) return Promise.resolve(csrfToken);
    if (csrfRequest) return csrfRequest;

    const generation = csrfGeneration;
    const request = (async () => {
        const res = await fetch(resolveUrl(settings.csrfPath), {
            credentials: "include",
            headers: {Accept: "application/json"},
        });
        const data = await readEnvelope<{token?: unknown}>(res);
        if (typeof data?.token !== "string" || !data.token) {
            throw new ApiError(res.status, "The CSRF endpoint returned no token.", {code: ErrorCode.INVALID_RESPONSE});
        }

        if (generation === csrfGeneration) csrfToken = data.token;
        return data.token;
    })();

    csrfRequest = request;
    // Clear the shared request once settled (success is cached in csrfToken; failures are retried next time).
    request.then(
        () => { if (csrfRequest === request) csrfRequest = null; },
        () => { if (csrfRequest === request) csrfRequest = null; },
    );

    return request;
}

/** Bodies the browser must label itself (multipart boundary, blob type, form encoding). */
function hasNativeContentType(body: BodyInit): boolean {
    return (typeof FormData !== "undefined" && body instanceof FormData)
        || (typeof Blob !== "undefined" && body instanceof Blob)
        || (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams);
}

/** A body that can be sent a second time (streams can't). */
function isReplayable(body: BodyInit | null | undefined): boolean {
    return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}

function isCsrfFailure(error: ApiError): boolean {
    return error.status === 403 && error.code === ErrorCode.CSRF_INVALID;
}

/**
 * Reads a toto-stack JSON envelope. Returns `data` for a success envelope,
 * `undefined` for empty 2xx responses (204), and throws ApiError otherwise.
 */
async function readEnvelope<T>(res: Response): Promise<T | undefined> {
    const text = res.status === 204 || res.status === 205 || res.status === 304 ? "" : await res.text();
    const fallbackMessage = `Request failed with status ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`;

    if (!text.trim()) {
        if (res.ok) return undefined;
        throw new ApiError(res.status, fallbackMessage);
    }

    let body: Partial<WebResponse<T>>;
    try {
        body = JSON.parse(text) as Partial<WebResponse<T>>;
    } catch {
        // e.g. an HTML error page from a proxy (502/504) or a misrouted request.
        throw new ApiError(res.status, res.ok ? "The server returned a response that is not JSON." : fallbackMessage, {code: ErrorCode.INVALID_RESPONSE});
    }

    if (typeof body !== "object" || body === null) {
        throw new ApiError(res.status, res.ok ? "The server returned an unexpected response." : fallbackMessage, {code: ErrorCode.INVALID_RESPONSE});
    }

    if (!res.ok || body.status === "error") {
        const message = typeof body.message === "string" && body.message ? body.message : fallbackMessage;
        throw new ApiError(res.status, message, {
            code: typeof body.code === "string" ? body.code : undefined,
            details: body.details,
        });
    }

    return body.data;
}

/**
 * fetch() for the toto-stack JSON API. Sends cookies, attaches the CSRF token
 * to unsafe methods (fetched once and shared by concurrent requests), retries
 * once with a fresh token when the server rejects it, and resolves to the
 * envelope's `data` (`undefined` for 204 / no data). Every failure response
 * rejects with an ApiError carrying the HTTP status and the server's `code`.
 *
 * String bodies are sent as `application/json` unless a Content-Type is set;
 * FormData, Blob and URLSearchParams bodies keep the browser's Content-Type.
 *
 * @param url - API path (prefixed with the configured baseUrl) or absolute URL
 */
export async function apiFetch<T = unknown>(url: string, options: ApiFetchOptions<T> = {}): Promise<T> {
    const {parse, ...init} = options;
    const method = (init.method ?? "GET").toUpperCase();
    const needsCsrf = !SAFE_METHODS.has(method);

    let sentToken: string | undefined;
    const send = async (): Promise<T> => {
        const headers = new Headers(init.headers);
        if (!headers.has("Accept")) headers.set("Accept", "application/json");
        if (init.body != null && !headers.has("Content-Type") && !hasNativeContentType(init.body)) {
            headers.set("Content-Type", "application/json");
        }
        if (needsCsrf) {
            sentToken = await getCsrfToken();
            headers.set("X-CSRF-Token", sentToken);
        }

        const res = await fetch(resolveUrl(url), {...init, method, credentials: init.credentials ?? "include", headers});
        const data = await readEnvelope<unknown>(res);
        return parse ? parse(data) : (data as T);
    };

    try {
        return await send();
    } catch (err) {
        if (needsCsrf && err instanceof ApiError && isCsrfFailure(err) && isReplayable(init.body)) {
            // Only drop the token this request used; a concurrent request may already have fetched a new one.
            if (csrfToken === sentToken) clearCsrfToken();
            return send();
        }
        throw err;
    }
}
