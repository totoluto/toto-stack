import {NotificationHandler, NotificationHandlerOptions, NotificationPayload} from "@server/libs/notifications/types";
import {metadataEntries, postJson, resolveTimeout, truncate} from "@server/libs/notifications/handlers/http";
import {escapeHtml} from "@server/libs/utils/html";

const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;
const CHAT_ID_PATTERN = /^(-?\d+|@[A-Za-z0-9_]{5,})$/;

/** Sends an HTML-formatted message through the Telegram Bot API. */
export class TelegramHandler implements NotificationHandler {
    private readonly url: URL;
    private readonly chatId: string;
    private readonly timeoutMs: number;

    constructor(botToken: string, chatId: string | number, options?: NotificationHandlerOptions) {
        // Validated so the token can't alter the request URL; never included in error messages.
        if (typeof botToken !== "string" || !BOT_TOKEN_PATTERN.test(botToken)) {
            throw new TypeError("Telegram bot token is missing or malformed (expected \"<id>:<secret>\").");
        }

        this.chatId = String(chatId ?? "").trim();
        if (!CHAT_ID_PATTERN.test(this.chatId)) {
            throw new TypeError("Telegram chat ID must be a numeric id or an @channelusername.");
        }

        this.url = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
        this.timeoutMs = resolveTimeout(options, "TelegramHandler");
    }

    async send(payload: NotificationPayload): Promise<void> {
        const lines = [`<b>${escapeHtml(payload.title)}</b>`, escapeHtml(payload.message)];

        const entries = metadataEntries(payload.metadata);
        if (entries.length > 0) {
            lines.push("", ...entries.map(([key, value]) => `<b>${escapeHtml(key)}:</b> ${escapeHtml(value)}`));
        }

        const body = {
            chat_id: this.chatId,
            // Telegram's limit is 4096 characters after entity parsing; stay well below it.
            text: truncate(lines.join("\n"), 4000),
            parse_mode: "HTML",
        };

        await postJson(this.url, body, this.timeoutMs, "Telegram API");
    }
}
