import {NotificationHandler, NotificationHandlerOptions, NotificationPayload} from "@server/libs/notifications/types";
import {accentColor, metadataEntries, postJson, requireHttpUrl, resolveTimeout, truncate} from "@server/libs/notifications/handlers/http";

/** Posts an embed to a Discord channel webhook. */
export class DiscordHandler implements NotificationHandler {
    private readonly url: URL;
    private readonly timeoutMs: number;

    constructor(webhookUrl: string, options?: NotificationHandlerOptions) {
        this.url = requireHttpUrl(webhookUrl, "Discord webhook URL");
        this.timeoutMs = resolveTimeout(options, "DiscordHandler");
    }

    async send(payload: NotificationPayload): Promise<void> {
        // Discord limits: title 256, description 4096, 25 fields (name 256, value 1024).
        const body = {
            // Never ping @everyone/@here/users/roles from notification content.
            allowed_mentions: {parse: []},
            embeds: [
                {
                    title: truncate(payload.title, 256),
                    description: truncate(payload.message, 4096),
                    color: Number.parseInt(accentColor(payload.metadata).slice(1), 16),
                    timestamp: (payload.timestamp ?? new Date()).toISOString(),
                    fields: metadataEntries(payload.metadata).slice(0, 25).map(([name, value]) => ({
                        name: truncate(name, 256) || "-",
                        value: truncate(value, 1024) || "-",
                        inline: true,
                    })),
                },
            ],
        };

        await postJson(this.url, body, this.timeoutMs, "Discord webhook");
    }
}
