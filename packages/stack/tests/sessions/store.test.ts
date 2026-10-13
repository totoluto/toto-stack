import {beforeEach, describe, expect, it} from "vitest";
import type {SessionData} from "express-session";
import {BaseRoute, type Dependencies} from "toto-stack";
import {SessionStore, parseSessionData} from "@server/libs/SessionStore";
import {advanceClock, agentFor, csrf, postJson} from "../helpers";
import {countedServer, DAY, fakePrisma, HOUR, MINUTE, resetFakeDb, sessionIdOf, sessionRows, setCookies, sleep, withLoggedInUser} from "./support";

// H6, L12, M13: the express-session Store contract.

const OPTIONS = {absoluteTimeout: 7 * DAY, idleTimeout: DAY, touchInterval: 5 * MINUTE};

function newStore(options = OPTIONS) {
    return new SessionStore(fakePrisma, options);
}

function call<T = void>(fn: (callback: (err: unknown, value?: T) => void) => void): Promise<T | undefined> {
    return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));
}

/** What express-session does with a stored session: get() + createSession() (cf. Store.prototype.load). */
async function loadSession(store: SessionStore, sid: string) {
    const data = await call<SessionData | null>(cb => store.get(sid, cb));
    if (!data) return null;
    return store.createSession({sessionID: sid, sessionStore: store} as never, data);
}

function sessionData(extra: Record<string, unknown> = {}): SessionData {
    return {cookie: {originalMaxAge: OPTIONS.absoluteTimeout, expires: new Date(Date.now() + OPTIONS.absoluteTimeout), httpOnly: true, path: "/"}, ...extra} as unknown as SessionData;
}

async function rowOf(sid: string) {
    return (await sessionRows()).find(row => row.id === sid);
}

beforeEach(() => {
    resetFakeDb();
});

describe("SessionStore writes (H6)", () => {
    it("concurrent saves of one session keep the last write (none is dropped)", async () => {
        const store = newStore();
        await call(cb => store.set("sid-1", sessionData({note: "initial"}), cb));
        const first = (await loadSession(store, "sid-1"))!;
        const second = (await loadSession(store, "sid-1"))!;

        // The first write is slow: without per-session ordering it would land last.
        const updateMany = fakePrisma.session.updateMany;
        let writes = 0;
        fakePrisma.session.updateMany = async args => {
            const delay = writes++ === 0 ? 30 : 1;
            await sleep(delay);
            return updateMany(args);
        };

        try {
            Object.assign(first, {note: "first"});
            Object.assign(second, {note: "second"});
            await Promise.all([call(cb => store.set("sid-1", first, cb)), call(cb => store.set("sid-1", second, cb))]);
        } finally {
            fakePrisma.session.updateMany = updateMany;
        }

        expect(writes).toBe(2);
        expect((await rowOf("sid-1"))!.data).toMatchObject({note: "second"});
    });

    it("never recreates a session that was destroyed while a request held it", async () => {
        const store = newStore();
        await fakePrisma.user.create({data: {id: 1, username: "user-1", password: "x"}}); // Session.userId is a foreign key
        await call(cb => store.set("sid-2", sessionData({userId: 1, authenticatedAt: Date.now()}), cb));
        const inFlight = (await loadSession(store, "sid-2"))!;

        await call(cb => store.destroy("sid-2", cb));

        Object.assign(inFlight, {note: "changed"});
        await call(cb => store.set("sid-2", inFlight, cb));
        advanceClock(HOUR);
        await call(cb => store.touch("sid-2", inFlight, cb));
        await call(cb => store.set("sid-2", inFlight, cb));

        expect(await rowOf("sid-2")).toBeUndefined();
    });

    it("touch() on a missing row is a no-op", async () => {
        const store = newStore();
        await call(cb => store.set("sid-3", sessionData(), cb));
        const session = (await loadSession(store, "sid-3"))!;
        await fakePrisma.session.deleteMany({where: {id: "sid-3"}});

        advanceClock(HOUR);
        await expect(call(cb => store.touch("sid-3", session, cb))).resolves.toBeUndefined();
        // Not loaded by this store at all: nothing to extend, no error
        await expect(call(cb => store.touch("unknown", sessionData(), cb))).resolves.toBeUndefined();
        expect(await sessionRows()).toEqual([]);
    });

    it("passes database errors to the callbacks", async () => {
        const store = newStore();
        const boom = new Error("db down");
        const original = {...fakePrisma.session};
        fakePrisma.session.findUnique = async () => { throw boom; };
        fakePrisma.session.create = async () => { throw boom; };
        fakePrisma.session.deleteMany = async () => { throw boom; };

        try {
            await expect(call<SessionData | null>(cb => store.get("x", cb))).rejects.toBe(boom);
            await expect(call(cb => store.set("x", sessionData(), cb))).rejects.toBe(boom);
            await expect(call(cb => store.destroy("x", cb))).rejects.toBe(boom);
        } finally {
            Object.assign(fakePrisma.session, original);
        }
    });

    it("get() never writes", async () => {
        const store = newStore();
        await call(cb => store.set("sid-4", sessionData(), cb));
        const before = await rowOf("sid-4");

        advanceClock(2 * HOUR);
        expect(await loadSession(store, "sid-4")).not.toBeNull();
        expect(await rowOf("sid-4")).toEqual(before);
    });
});

