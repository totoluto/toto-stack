import type {Request} from "express";

/** The raw value of a request cookie (no decoding; the stack's own cookies are base64url/ASCII). */
export function readCookie(req: Request, name: string): string | undefined {
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const separator = part.indexOf("=");
        if (separator !== -1 && part.slice(0, separator).trim() === name) {
            return part.slice(separator + 1).trim();
        }
    }

    return undefined;
}

/** `__Host-` prefixed in production (Secure, Path=/, no Domain: can't be set by subdomains). */
export function stackCookieName(isDev: boolean, sessionCookieName: string, suffix: string): string {
    return `${isDev ? "" : "__Host-"}${sessionCookieName}.${suffix}`;
}
