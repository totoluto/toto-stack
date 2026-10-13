import type {NotificationHandlerOptions} from "@server/libs/notifications/types";

export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 5_000;
const MAX_ERROR_BODY_LENGTH = 300;

/** Validates a handler URL at construction time (http/https only). */
export function requireHttpUrl(value: unknown, label: string): URL {
    let url: URL;
    try {
        url = new URL(String(value));
    } catch {
        throw new TypeError(`${label} must be a valid http(s) URL.`);
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError(`${label} must use http or https (got "${url.protocol}").`);
    }

    return url;
}

export function resolveTimeout(options: NotificationHandlerOptions | undefined, label: string): number {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError(`${label}: timeoutMs must be a positive number (got ${String(timeoutMs)}).`);
    }

    return timeoutMs;
}

/**
 * POSTs JSON and rejects on network errors, timeouts and non-2xx statuses.
 * The error message may contain (a truncated) remote response body: log it,
 * never return it to clients. `label` must not contain secrets (the URL of
 * some services embeds a token, so it is never part of the message).
 */
export async function postJson(url: URL, body: unknown, timeoutMs: number, label: string): Promise<void> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "error",
        });
    } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
            throw new Error(`${label} timed out after ${timeoutMs} ms`, {cause: err});
        }
        throw new Error(`${label} request failed: ${describe(err)}`, {cause: err});
    }

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        const excerpt = text.length > MAX_ERROR_BODY_LENGTH ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}...` : text;
        throw new Error(`${label} responded with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`);
    }

    // Release the connection.
    await response.body?.cancel().catch(() => undefined);
}

function describe(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.message}${cause}`;
}

/** Renders a metadata value as text. */
export function formatValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString();
    if (value === null || typeof value !== "object") return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** Metadata entries to display (without the `color` styling key). */
export function metadataEntries(metadata: Record<string, unknown> | undefined): Array<[string, string]> {
    return Object.entries(metadata ?? {})
        .filter(([key]) => key !== "color")
        .map(([key, value]) => [key, formatValue(value)]);
}

/** Accent colour from `metadata.color` ("#rrggbb"), else the default. */
export function accentColor(metadata: Record<string, unknown> | undefined): string {
    const color = metadata?.color;
    return typeof color === "string" && /^#?[0-9a-f]{6}$/i.test(color)
        ? `#${color.replace(/^#/, "").toLowerCase()}`
        : "#72a8ca";
}

export function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
