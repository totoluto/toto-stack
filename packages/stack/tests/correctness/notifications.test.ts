import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import http from "node:http";
import type {AddressInfo} from "node:net";
import {NotificationService} from "@server/libs/services/NotificationService";
import {DiscordHandler, GenericWebhookHandler, SlackHandler, TelegramHandler} from "@server/libs/notifications";
import type {NotificationHandler, NotificationPayload} from "@server/libs/notifications";
import {captureLogs, sleep} from "./support";

const payload: NotificationPayload = {title: "Deploy", message: "Release 1.2 is live", timestamp: new Date("2026-01-02T03:04:05Z")};

// A local webhook receiver: /ok -> 204, /fail -> 500 with a body, /slow -> never answers in time.
let server: http.Server;
let base: string;
const received: Array<{path: string; body: unknown}> = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", chunk => (raw += chunk));
        req.on("end", () => {
            received.push({path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined});
            if (req.url === "/ok") return void res.writeHead(204).end();
            if (req.url === "/fail") return void res.writeHead(500, {"Content-Type": "text/plain"}).end("internal: token=SECRET-REMOTE-DETAIL");
            if (req.url === "/slow") return void setTimeout(() => res.writeHead(204).end(), 2_000);
            res.writeHead(404).end();
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
});

describe("NotificationService", () => {
    let capture: ReturnType<typeof captureLogs> | undefined;
    afterEach(() => {
        capture?.restore();
        capture = undefined;
    });

    it("reports an empty result with zero handlers", async () => {
        const result = await new NotificationService().sendToAll(payload);
        expect(result).toEqual({results: [], delivered: 0, failed: 0});
    });

    it("reports a failing handler without throwing, and logs the error server-side", async () => {
        capture = captureLogs();
        const service = new NotificationService();
        service.registerHandler("broken", {send: async () => { throw new Error("remote said no"); }});

        const result = await service.sendToAll(payload);

        expect(result.delivered).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.results[0]).toMatchObject({handler: "broken", ok: false, error: expect.objectContaining({message: "remote said no"})});
        expect(capture.stderr.join("")).toMatch(/\[WARN\]\[NotificationService\] Notification handler "broken" failed/);
        expect(capture.stderr.join("")).toContain("remote said no");
    });

    it("times out a slow webhook and still delivers to the others, in parallel", async () => {
        capture = captureLogs("error");
        const service = new NotificationService();
        service.registerHandler("slow", new GenericWebhookHandler(`${base}/slow`, {timeoutMs: 150}));
        service.registerHandler("ok", new GenericWebhookHandler(`${base}/ok`));
        const serial: NotificationHandler = {send: async () => { await sleep(100); }};
        service.registerHandler("serial", serial);

        const started = Date.now();
        const result = await service.sendToAll(payload);
        const elapsed = Date.now() - started;

        expect(result.results.map(r => [r.handler, r.ok])).toEqual([["slow", false], ["ok", true], ["serial", true]]);
        const slow = result.results[0];
        expect(slow.ok === false && slow.error.message).toBe("Webhook timed out after 150 ms");
        expect(elapsed).toBeLessThan(1_000);
        expect(result).toMatchObject({delivered: 2, failed: 1});
    });

    it("sends mixed results to selected handlers and reports unknown ids", async () => {
        capture = captureLogs("error");
        const service = new NotificationService();
        const sent: NotificationPayload[] = [];
        service.registerHandler("a", {send: async p => void sent.push(p)});
        service.registerHandler("b", new GenericWebhookHandler(`${base}/fail`));
        service.registerHandler("c", {send: async p => void sent.push(p)});

        const result = await service.sendToHandlers(["a", "b", "missing", "a"], {title: "t", message: "m"});

        expect(result.results.map(r => [r.handler, r.ok])).toEqual([["a", true], ["b", false], ["missing", false]]);
        expect(result).toMatchObject({delivered: 1, failed: 2});
        expect(sent).toHaveLength(1);
        expect(sent[0].timestamp).toBeInstanceOf(Date);
        const failure = result.results[1];
        expect(failure.ok === false && failure.error.message).toBe("Webhook responded with status 500: internal: token=SECRET-REMOTE-DETAIL");
    });

    it("rejects invalid registrations", () => {
        const service = new NotificationService();
        expect(() => service.registerHandler("", {send: async () => undefined})).toThrow(/empty/);
        expect(() => service.registerHandler("x", {} as NotificationHandler)).toThrow(/send/);
    });
});