describe("SessionStore data (L12, M13)", () => {
    it("stores and reads the session as a JSON object", async () => {
        const store = newStore();
        await fakePrisma.user.create({data: {id: 7, username: "user-7", password: "x"}}); // Session.userId is a foreign key
        await call(cb => store.set("sid-5", sessionData({userId: 7}), cb));
        const row = (await rowOf("sid-5"))!;
        expect(typeof row.data).toBe("object");
        expect(row.data).toMatchObject({userId: 7, cookie: {path: "/"}});

        const loaded = (await loadSession(store, "sid-5"))!;
        expect(loaded.userId).toBe(7);
        expect(loaded.cookie.expires).toBeInstanceOf(Date);

        Object.assign(loaded, {note: "changed"});
        await call(cb => store.set("sid-5", loaded, cb));
        expect((await rowOf("sid-5"))!.data).toMatchObject({userId: 7, note: "changed"});
    });

    it.each([
        ["a string instead of an object", "{not json"],
        ["a JSON-encoded object stored as a string", JSON.stringify({cookie: {path: "/"}, userId: 1})],
        ["no cookie", {userId: 1}],
        ["a cookie that is not an object", {cookie: "x"}],
        ["an invalid cookie expiry", {cookie: {expires: "yesterday-ish", originalMaxAge: 1000}}],
        ["a wrongly typed cookie field", {cookie: {originalMaxAge: "soon"}}],
        ["an array", [1, 2]],
        ["null", null],
    ])("destroys a corrupt row (%s) and returns null", async (_label, data) => {
        const store = newStore();
        await fakePrisma.session.create({
            data: {id: "bad", data, userId: null, ipAddress: null, userAgent: null, createdAt: new Date(Date.now()), lastSeenAt: new Date(Date.now()), expiresAt: new Date(Date.now() + HOUR)},
        });

        expect(await call<SessionData | null>(cb => store.get("bad", cb))).toBeNull();
        expect(await rowOf("bad")).toBeUndefined();
    });

    it("keeps only the known cookie fields", () => {
        const parsed = parseSessionData({cookie: {originalMaxAge: 5, path: "/", maxAge: 9, evil: true}, userId: 1});
        expect(parsed).toEqual({cookie: {originalMaxAge: 5, path: "/"}, userId: 1});
    });

    it("truncates the user agent and stores only valid IP addresses", async () => {
        const store = newStore();
        await call(cb => store.set("sid-6", sessionData({userAgent: "x".repeat(5000), ipAddress: "not-an-ip"}), cb));
        const row = (await rowOf("sid-6"))!;
        expect(row.userAgent).toHaveLength(512);
        expect(row.ipAddress).toBeNull();

        await call(cb => store.set("sid-7", sessionData({ipAddress: "2001:db8::1"}), cb));
        expect((await rowOf("sid-7"))!.ipAddress).toBe("2001:db8::1");
    });

    it("bounds a session without cookie expiry (browser-session cookie) by the idle and absolute limits", async () => {
        const store = newStore();
        const data = {cookie: {originalMaxAge: null, httpOnly: true, path: "/"}} as unknown as SessionData;
        await call(cb => store.set("sid-8", data, cb));
        const row = (await rowOf("sid-8"))!;
        expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(OPTIONS.idleTimeout);
    });
});

describe("in-flight requests and revocation (H6)", () => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;

    class SlowRoute extends BaseRoute {
        constructor(dependencies: Dependencies) {
            super("/slow", dependencies);
        }

        protected registerRoutes(): void {
            this.get("/", async (req, res) => {
                entered();
                await new Promise<void>(resolve => (release = resolve));
                if (req.query.modify) req.session.csrfToken = "changed-by-a-slow-request";
                res.json({ok: true});
            });
        }
    }

    it.each([["modifies (save)", "?modify=1"], ["only reads (touch)", ""]])("a request that %s cannot resurrect a revoked session", async (_label, query) => {
        const {app} = await countedServer({routes: [SlowRoute], session: {touchInterval: 0}});
        const {owner, user} = await withLoggedInUser(app);
        const login = await postJson(agentFor(app), "/api/auth/login", {username: "user", password: "user-password-123"});
        const sid = sessionIdOf(setCookies(login).find(cookie => cookie.startsWith("connect.sid="))!);
        expect(await rowOf(sid)).toBeDefined();

        // The user's request is in flight (session loaded) ...
        const started = new Promise<void>(resolve => (entered = resolve));
        const slow = user.get(`/api/slow${query}`).then(res => res);
        await started;

        // ... when the user's sessions are revoked (here: the owner deletes all of them)
        await fakePrisma.session.deleteMany({where: {userId: 2}});
        advanceClock(MINUTE);
        release();

        expect((await slow).status).toBe(200);
        expect((await sessionRows()).filter(row => row.userId === 2)).toEqual([]);
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");
        expect((await owner.get("/api/auth/me")).body.data.authState).toBe("authenticated");
    });

    it("a corrupt row signs the browser out instead of failing every request", async () => {
        const {app} = await countedServer();
        const {user} = await withLoggedInUser(app);
        const [row] = (await sessionRows()).filter(r => r.userId === 2);
        await fakePrisma.session.update({where: {id: row.id}, data: {data: "{corrupt"}});

        const res = await user.get("/api/auth/me");
        expect(res.status).toBe(200);
        expect(res.body.data.authState).toBe("login");
        expect(await rowOf(row.id)).toBeUndefined();
        expect((await csrf(user))).toMatch(/^a\./);
    });
});
