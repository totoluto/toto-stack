import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {EmailService, type EmailOptions} from "@server/libs/services/EmailService";
import {EmailHandler} from "@server/libs/notifications";
import {ConfigError, resolveConfig} from "@server/libs/config/StackConfig";
import fakePrisma from "../fakePrisma";
import {makeServer} from "../core/support";
import {captureLogs, runNode} from "./support";

const nodemailer = vi.hoisted(() => {
    const sendMail = vi.fn(async () => ({messageId: "<id@test>"}));
    const close = vi.fn();
    const createTransport = vi.fn(() => ({sendMail, close}));
    return {sendMail, close, createTransport};
});
vi.mock("nodemailer", () => ({default: {createTransport: nodemailer.createTransport}}));

const smtp = {host: "smtp.example.com", port: 587, secure: false, user: "app", pass: "pw"};

describe("EmailService", () => {
    let capture: ReturnType<typeof captureLogs>;

    beforeEach(() => {
        capture = captureLogs();
        vi.clearAllMocks();
    });

    afterEach(() => {
        capture.restore();
    });

    it("loads nodemailer lazily and reuses one pooled transporter", async () => {
        const service = new EmailService({smtp, from: "App <noreply@example.com>"});
        expect(service.isConfigured).toBe(true);
        expect(nodemailer.createTransport).not.toHaveBeenCalled();

        await service.send({to: "a@example.com", subject: "Hi\r\nBcc: victim@example.com", text: "x"});
        await service.send({to: "b@example.com", subject: "Again", text: "y"});

        expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
        expect(nodemailer.createTransport).toHaveBeenCalledWith({pool: true, host: "smtp.example.com", port: 587, secure: false, auth: {user: "app", pass: "pw"}});
        expect(nodemailer.sendMail).toHaveBeenNthCalledWith(1, expect.objectContaining({from: "App <noreply@example.com>", to: "a@example.com", subject: "Hi Bcc: victim@example.com"}));

        await service.close();
        expect(nodemailer.close).toHaveBeenCalledTimes(1);
    });

    it("is closed by server.stop()", async () => {
        const server = makeServer({email: {smtp: {host: "smtp.example.com"}, from: "noreply@example.com"}});
        await server.dependencies.emailService.send({to: "a@example.com", subject: "s", text: "t"});
        expect(nodemailer.close).not.toHaveBeenCalled();

        await server.stop();

        expect(nodemailer.close).toHaveBeenCalledTimes(1);
    });

    it("rejects when SMTP fails", async () => {
        nodemailer.sendMail.mockRejectedValueOnce(new Error("550 relay denied"));
        const service = new EmailService({smtp, from: "noreply@example.com"});

        await expect(service.send({to: "a@example.com", subject: "s", text: "t"})).rejects.toThrow("550 relay denied");
        await service.close();
    });

    it("logs one clear message at the first send when not configured, not at construction", async () => {
        const service = new EmailService();
        expect(service.isConfigured).toBe(false);
        expect(capture.all()).toBe("");

        await expect(service.send({to: "a@example.com", subject: "s"})).rejects.toThrow("Email is not configured.");
        await expect(service.send({to: "a@example.com", subject: "s"})).rejects.toThrow("Email is not configured.");

        const warnings = capture.stderr.join("").split("\n").filter(line => line.includes("Email is not configured"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("SMTP_HOST");
        expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });
});

describe("EmailHandler", () => {
    it("escapes HTML in the email and sends a text alternative", async () => {
        const sent: EmailOptions[] = [];
        const emailService = {send: async (options: EmailOptions) => void sent.push(options)} as unknown as EmailService;

        await new EmailHandler(emailService, ["ops@example.com", "dev@example.com"]).send({
            title: "<img src=x onerror=alert(1)>",
            message: "line 1\n<b>line 2</b>",
            metadata: {"\"key\"": "<v>"},
            timestamp: new Date("2026-01-02T03:04:05Z"),
        });

        expect(sent).toHaveLength(1);
        const [email] = sent;
        expect(email.to).toEqual(["ops@example.com", "dev@example.com"]);
        expect(email.subject).toBe("<img src=x onerror=alert(1)>");
        expect(email.html).not.toMatch(/<img|<b>line/);
        expect(email.html).toContain("<h2>&lt;img src=x onerror=alert(1)&gt;</h2>");
        expect(email.html).toContain("<p>line 1<br>&lt;b&gt;line 2&lt;/b&gt;</p>");
        expect(email.html).toContain("<dt><strong>&quot;key&quot;</strong></dt><dd>&lt;v&gt;</dd>");
        expect(email.text).toContain("line 1\n<b>line 2</b>");
    });

    it("validates the recipients", () => {
        expect(() => new EmailHandler({} as EmailService, "not-an-address")).toThrow(/recipient/);
        expect(() => new EmailHandler({} as EmailService, [])).toThrow(/recipient/);
    });

    it("rejects when the email service fails", async () => {
        const emailService = {send: async () => { throw new Error("Email is not configured."); }} as unknown as EmailService;
        await expect(new EmailHandler(emailService, "ops@example.com").send({title: "t", message: "m"})).rejects.toThrow("Email is not configured.");
    });
});

describe("email config", () => {
    const base = {prisma: fakePrisma};
    const dev = {NODE_ENV: "development"};

    it("is disabled without SMTP_HOST and resolved from SMTP_* env otherwise", () => {
        expect(resolveConfig(base, dev).config.email).toEqual({smtp: false, from: undefined});

        const env = {...dev, SMTP_HOST: "smtp.example.com", SMTP_PORT: "2525", SMTP_SECURE: "true", SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "noreply@example.com"};
        expect(resolveConfig(base, env).config.email).toEqual({
            smtp: {host: "smtp.example.com", port: 2525, secure: true, user: "u", pass: "p"},
            from: "noreply@example.com",
        });
        expect(resolveConfig(base, {...dev, SMTP_HOST: "relay", SMTP_FROM: "a@b.c"}).config.email.smtp).toEqual({host: "relay", port: 587, secure: false, user: undefined, pass: undefined});
    });

    it("prefers explicit config and can disable email despite env", () => {
        const env = {...dev, SMTP_HOST: "env-host", SMTP_FROM: "env@example.com"};
        expect(resolveConfig({...base, email: {smtp: false}}, env).config.email.smtp).toBe(false);
        expect(resolveConfig({...base, email: {smtp: {host: "cfg-host", secure: true}, from: "cfg@example.com"}}, env).config.email)
            .toEqual({smtp: {host: "cfg-host", port: 465, secure: true, user: undefined, pass: undefined}, from: "cfg@example.com"});
    });

    it("reports incomplete SMTP settings as ConfigError issues", () => {
        const resolve = (env: Record<string, string>) => {
            try {
                resolveConfig(base, {...dev, ...env});
                return [];
            } catch (err) {
                expect(err).toBeInstanceOf(ConfigError);
                return (err as ConfigError).issues;
            }
        };

        expect(resolve({SMTP_HOST: "h"})).toEqual([expect.stringContaining("SMTP_FROM")]);
        expect(resolve({SMTP_HOST: "h", SMTP_FROM: "a@b.c", SMTP_USER: "u"})).toEqual([expect.stringContaining("SMTP_USER and SMTP_PASS")]);
        expect(resolve({SMTP_HOST: "h", SMTP_FROM: "a@b.c", SMTP_PORT: "99999"})).toEqual([expect.stringContaining("SMTP_PORT")]);
        expect(resolve({SMTP_HOST: "h", SMTP_FROM: "a@b.c", SMTP_SECURE: "yes"})).toEqual([expect.stringContaining("SMTP_SECURE")]);
    });
});

describe("startup cost (perf)", () => {
    it.skipIf(!("registerHooks" in (process.getBuiltinModule?.("node:module") ?? {})))("does not load nodemailer when the built package is imported", () => {
        const result = runNode(`
import {registerHooks} from "node:module";
const loaded = new Set();
registerHooks({resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    const match = resolved.url.match(/node_modules\\/((?:@[^/]+\\/)?[^/]+)\\//g);
    if (match) loaded.add(match.at(-1).slice("node_modules/".length, -1));
    return resolved;
}});
await import("toto-stack");
console.log(JSON.stringify([...loaded]));
`);
        expect(result.status, result.stderr).toBe(0);
        const loaded: string[] = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
        expect(loaded).toContain("express");
        expect(loaded).not.toContain("nodemailer");
    });
});
