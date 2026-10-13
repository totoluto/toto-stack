export interface NotificationPayload {
    title: string;
    message: string;
    /** Extra key/value pairs shown by the handlers. `color` ("#rrggbb") sets the Discord/Slack accent colour. */
    metadata?: Record<string, unknown>;
    /** Default: the time NotificationService sends it. */
    timestamp?: Date;
}

/**
 * Delivers a notification to one destination. `send` must reject when the
 * notification was not delivered, and should not take longer than a few
 * seconds (the built-in handlers time out after 5 s by default).
 */
export interface NotificationHandler {
    send(payload: NotificationPayload): Promise<void>;
}

/** Options shared by the built-in HTTP handlers. */
export type NotificationHandlerOptions = {
    /** Abort the HTTP request after this many ms. Default: 5000. */
    timeoutMs?: number;
};

/** Outcome of one handler. The error is for server-side logging; don't send it to clients. */
export type NotificationResult =
    | {readonly handler: string; readonly ok: true}
    | {readonly handler: string; readonly ok: false; readonly error: Error};

export type NotificationSendResult = {
    /** One entry per targeted handler, in the requested (or registration) order. */
    readonly results: readonly NotificationResult[];
    /** Number of handlers that delivered the notification. */
    readonly delivered: number;
    /** Number of handlers that failed (including unknown handler ids). */
    readonly failed: number;
};
