import {afterEach, beforeEach, describe, expect, it} from "vitest";
import request from "supertest";
import type {NotificationHandlers} from "toto-stack";
import {resetFakeDb} from "../fakePrisma";
import {makeServer} from "../core/support";
import {captureLogs} from "../correctness/support";

const REMOTE_SECRET = "upstream says: invalid token xoxb-123-SECRET";

// The template's NotificationRoute (server/routes), mounted by makeServer().
async function appWith(handlers: NotificationHandlers | undefined) {
    const server = makeServer({notifications: {handlers}});
    const app = await server.createApp();
    const {userService} = server.dependencies;
    const apiKey = await userService.issueApiKey((await userService.createUser("boss", "a-long-password", ["owner"])).id);
    const send = (body: object) => request(app).post("/api/notifications/send").set("Authorization", `Bearer ${apiKey}`).send(body);
    return {send};
}

const ok = {send: async () => undefined};
const failing = {send: async () => { throw new Error(REMOTE_SECRET); }};

describe("POST /api/notifications/send (template route)", () => {
    let capture: ReturnType<typeof captureLogs>;

    beforeEach(() => {
        resetFakeDb();
        capture = captureLogs();
    });

    afterEach(() => {
        capture.restore();
    });

    it("returns 503 NO_HANDLERS instead of 'sent' when no handler is configured (H7)", async () => {
        const {send} = await appWith(undefined);

        const res = await send({title: "t", message: "m"});

        expect(res.status).toBe(503);
        expect(res.body).toEqual({status: "error", message: "No notification handlers are configured.", code: "NO_HANDLERS"});
    });

    it("returns 502 DELIVERY_FAILED when every handler fails, without leaking the remote error (L30)", async () => {
        const {send} = await appWith({primary: failing, backup: failing});

        const res = await send({title: "t", message: "m"});

        expect(res.status).toBe(502);
        expect(res.body).toEqual({
            status: "error",
            message: "The notification could not be delivered.",
            code: "DELIVERY_FAILED",
            details: {results: [{handler: "primary", ok: false}, {handler: "backup", ok: false}]},
        });
        expect(JSON.stringify(res.body)).not.toContain("SECRET");
        expect(capture.all()).toContain(REMOTE_SECRET); // logged server-side instead
    });

    it("returns 200 with per-handler results when at least one handler succeeded", async () => {
        const {send} = await appWith({primary: failing, backup: ok});

        const res = await send({title: "t", message: "m", metadata: {env: "prod", build: 7}});

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            status: "success",
            message: "Notification sent to 1 of 2 handlers.",
            data: {delivered: 1, failed: 1, results: [{handler: "primary", ok: false}, {handler: "backup", ok: true}]},
        });
        expect(JSON.stringify(res.body)).not.toContain("SECRET");
    });

    it("targets selected handlers and rejects unknown ids with 400", async () => {
        const {send} = await appWith({primary: failing, backup: ok});

        const targeted = await send({title: "t", message: "m", handlers: ["backup"]});
        expect(targeted.status).toBe(200);
        expect(targeted.body.message).toBe("Notification sent.");
        expect(targeted.body.data.results).toEqual([{handler: "backup", ok: true}]);

        const unknown = await send({title: "t", message: "m", handlers: ["backup", "nope"]});
        expect(unknown.status).toBe(400);
        expect(unknown.body).toMatchObject({code: "UNKNOWN_HANDLER", details: {unknown: ["nope"]}});
    });

    it("validates the payload strictly", async () => {
        const {send} = await appWith({backup: ok});

        expect((await send({title: "t", message: "m", extra: 1})).status).toBe(400);
        expect((await send({title: "t", message: "m", metadata: {nested: {a: 1}}})).status).toBe(400);
        expect((await send({title: "   ", message: "m"})).status).toBe(400);
    });
});
