import type {
    NotificationHandler,
    NotificationPayload,
    NotificationResult,
    NotificationSendResult,
} from "@server/libs/notifications/types";
import {Logger} from "@server/libs/Logger";

/**
 * Registry of notification handlers. Sends go to all targeted handlers in
 * parallel; a failing or slow handler never blocks or hides the others, and
 * the result reports every handler's outcome. Failures are logged here.
 */
export class NotificationService {
    private readonly handlers = new Map<string, NotificationHandler>();
    private readonly logger = new Logger("NotificationService");

    public registerHandler(id: string, handler: NotificationHandler): void {
        if (!id) {
            throw new TypeError("Notification handler id must not be empty.");
        }
        if (typeof handler?.send !== "function") {
            throw new TypeError(`Notification handler "${id}" must have a send(payload) method.`);
        }

        this.handlers.set(id, handler);
    }

    public hasHandler(id: string): boolean {
        return this.handlers.has(id);
    }

    public listHandlers(): string[] {
        return [...this.handlers.keys()];
    }

    /** Sends to every registered handler. With no handlers the result is empty (`delivered: 0`). */
    public sendToAll(payload: NotificationPayload): Promise<NotificationSendResult> {
        return this.dispatch(this.listHandlers(), payload);
    }

    /** Sends to the given handler ids. Unknown ids are reported as failed results. */
    public sendToHandlers(handlerIds: readonly string[], payload: NotificationPayload): Promise<NotificationSendResult> {
        return this.dispatch([...new Set(handlerIds)], payload);
    }

    private async dispatch(ids: string[], payload: NotificationPayload): Promise<NotificationSendResult> {
        const stamped: NotificationPayload = {...payload, timestamp: payload.timestamp ?? new Date()};

        const settled = await Promise.allSettled(ids.map(async id => {
            const handler = this.handlers.get(id);
            if (!handler) {
                throw new Error(`Unknown notification handler "${id}"`);
            }
            await handler.send(stamped);
        }));

        const results = settled.map((outcome, index): NotificationResult => {
            const handler = ids[index];
            if (outcome.status === "fulfilled") {
                return {handler, ok: true};
            }

            const error = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
            this.logger.warn(`Notification handler "${handler}" failed`, {err: error, handler});
            return {handler, ok: false, error};
        });

        const delivered = results.filter(result => result.ok).length;
        return {results, delivered, failed: results.length - delivered};
    }
}
