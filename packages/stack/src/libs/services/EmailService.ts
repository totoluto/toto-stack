import type {Transporter} from "nodemailer";
import {Logger} from "@server/libs/Logger";
import type {ResolvedSmtpConfig} from "@server/libs/config/StackConfig";

export interface EmailOptions {
    to: string | string[];
    subject: string;
    text?: string;
    /** HTML body. Escape every interpolated value (the stack's own templates do). */
    html?: string;
    replyTo?: string;
}

export type EmailServiceOptions = {
    /** SMTP settings, or `false` when email is not configured. */
    smtp: ResolvedSmtpConfig | false;
    /** Sender address (required to send). */
    from?: string;
};

/** Pooled SMTP connections are closed after this much idle time so they don't keep the process alive. */
const IDLE_CLOSE_MS = 30_000;

/**
 * Sends email over SMTP. Configured from `email` in createServer() (or the
 * SMTP_* env variables, resolved by the config layer). nodemailer is only
 * loaded when the first email is sent, and one pooled transporter is reused.
 */
export class EmailService {
    private readonly logger = new Logger("EmailService");
    private transporter?: Promise<Transporter>;
    private inFlight = 0;
    private idleTimer?: NodeJS.Timeout;
    private warnedNotConfigured = false;

    constructor(private readonly options: EmailServiceOptions = {smtp: false}) {}

    /** Whether SMTP is configured (sending can still fail at runtime). */
    public get isConfigured(): boolean {
        return this.options.smtp !== false && Boolean(this.options.from);
    }

    /** Sends one email. Rejects when email is not configured or the SMTP server refuses it. */
    public async send(email: EmailOptions): Promise<void> {
        const {smtp, from} = this.options;
        if (smtp === false || !from) {
            if (!this.warnedNotConfigured) {
                this.warnedNotConfigured = true;
                this.logger.warn("Email is not configured; emails are not sent. Set SMTP_HOST and SMTP_FROM (or `email` in createServer()) to enable it.");
            }
            throw new Error("Email is not configured.");
        }

        this.inFlight++;
        clearTimeout(this.idleTimer);
        try {
            const transporter = await this.getTransporter(smtp);
            const info = await transporter.sendMail({
                from,
                to: email.to,
                replyTo: email.replyTo,
                // Header values must be single-line.
                subject: email.subject.replace(/[\r\n]+/g, " "),
                text: email.text,
                html: email.html,
            });
            this.logger.debug("Email sent", {messageId: info.messageId});
        } finally {
            this.inFlight--;
            this.scheduleIdleClose();
        }
    }

    /** Closes the pooled SMTP connections (a later send() reconnects). */
    public async close(): Promise<void> {
        clearTimeout(this.idleTimer);
        const transporter = this.transporter;
        this.transporter = undefined;
        (await transporter?.catch(() => undefined))?.close();
    }

    private getTransporter(smtp: ResolvedSmtpConfig): Promise<Transporter> {
        this.transporter ??= import("nodemailer").then(({default: nodemailer}) => nodemailer.createTransport({
            pool: true,
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: smtp.user !== undefined ? {user: smtp.user, pass: smtp.pass} : undefined,
        })).catch((err: unknown) => {
            this.transporter = undefined;
            throw err;
        });

        return this.transporter;
    }

    private scheduleIdleClose(): void {
        if (this.inFlight > 0 || !this.transporter) return;

        this.idleTimer = setTimeout(() => {
            if (this.inFlight === 0) void this.close();
        }, IDLE_CLOSE_MS);
        this.idleTimer.unref();
    }
}