describe("built-in handlers", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("validate their configuration at construction", () => {
        expect(() => new GenericWebhookHandler("")).toThrow(/valid http\(s\) URL/);
        expect(() => new DiscordHandler("ftp://example.com/hook")).toThrow(/http or https/);
        expect(() => new SlackHandler("javascript:alert(1)")).toThrow(/http or https/);
        expect(() => new GenericWebhookHandler("https://example.com/hook", {timeoutMs: 0})).toThrow(/timeoutMs/);
        expect(() => new TelegramHandler("123:abc/../../x", "42")).toThrow(/bot token/);
        expect(() => new TelegramHandler("123:abc", "not a chat")).toThrow(/chat ID/);
        expect(() => new TelegramHandler("123456:AA-bb_CC", -100123)).not.toThrow();
    });

    it("escape user content where markup is rendered (Telegram HTML, Slack), and never ping in Discord", async () => {
        const bodies: Record<string, unknown> = {};
        vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
            bodies[url.hostname] = JSON.parse(String(init.body));
            return new Response(null, {status: 200});
        }));
        const hostile: NotificationPayload = {
            title: "<b>x</b> & <!channel>",
            message: "<script>alert(1)</script> @everyone",
            metadata: {"<i>key</i>": "<a href='x'>v</a>", color: "#FF0000", nested: {a: 1}},
            timestamp: payload.timestamp,
        };

        await new TelegramHandler("123:abc", "42").send(hostile);
        await new SlackHandler("https://hooks.slack.example/x").send(hostile);
        await new DiscordHandler("https://discord.example/api/webhooks/1/x").send(hostile);

        const telegram = bodies["api.telegram.org"] as {text: string; parse_mode: string};
        expect(telegram.parse_mode).toBe("HTML");
        expect(telegram.text).toBe(
            "<b>&lt;b&gt;x&lt;/b&gt; &amp; &lt;!channel&gt;</b>\n&lt;script&gt;alert(1)&lt;/script&gt; @everyone\n\n"
            + "<b>&lt;i&gt;key&lt;/i&gt;:</b> &lt;a href=&#39;x&#39;&gt;v&lt;/a&gt;\n<b>nested:</b> {&quot;a&quot;:1}",
        );

        const slack = (bodies["hooks.slack.example"] as {attachments: Array<Record<string, unknown>>}).attachments[0];
        expect(slack.title).toBe("&lt;b&gt;x&lt;/b&gt; &amp; &lt;!channel&gt;");
        expect(slack.text).toBe("&lt;script&gt;alert(1)&lt;/script&gt; @everyone");
        expect(slack.color).toBe("#ff0000");
        expect(slack.fields).toEqual([
            {title: "&lt;i&gt;key&lt;/i&gt;", value: "&lt;a href='x'&gt;v&lt;/a&gt;", short: true},
            {title: "nested", value: "{\"a\":1}", short: true},
        ]);

        const discord = bodies["discord.example"] as {allowed_mentions: unknown; embeds: Array<Record<string, unknown>>};
        expect(discord.allowed_mentions).toEqual({parse: []});
        expect(discord.embeds[0]).toMatchObject({color: 0xff0000, timestamp: "2026-01-02T03:04:05.000Z"});
    });

    it("never put the Telegram bot token into error messages", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));

        const error = await new TelegramHandler("123:SECRETTOKEN", "42").send(payload).catch(e => e);

        expect(error.message).toBe("Telegram API request failed: fetch failed");
        expect(String(error.message)).not.toContain("SECRETTOKEN");
    });
});
