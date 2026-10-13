import {expect, it} from "vitest";
import request from "supertest";
import type {Express} from "express";
import {SessionCleanup} from "@server/libs/background/jobs/SessionCleanup";
import {advanceClock, agentFor, completeSetup, csrf, postJson} from "../helpers";
import {countCalls, createRealServer, describeDb, RealPrisma, sessionIdFromCookie, sessionWriteGate, setCookie, signedSessionCookie, useDatabase} from "./support";

const OWNER_PASSWORD = "owner-password-123";
const BOB_PASSWORD = "bob-password-1234";

/** A server with an owner and a password-only user "bob". */
async function serverWithBob(prisma: RealPrisma, config = {}) {
    const {app, server} = await createRealServer(prisma, config);
    const owner = agentFor(app);
    await completeSetup(owner, "owner", OWNER_PASSWORD);
    expect((await postJson(owner, "/api/users", {username: "bob", password: BOB_PASSWORD, roles: []})).status).toBe(201);
    return {app, server, cookieName: server.config.session.cookieName};
}

/** Logs bob in; returns the agent and the raw session cookie. */
async function loginBob(app: Express, cookieName: string) {
    const agent = agentFor(app);
    const token = await csrf(agent);
    const res = await agent.post("/api/auth/login").set("X-CSRF-Token", token).send({username: "bob", password: BOB_PASSWORD});
    expect(res.body.data.authState).toBe("authenticated");
    const cookie = setCookie(res, cookieName);
    return {agent, cookie, sid: sessionIdFromCookie(cookie, cookieName)};
}

const me = (app: Express, cookie: string) => request(app).get("/api/auth/me").set("Cookie", cookie);

describeDb("sessions on MariaDB", () => {
    const db = useDatabase();

    it("stores session data as a JSON object (L12)", async () => {
        const {app, cookieName} = await serverWithBob(db.prisma());
        const {cookie, sid} = await loginBob(app, cookieName);

        const row = (await db.prisma().session.findUnique({where: {id: sid}}))!;
        expect(typeof row.data).toBe("object");
        expect(row.data).toMatchObject({userId: row.userId});
        expect((await me(app, cookie)).body.data.user?.username).toBe("bob");

        // A cookie for an unknown session id authenticates nobody.
        expect((await me(app, signedSessionCookie(cookieName, "no-such-session-id"))).body.data.user).toBeNull();
    });

    it("a revoked session is not resurrected by a request still in flight (H6)", async () => {
        const {client, hold} = sessionWriteGate(db.prisma());
        const {app, cookieName} = await serverWithBob(client);
        const laptop = await loginBob(app, cookieName);
        const phone = await loginBob(app, cookieName);

        // The phone's request loads its session, then its session write is held ...
        const gate = hold(phone.sid);
        const inFlight = phone.agent.get("/api/auth/csrf").then(res => res);
        await gate.reached;

        // ... while the laptop changes the password, which revokes every other session.
        const changed = await postJson(laptop.agent, "/api/account/password", {currentPassword: BOB_PASSWORD, newPassword: "bob-new-password-1"});
        expect(changed.status).toBe(200);
        expect(await db.prisma().session.count({where: {id: phone.sid}})).toBe(0);

        gate.release();
        await inFlight;

        expect(await db.prisma().session.count({where: {id: phone.sid}})).toBe(0);
        expect((await me(app, phone.cookie)).body.data.authState).toBe("login");
        expect((await me(app, laptop.cookie)).body.data.authState).toBe("authenticated");
    });

    it("an active session still ends at the absolute timeout (H10)", async () => {
        const absoluteTimeout = 60_000;
        const session = {absoluteTimeout, idleTimeout: 30_000, touchInterval: 10_000};
        const {app, cookieName} = await serverWithBob(db.prisma(), {session});
        const {cookie} = await loginBob(app, cookieName);

        // Activity every 20 s keeps the 30 s idle timeout from firing, but not the absolute one.
        for (let elapsed = 20_000; elapsed <= 3 * absoluteTimeout; elapsed += 20_000) {
            advanceClock(20_000);
            const state = (await me(app, cookie)).body.data.authState;
            if (elapsed < absoluteTimeout) expect(state, `after ${elapsed} ms`).toBe("authenticated");
            if (elapsed > absoluteTimeout) expect(state, `after ${elapsed} ms`).toBe("login");
        }
    });

    it("an unused session ends at the idle timeout, enforced by the server", async () => {
        const session = {absoluteTimeout: 10 * 60_000, idleTimeout: 30_000, touchInterval: 10_000};
        const {app, cookieName} = await serverWithBob(db.prisma(), {session});
        const {cookie, sid} = await loginBob(app, cookieName);

        advanceClock(20_000);
        expect((await me(app, cookie)).body.data.authState).toBe("authenticated");
        // The cookie is replayed by hand: client-side expiry plays no part.
        advanceClock(31_000);
        expect((await me(app, cookie)).body.data.authState).toBe("login");
        // The row has expired; the cleanup job removes it.
        expect((await db.prisma().session.findUnique({where: {id: sid}}))!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
        await new SessionCleanup(db.prisma()).deleteExpired();
        expect(await db.prisma().session.count({where: {id: sid}})).toBe(0);
    });

    it("the cleanup job deletes expired sessions in batches and keeps live ones", async () => {
        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 60 * 60_000);
        const expired = Array.from({length: 2500}, (_, i) => ({id: `expired-${i}`, data: {}, expiresAt: past}));
        const live = Array.from({length: 5}, (_, i) => ({id: `live-${i}`, data: {}, expiresAt: future}));
        await db.prisma().session.createMany({data: [...expired, ...live]});

        const {client, counts} = countCalls(db.prisma());
        await new SessionCleanup(client).run();

        expect(await db.prisma().session.count()).toBe(5);
        expect((await db.prisma().session.findMany({select: {id: true}})).map(row => row.id).sort()).toEqual(live.map(row => row.id));
        // Batched: more than one bounded DELETE instead of one statement over every expired row.
        const deletes = (counts.get("session.deleteMany") ?? 0) + (counts.get("$executeRaw") ?? 0) + (counts.get("$executeRawUnsafe") ?? 0);
        expect(deletes).toBeGreaterThan(1);
    });
});
