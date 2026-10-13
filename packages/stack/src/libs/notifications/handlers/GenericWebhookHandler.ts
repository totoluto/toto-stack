import {NotificationHandler, NotificationHandlerOptions, NotificationPayload} from "@server/libs/notifications/types";
import {postJson, requireHttpUrl, resolveTimeout} from "@server/libs/notifications/handlers/http";

/** POSTs the payload as JSON: `{title, message, metadata, timestamp}`. */
export class GenericWebhookHandler implements NotificationHandler {
    private readonly url: URL;
    private readonly timeoutMs: number;

    constructor(webhookUrl: string, options?: NotificationHandlerOptions) {
        this.url = requireHttpUrl(webhookUrl, "Webhook URL");
        this.timeoutMs = resolveTimeout(options, "GenericWebhookHandler");
    }

    async send(payload: NotificationPayload): Promise<void> {
        const body = {
            title: payload.title,
            message: payload.message,
            metadata: payload.metadata,
            timestamp: (payload.timestamp ?? new Date()).toISOString(),
        };

        await postJson(this.url, body, this.timeoutMs, "Webhook");
    }
}
