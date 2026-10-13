import {describe, expect, it} from "vitest";
import {ConfigError} from "toto-stack";
import {resolveConfig} from "@server/libs/config/StackConfig";
import {advanceClock, agentFor, completeSetup, csrf, postJson, totp} from "../helpers";
import {countedServer, DAY, fakePrisma, HOUR, MINUTE, sessionIdOf, sessionRows, setCookies, withLoggedInUser} from "./support";

// H10: absolute and idle timeouts, enforced server-side.

async function userRow() {
    const rows = (await sessionRows()).filter(row => row.userId === 2);
    expect(rows).toHaveLength(1);
    return rows[0];
}

describe("absolute session lifetime (H10)", () => {
    it("ends the session 7 days after sign-in even when it is used every day (the day-30 PoC fails)", async () => {
        const {app} = await countedServer();
        const {user} = await withLoggedInUser(app);
        const signedIn = Date.now();

        // Daily use keeps the idle timer alive, but never moves the absolute deadline
        for (let day = 1; day <= 6; day++) {
            advanceClock(DAY - HOUR);
            expect((await user.get("/api/auth/me")).body.data.authState).toBe("authenticated");
            const row = await userRow();
            expect(row.expiresAt.getTime()).toBeLessThanOrEqual(signedIn + 7 * DAY + 1000);
        }

        // 6.5 days: now + idleTimeout would be past the deadline, so the expiry is capped at it
        advanceClock(18 * HOUR);
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("authenticated");
        expect((await userRow()).expiresAt.getTime()).toBeLessThanOrEqual(signedIn + 7 * DAY + 1000);

        advanceClock(13 * HOUR); // 7 days and 1 hour
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");

        // Replaying the cookie on day 30
        advanceClock(23 * DAY);
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("authenticate() rejects a session older than the absolute lifetime even if its row looks valid", async () => {
        const {app} = await countedServer();
        const {user} = await withLoggedInUser(app);
        const row = await userRow();

        // Simulate a row whose expiry was extended (e.g. edited in the database) with an old sign-in time
        const data = row.data as Record<string, unknown>;
        await fakePrisma.session.update({where: {id: row.id}, data: {data: {...data, authenticatedAt: Date.now() - 8 * DAY}, createdAt: new Date(Date.now())}});
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("applies a lowered absoluteTimeout to existing sessions", async () => {
        const {app} = await countedServer({session: {absoluteTimeout: 2 * HOUR, idleTimeout: HOUR}});
        const {user} = await withLoggedInUser(app);
        expect((await userRow()).expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(HOUR);

        for (let i = 0; i < 3; i++) {
            advanceClock(35 * MINUTE);
            expect((await user.get("/api/auth/me")).body.data.authState).toBe("authenticated");
        }

        advanceClock(35 * MINUTE); // 2h20 after sign-in
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("keeps a re-sent cookie within the absolute lifetime", async () => {
        const {app} = await countedServer();
        const {user} = await withLoggedInUser(app);
        const signedIn = Date.now();

        for (let i = 0; i < 4; i++) {
            advanceClock(20 * HOUR);
            await user.get("/api/auth/me");
        }
        const res = await user.get("/api/auth/csrf"); // creates the session CSRF token: the session changes, the cookie is re-sent
        const cookie = setCookies(res).find(header => header.startsWith("connect.sid="))!;
        const expires = Date.parse(/Expires=([^;]+)/.exec(cookie)![1]);

        expect(expires).toBeLessThanOrEqual(signedIn + 7 * DAY + 1000);
        expect(expires).toBeGreaterThan(signedIn + 7 * DAY - 60_000);
    });
});

describe("idle timeout (H10)", () => {
    it("ends a session after idleTimeout without requests", async () => {
        const {app} = await countedServer({session: {idleTimeout: 2 * HOUR, touchInterval: 10 * MINUTE}});
        const {user} = await withLoggedInUser(app);

        // Activity keeps it alive well past one idle period
        for (let i = 0; i < 5; i++) {
            advanceClock(HOUR);
            expect((await user.get("/api/auth/me")).body.data.authState).toBe("authenticated");
        }

        advanceClock(2 * HOUR + 1000);
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("may end up to touchInterval early, never late", async () => {
        const {app} = await countedServer({session: {idleTimeout: HOUR, touchInterval: 10 * MINUTE}});
        const {user} = await withLoggedInUser(app);

        advanceClock(5 * MINUTE);
        await user.get("/api/auth/me"); // throttled: activity not recorded
        advanceClock(HOUR - 4 * MINUTE); // 61 min after the last recorded activity
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("pending MFA logins expire with their own deadline, including the row", async () => {
        const {app} = await countedServer();
        const owner = agentFor(app);
        const {secret} = await completeSetup(owner, "owner", "owner-password-123");

        const pending = agentFor(app);
        const login = await postJson(pending, "/api/auth/login", {username: "owner", password: "owner-password-123"});
        expect(login.body.data.authState).toBe("otp");
        const sid = sessionIdOf(setCookies(login).find(header => header.startsWith("connect.sid="))!);
        const row = (await sessionRows()).find(r => r.id === sid)!;
        expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * MINUTE);

        // Polling doesn't keep it alive past 10 minutes
        for (let i = 0; i < 4; i++) {
            advanceClock(3 * MINUTE);
            await pending.get("/api/auth/me");
        }
        expect((await sessionRows()).find(r => r.id === sid)!.expiresAt.getTime()).toBe(row.expiresAt.getTime());
        expect((await pending.get("/api/auth/me")).body.data.authState).toBe("login");
        const token = await csrf(pending);
        const verify = await pending.post("/api/auth/login/verify").set("X-CSRF-Token", token).send({token: totp(secret)});
        expect(verify.status).toBe(401);
    });
});

describe("session timeout config", () => {
    const base = {prisma: fakePrisma};
    const resolve = (session: object) => resolveConfig({...base, session}, {NODE_ENV: "test"}).config.session;
    const issues = (session: object) => {
        try {
            resolveConfig({...base, session}, {NODE_ENV: "test"});
            return [];
        } catch (err) {
            return (err as ConfigError).issues;
        }
    };

    it("derives idle and touch defaults from the other limits", () => {
        expect(resolve({absoluteTimeout: HOUR})).toMatchObject({absoluteTimeout: HOUR, idleTimeout: HOUR, touchInterval: 5 * MINUTE});
        expect(resolve({idleTimeout: 4 * MINUTE})).toMatchObject({idleTimeout: 4 * MINUTE, touchInterval: 2 * MINUTE});
    });

    it("rejects inconsistent limits and prefixed cookie names", () => {
        expect(issues({idleTimeout: 8 * DAY})).toEqual([expect.stringContaining("must not exceed session.absoluteTimeout")]);
        expect(issues({idleTimeout: HOUR, touchInterval: HOUR})).toEqual([expect.stringContaining("must be shorter than session.idleTimeout")]);
        expect(issues({touchInterval: -1})).toHaveLength(1);
        expect(issues({absoluteTimeout: 1.5})).toHaveLength(1);
        expect(issues({cookieName: "__Host-sid"})).toEqual([expect.stringContaining("added automatically")]);
    });
});
