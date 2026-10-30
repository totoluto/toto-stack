/**
 * Machine-readable `code` of every error response the stack sends (the
 * `{status: "error", message, code, details?}` envelope). Clients should
 * branch on these, not on messages. When a 5xx is not exposed, production
 * responses carry only the status's generic code (e.g. INTERNAL_ERROR).
 *
 * "MFA required" is not an error: POST /api/auth/login answers 200 with
 * `authState: "otp"` (likewise "setup-verify" during setup).
 *
 * App routes may send their own codes (`AppError(status, message, {code})`).
 */
export const ErrorCode = {
    // Generic: sent by any route, or derived from the HTTP status when no specific code applies.
    /** 400: malformed request (no more specific code). */
    BAD_REQUEST: "BAD_REQUEST",
    /** 400: the request body is not valid JSON. */
    INVALID_JSON: "INVALID_JSON",
    /** 400: the body failed schema validation; `details` lists the issues ({path, message}). */
    VALIDATION_FAILED: "VALIDATION_FAILED",
    /** 401: not signed in (no or expired session, invalid API key). */
    UNAUTHORIZED: "UNAUTHORIZED",
    /** 403: signed in, but missing the required role. */
    FORBIDDEN: "FORBIDDEN",
    /** 404: no such endpoint or resource. */
    NOT_FOUND: "NOT_FOUND",
    /** 409: conflicts with the current state (no more specific code). */
    CONFLICT: "CONFLICT",
    /** 413: the request body exceeds `http.bodyLimit`. */
    PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    /** 415: unsupported request body encoding or charset. */
    UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
    /** 429: a rate limit was hit; see the Retry-After header. */
    RATE_LIMITED: "RATE_LIMITED",
    /** 503: the server is overloaded (e.g. too many password checks queued); retry after the Retry-After header. */
    OVERLOADED: "OVERLOADED",
    /** 500: unexpected server error (details are logged, not sent). */
    INTERNAL_ERROR: "INTERNAL_ERROR",
    /** 503: temporarily unavailable (no more specific code). */
    SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",

    // Request security
    /** 403: missing/invalid X-CSRF-Token (fetch a new one from GET /api/auth/csrf and retry). */
    CSRF_INVALID: "CSRF_INVALID",
    /** 403: the Origin header is not in the allowlist. */
    ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
    /** 400: a session endpoint was called with an `Authorization: Bearer` header. */
    BEARER_NOT_ALLOWED: "BEARER_NOT_ALLOWED",

    // First-run setup
    /** 403: setup is already completed. */
    SETUP_COMPLETED: "SETUP_COMPLETED",
    /** 403: wrong setup token. */
    SETUP_TOKEN_INVALID: "SETUP_TOKEN_INVALID",
    /** 403: the setup token changed since /setup/start (e.g. restart with a generated token); start again. */
    SETUP_TOKEN_CHANGED: "SETUP_TOKEN_CHANGED",
    /** 400: /setup/verify without a (live) /setup/start. */
    SETUP_NOT_STARTED: "SETUP_NOT_STARTED",

    // MFA
    /** 401: /login/verify without a (live) pending MFA login; log in again. */
    MFA_NOT_PENDING: "MFA_NOT_PENDING",
    /** 400: wrong, expired or already used TOTP code (account endpoints). */
    MFA_INVALID: "MFA_INVALID",
    /** 409 */
    MFA_ALREADY_ENABLED: "MFA_ALREADY_ENABLED",
    /** 409 */
    MFA_NOT_ENABLED: "MFA_NOT_ENABLED",
    /** 400: /account/mfa/verify without a (live) /account/mfa/start. */
    MFA_ENROLLMENT_NOT_STARTED: "MFA_ENROLLMENT_NOT_STARTED",

    // Account and user management (built-in /api/account and /api/users;
    // USERNAME_TAKEN also comes from userService.createUser)
    /** 403: the current password given for a sensitive change is wrong. */
    PASSWORD_CONFIRMATION_FAILED: "PASSWORD_CONFIRMATION_FAILED",
    /** 409 */
    USERNAME_TAKEN: "USERNAME_TAKEN",
    /** 403: only an owner may grant owner/admin. */
    ROLE_NOT_GRANTABLE: "ROLE_NOT_GRANTABLE",
    /** 400 */
    INVALID_USER_ID: "INVALID_USER_ID",
    /** 404 */
    USER_NOT_FOUND: "USER_NOT_FOUND",
    /** 400: users can't delete their own account. */
    CANNOT_DELETE_SELF: "CANNOT_DELETE_SELF",
    /** 403: owners can't be deleted; admins can't delete admins. */
    USER_PROTECTED: "USER_PROTECTED",

    // Notifications (the template's POST /api/notifications/send)
    /** 503: no notification handler is configured. */
    NO_HANDLERS: "NO_HANDLERS",
    /** 400: `handlers` names an unknown handler id; `details.unknown` lists them. */
    UNKNOWN_HANDLER: "UNKNOWN_HANDLER",
    /** 502: every targeted handler failed; `details.results` has the per-handler ok flags. */
    DELIVERY_FAILED: "DELIVERY_FAILED",

    // Client side (never sent by the server)
    /** apiFetch: the response was not the API's JSON envelope (e.g. a proxy's HTML error page). */
    INVALID_RESPONSE: "INVALID_RESPONSE",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
