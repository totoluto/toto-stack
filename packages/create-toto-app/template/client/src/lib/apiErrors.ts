import {ApiError, ErrorCode} from "toto-stack/client";

// User-facing messages for codes where the server's text isn't specific or
// friendly enough. Codes not listed (e.g. RATE_LIMITED, whose message names
// the wait time, or BAD_REQUEST) show the server's message.
const MESSAGES: Partial<Record<ErrorCode, string>> = {
    // generic
    [ErrorCode.UNAUTHORIZED]: "Your session has ended. Please sign in again.",
    [ErrorCode.FORBIDDEN]: "You don't have permission to do that.",
    [ErrorCode.NOT_FOUND]: "That doesn't exist (anymore).",
    [ErrorCode.INVALID_JSON]: "The request was malformed. Please reload the page and try again.",
    [ErrorCode.PAYLOAD_TOO_LARGE]: "That's too much data to send at once.",
    [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: "The request format isn't supported. Please reload the page and try again.",
    [ErrorCode.INTERNAL_ERROR]: "Something went wrong on the server. Please try again.",
    [ErrorCode.SERVICE_UNAVAILABLE]: "The service is temporarily unavailable. Please try again shortly.",
    [ErrorCode.OVERLOADED]: "Server is busy, please retry in a moment.",
    [ErrorCode.INVALID_RESPONSE]: "Unexpected response from the server. Please try again.",
    [ErrorCode.CSRF_INVALID]: "Your session changed. Please reload the page and try again.",
    [ErrorCode.ORIGIN_NOT_ALLOWED]: "This site's address is not in the server's ALLOWED_ORIGINS.",
    // setup and sign-in
    [ErrorCode.SETUP_TOKEN_INVALID]:
        "Invalid setup token. Use SETUP_TOKEN from the server's .env, or the one-time token the server printed at startup.",
    [ErrorCode.SETUP_TOKEN_CHANGED]: "The server restarted or its setup token changed. Please start the setup again.",
    [ErrorCode.SETUP_NOT_STARTED]: "The setup expired. Please start again.",
    [ErrorCode.SETUP_COMPLETED]: "Setup is already completed. Please sign in.",
    [ErrorCode.MFA_NOT_PENDING]: "Your sign-in expired. Please sign in again.",
};

/** Turns anything thrown by apiFetch into a message for the user. */
export function errorMessage(error: unknown): string {
    if (error instanceof ApiError) {
        const message = error.code ? MESSAGES[error.code as ErrorCode] : undefined;
        if (message) return message;
        if (error.code === ErrorCode.VALIDATION_FAILED && Array.isArray(error.details) && error.details.length > 0) {
            return error.details
                .map((issue: {path?: string; message?: string}) => [issue.path, issue.message].filter(Boolean).join(": "))
                .join(" ");
        }
        return error.message;
    }
    if (error instanceof TypeError) return "Can't reach the server. Check your connection and try again.";
    return error instanceof Error ? error.message : String(error);
}

/** The ApiError code of an error, if any. */
export function errorCode(error: unknown): string | undefined {
    return error instanceof ApiError ? error.code : undefined;
}
