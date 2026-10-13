import {NotificationHandler, NotificationHandlerOptions, NotificationPayload} from "@server/libs/notifications/types";
import {accentColor, metadataEntries, postJson, requireHttpUrl, resolveTimeout} from "@server/libs/notifications/handlers/http";

/** Slack treats `<...>` as links/mentions (`<!channel>`); these three characters must be escaped. */
function escapeSlack(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Posts an attachment to a Slack incoming webhook. */
export class SlackHandler implements NotificationHandler {
    private readonly url: URL;
    private readonly timeoutMs: number;

    constructor(webhookUrl: string, options?: NotificationHandlerOptions) {
        this.url = requireHttpUrl(webhookUrl, "Slack webhook URL");
        this.timeoutMs = resolveTimeout(options, "SlackHandler");
    }

    async send(payload: NotificationPayload): Promise<void> {
        const fields = metadataEntries(payload.metadata).map(([title, value]) => ({
            title: escapeSlack(title),
            value: escapeSlack(value),
            short: true,
        }));

        const body = {
            attachments: [
                {
                    color: accentColor(payload.metadata),
                    fallback: escapeSlack(`${payload.title}: ${payload.message}`),
                    title: escapeSlack(payload.title),
                    text: escapeSlack(payload.message),
                    ts: Math.floor((payload.timestamp ?? new Date()).getTime() / 1000),
                    fields: fields.length > 0 ? fields : undefined,
                },
            ],
        };

        await postJson(this.url, body, this.timeoutMs, "Slack webhook");
    }
}
