import {NotificationHandler, NotificationPayload} from "@server/libs/notifications/types";
import type {EmailService} from "@server/libs/services/EmailService";
import {metadataEntries} from "@server/libs/notifications/handlers/http";
import {escapeHtml} from "@server/libs/utils/html";

/**
 * Emails the notification through the stack's EmailService. Register it with
 * the factory form: `handlers: deps => ({ops: new EmailHandler(deps.emailService, "ops@example.com")})`.
 */
export class EmailHandler implements NotificationHandler {
    private readonly recipients: string[];

    constructor(private readonly emailService: EmailService, recipients: string | readonly string[]) {
        this.recipients = (typeof recipients === "string" ? [recipients] : [...recipients]).map(address => address.trim());
        if (this.recipients.length === 0 || this.recipients.some(address => !/^[^\s@]+@[^\s@]+$/.test(address))) {
            throw new TypeError("EmailHandler needs at least one valid recipient email address.");
        }
    }

    async send(payload: NotificationPayload): Promise<void> {
        const timestamp = (payload.timestamp ?? new Date()).toISOString();
        const entries = metadataEntries(payload.metadata);

        const html = [
            `<h2>${escapeHtml(payload.title)}</h2>`,
            `<p>${escapeHtml(payload.message).replace(/\n/g, "<br>")}</p>`,
            entries.length > 0
                ? `<dl>${entries.map(([key, value]) => `<dt><strong>${escapeHtml(key)}</strong></dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`
                : "",
            `<p><small>Sent at ${escapeHtml(timestamp)}</small></p>`,
        ].join("");

        const text = [
            payload.title,
            "",
            payload.message,
            ...(entries.length > 0 ? ["", ...entries.map(([key, value]) => `${key}: ${value}`)] : []),
            "",
            `Sent at ${timestamp}`,
        ].join("\n");

        await this.emailService.send({to: this.recipients, subject: payload.title, html, text});
    }
}
