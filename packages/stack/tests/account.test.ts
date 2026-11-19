import crypto from "node:crypto";
import {describe, expect, it} from "vitest";
import request from "supertest";
import {createOwnerContext, postJson} from "./helpers";

const opaque = (id: string) => crypto.createHash("sha256").update(id).digest("base64url");

describe("account settings read", () => {
    it("revokes a listed opaque handle only after password confirmation and retains raw-ID support", async () => {
        const {owner, prisma} = await createOwnerContext();
        const user = (await prisma.user.findFirst({where: {username: "owner"}}))!;
        const other = await prisma.user.create({data: {username: "other", password: "secret"}});
        const data = {userId: user.id, data: {}, expiresAt: new Date(Date.now() + 60000)};
        for (const id of ["device-raw", "legacy-raw"]) await prisma.session.create({data: {...data, id}});
        await prisma.session.create({data: {...data, id: "foreign-raw", userId: other.id}});
        const listing = await owner.get("/api/account");
        const handle = listing.body.data.sessions.find((session: {id: string}) => session.id === opaque("device-raw")).id;
        const denied = await postJson(owner, "/api/account/revoke-session", {password: "wrong", sessionID: handle});
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe("PASSWORD_CONFIRMATION_FAILED");
        expect(await prisma.session.findUnique({where: {id: "device-raw"}})).not.toBeNull();
        expect((await postJson(owner, "/api/account/revoke-session", {password: "owner-password-123", sessionID: handle})).status).toBe(200);
        expect(await prisma.session.findUnique({where: {id: "device-raw"}})).toBeNull();
        for (const sessionID of [opaque("foreign-raw"), "foreign-raw", "missing", "legacy-raw"]) {
            expect((await postJson(owner, "/api/account/revoke-session", {password: "owner-password-123", sessionID})).status).toBe(200);
        }
        expect(await prisma.session.findUnique({where: {id: "foreign-raw"}})).not.toBeNull();
        expect(await prisma.session.findUnique({where: {id: "legacy-raw"}})).toBeNull();
        expect((await owner.get("/api/account")).body.data.sessions).toHaveLength(1);
    });

    it("reports API-key enablement without exposing its stored hash", async () => {
        const {owner, prisma} = await createOwnerContext();
        const key = await postJson(owner, "/api/account/api-key", {password: "owner-password-123"});
        const stored = (await prisma.user.findFirst({where: {username: "owner"}}))!;
        const res = await owner.get("/api/account");
        expect(res.body.data.account.apiKeyEnabled).toBe(true);
        expect(res.text).not.toContain(key.body.data.apiKey);
        expect(res.text).not.toContain(stored.apiKey!);
    });
    it("requires session authentication and refuses a valid Bearer key", async () => {
        const {app, owner} = await createOwnerContext();
        const anonymous = await request(app).get("/api/account");
        expect(anonymous.status).toBe(401);
        expect(anonymous.body.code).toBe("UNAUTHORIZED");
        const issued = await postJson(owner, "/api/account/api-key", {password: "owner-password-123"});
        const bearer = await request(app).get("/api/account").set("Authorization", `Bearer ${issued.body.data.apiKey}`);
        expect(bearer.status).toBe(400);
        expect(bearer.body.code).toBe("BEARER_NOT_ALLOWED");
        const mixed = await owner.get("/api/account").set("Authorization", `Bearer ${issued.body.data.apiKey}`);
        expect(mixed.status).toBe(400);
        expect(mixed.body.code).toBe("BEARER_NOT_ALLOWED");
    });
    it("returns only the caller's active session metadata and safe account flags", async () => {
        const {owner, prisma} = await createOwnerContext();
        const user = (await prisma.user.findFirst({where: {username: "owner"}}))!;
        const current = (await prisma.session.findFirst({where: {userId: user.id}}))!;
        const foreign = await prisma.user.create({data: {username: "foreign", password: "foreign-secret"}});
        const now = Date.now();
        const older = {id: "other-raw-cookie", userId: user.id, data: {secret: "session-secret"}, ipAddress: null, userAgent: null, createdAt: new Date(now - 2000), lastSeenAt: new Date(now - 1000), expiresAt: new Date(now + 60000)};
        await prisma.session.create({data: older});
        const newest = {...older, id: "newest-raw-cookie", lastSeenAt: new Date(now + 1000), ipAddress: "192.0.2.5", userAgent: "Another browser"};
        await prisma.session.create({data: newest});
        await prisma.session.create({data: {...older, id: "expired-cookie", expiresAt: new Date(now - 1)}});
        await prisma.session.create({data: {...older, id: "foreign-cookie", userId: foreign.id}});
        await prisma.session.create({data: {...older, id: "anonymous-cookie", userId: null}});
        const res = await owner.get("/api/account");
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.body.status).toBe("success");
        expect(res.body.data).toEqual({
            account: {id: user.id, username: "owner", roles: ["owner"], otpEnabled: true, apiKeyEnabled: false},
            sessions: [
                {id: opaque(newest.id), current: false, ipAddress: newest.ipAddress, userAgent: newest.userAgent, createdAt: newest.createdAt.toISOString(), lastSeenAt: newest.lastSeenAt.toISOString(), expiresAt: newest.expiresAt.toISOString()},
                {id: opaque(current.id), current: true, ipAddress: current.ipAddress, userAgent: current.userAgent, createdAt: current.createdAt.toISOString(), lastSeenAt: current.lastSeenAt.toISOString(), expiresAt: current.expiresAt.toISOString()},
                {id: opaque(older.id), current: false, ipAddress: null, userAgent: null, createdAt: older.createdAt.toISOString(), lastSeenAt: older.lastSeenAt.toISOString(), expiresAt: older.expiresAt.toISOString()},
            ],
        });
        for (const secret of [user.password, user.otpSecret!, current.id, older.id, newest.id, "session-secret", "foreign-cookie", "expired-cookie"]) {
            expect(res.text).not.toContain(secret);
        }
    });
});
