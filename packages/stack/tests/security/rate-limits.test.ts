import {afterEach, describe, expect, it, vi} from "vitest";
import request from "supertest";
import type {Express, Request} from "express";
import type {Server} from "node:http";
import {createServer} from "toto-stack";
import {Logger} from "@server/libs/Logger";
import {AuthRateLimiter} from "@server/libs/security/AuthRateLimiter";
import {MemoryRateLimitStore, RateLimitStore} from "@server/libs/security/RateLimitStore";
import {rateLimitClientKey} from "@server/libs/security/clientIp";
import {advanceClock, agentFor, csrf, postJson} from "../helpers";
import {fakePrisma, freshServer, loginAgent, serverWithOwner, createUserVia} from "./support";
import {resetFakeDb} from "../fakePrisma";

const OWNER_PASSWORD = "owner-password-123";

afterEach(() => {
    vi.restoreAllMocks();
});

/** One login attempt from a fresh agent, optionally with an X-Forwarded-For value. */
async function login(app: Express | Server, username: string, password: string, xff?: string) {
    const agent = request.agent(app);
    const token = await csrf(agent);
    const req = agent.post("/api/auth/login").set("X-CSRF-Token", token);
    if (xff) req.set("X-Forwarded-For", xff);
    return req.send({username, password});
}

describe("client keys (H7)", () => {
    const fakeReq = (ip: string | undefined, remoteAddress = "10.9.9.9") => ({ip, socket: {remoteAddress}}) as unknown as Request;

    it("validates and normalises addresses", () => {
        expect(rateLimitClientKey(fakeReq("203.0.113.7"))).toBe("203.0.113.7");
        expect(rateLimitClientKey(fakeReq("::ffff:203.0.113.7"))).toBe("203.0.113.7");
        expect(rateLimitClientKey(fakeReq("2001:db8:1:2:3:4:5:6"))).toBe("2001:db8:1:2::/64");
        expect(rateLimitClientKey(fakeReq("2001:db8:1:2::9"))).toBe("2001:db8:1:2::/64");
        expect(rateLimitClientKey(fakeReq("fe80::1%eth0"))).toBe("fe80:0:0:0::/64");
        // Login/setup group IPv6 per /56 (the 256 /64s of one delegation count as one client)
        expect(rateLimitClientKey(fakeReq("2001:db8:1:2ff::1"), 56)).toBe("2001:db8:1:200::/56");
        expect(rateLimitClientKey(fakeReq("2001:db8:1:200::1"), 56)).toBe("2001:db8:1:200::/56");
        expect(rateLimitClientKey(fakeReq("2001:db8:1:300::1"), 56)).toBe("2001:db8:1:300::/56");
        expect(rateLimitClientKey(fakeReq("203.0.113.7"), 56)).toBe("203.0.113.7");
        // Garbage forwarded by a trusted proxy falls back to the socket peer
        expect(rateLimitClientKey(fakeReq("__proto__"))).toBe("10.9.9.9");
        expect(rateLimitClientKey(fakeReq("constructor"))).toBe("10.9.9.9");
        expect(rateLimitClientKey({ip: undefined, socket: {}} as unknown as Request)).toBe("unknown");
    });

    it("X-Forwarded-For __proto__ does not pollute Object.prototype", async () => {
        const {app} = await freshServer({http: {trustProxy: 1}});

        for (const xff of ["__proto__", "constructor", "toString"]) {
            const res = await request(app).get("/api/status").set("X-Forwarded-For", xff);
            expect(res.status).toBe(200);
        }
        const login = await request(app).get("/api/auth/csrf").set("X-Forwarded-For", "__proto__");
        expect(login.status).toBe(200);

        expect(({} as Record<string, unknown>).count).toBeUndefined();
        expect(({} as Record<string, unknown>).resetAt).toBeUndefined();
        expect(Object.keys(Object.prototype)).toEqual([]);
    });

    it("rotating X-Forwarded-For does not bypass per-IP limits when trustProxy is false (default)", async () => {
        const {app} = await freshServer();
        const statuses: number[] = [];
        for (let i = 0; i < 22; i++) {
            statuses.push((await login(app, `user${i}`, "nope", `10.0.0.${i}`)).status);
        }

        expect(statuses.slice(0, 20).every(status => status === 200)).toBe(true);
        expect(statuses.slice(20)).toEqual([429, 429]);
    });
});

describe("login lockout (M3)", () => {
    it("rotating IPv6 /64s inside one /56 shares one per-IP login budget", async () => {
        const {app} = await freshServer({http: {trustProxy: 1}});
        const statuses: number[] = [];
        for (let i = 0; i < 21; i++) {
            statuses.push((await login(app, `user${i}`, "nope", `2001:db8:5:${(0x100 + i).toString(16)}::1`)).status);
        }
        expect(statuses.slice(0, 20).every(status => status === 200)).toBe(true);
        expect(statuses[20]).toBe(429);
    });

    it("a distributed attack that exhausts the account ceiling doesn't lock the user out of a known browser (device cookie)", async () => {
        const {app, owner} = await serverWithOwner({http: {trustProxy: 1}, security: {passwordHashing: {concurrency: 4}}}, OWNER_PASSWORD);
        await createUserVia(owner, "bob", "bob-password-123");

        // Bob signed in from this browser before: it holds a device cookie
        const bobBrowser = agentFor(app);
        const signIn = async () => {
            const token = await csrf(bobBrowser); // before the request is created
            return bobBrowser.post("/api/auth/login").set("X-CSRF-Token", token).set("X-Forwarded-For", "198.51.100.7").send({username: "bob", password: "bob-password-123"});
        };
        const first = await signIn();
        expect(first.body.data.authState).toBe("authenticated");
        expect(String(first.headers["set-cookie"])).toMatch(/connect\.sid\.device=v1\./);

        // 20 attacker IPs x 5 wrong passwords = the full 100/15 min account ceiling
        // (one listening server: supertest's per-request servers race under this parallelism)
        const listener = app.listen(0, "127.0.0.1");
        await new Promise(resolve => listener.once("listening", resolve));
        try {
            for (let batch = 0; batch < 20; batch += 4) {
                const attempts = [0, 1, 2, 3].flatMap(offset => Array.from({length: 5}, () => login(listener, "bob", "wrong-password", `203.0.113.${batch + offset}`)));
                expect((await Promise.all(attempts)).map(res => res.status)).toEqual(Array(20).fill(200));
            }
        } finally {
            listener.close();
        }

        // The ceiling is really reached: new IPs, and Bob from a fresh browser, are blocked
        expect((await login(app, "bob", "wrong-password", "192.0.2.200")).status).toBe(429);
        const freshBrowser = await login(app, "bob", "bob-password-123", "198.51.100.7");
        expect(freshBrowser.status).toBe(429);
        expect(freshBrowser.body.code).toBe("RATE_LIMITED");

        // ...but Bob's known browser still signs in from his own IP
        const known = await signIn();
        expect(known.status).toBe(200);
        expect(known.body.data.authState).toBe("authenticated");
    });

    it("trusts only valid, unexpired device cookies for the same account", async () => {
        const {LoginDeviceTrust} = await import("@server/libs/security/LoginDeviceTrust");
        const {resolveConfig} = await import("@server/libs/config/StackConfig");
        const {config} = resolveConfig({prisma: fakePrisma}, {NODE_ENV: "test"});
        const devices = new LoginDeviceTrust(config);

        let issued = "";
        const res = {cookie: (name: string, value: string) => void (issued = `${name}=${value}`)};
        const reqWith = (cookie?: string) => ({headers: cookie ? {cookie} : {}}) as unknown as Request;
        devices.remember(reqWith(), res as never, "Bob");

        expect(devices.trustedDevice(reqWith(issued), "bob")).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(devices.trustedDevice(reqWith(issued), " BOB ")).toBeDefined();
        expect(devices.trustedDevice(reqWith(issued), "alice")).toBeUndefined();
        expect(devices.trustedDevice(reqWith(issued.slice(0, -1) + (issued.endsWith("A") ? "B" : "A")), "bob")).toBeUndefined();
        expect(devices.trustedDevice(reqWith(), "bob")).toBeUndefined();

        // Renewing keeps the device id
        const deviceId = devices.trustedDevice(reqWith(issued), "bob");
        devices.remember(reqWith(issued), res as never, "bob");
        expect(devices.trustedDevice(reqWith(issued), "bob")).toBe(deviceId);

        // Another server secret doesn't accept it
        const other = new LoginDeviceTrust(resolveConfig({prisma: fakePrisma}, {NODE_ENV: "test"}).config);
        expect(other.trustedDevice(reqWith(issued), "bob")).toBeUndefined();

        advanceClock(181 * 24 * 60 * 60 * 1000);
        expect(devices.trustedDevice(reqWith(issued), "bob")).toBeUndefined();
    });

    it("a trusted device is still limited per account+IP and per device", async () => {
        const limiter = new AuthRateLimiter(new MemoryRateLimitStore());
        for (let i = 0; i < 5; i++) expect((await limiter.consumeLogin("192.0.2.9", "bob", "device-1")).allowed).toBe(true);
        expect((await limiter.consumeLogin("192.0.2.9", "bob", "device-1")).allowed).toBe(false);

        for (let ip = 10; ip < 15; ip++) {
            for (let i = 0; i < 2; i++) await limiter.consumeLogin(`192.0.2.${ip}`, "bob", "device-2");
        }
        expect((await limiter.consumeLogin("192.0.2.99", "bob", "device-2")).allowed).toBe(false);
    });

    it("attackers elsewhere don't lock the real user out of their own IP", async () => {
        const {app} = await serverWithOwner({http: {trustProxy: 1}}, OWNER_PASSWORD);

        for (let i = 0; i < 6; i++) {
            expect((await login(app, "OWNER ", "wrong-password", `203.0.113.${i}`)).status).toBe(200);
        }

        // The same account from one attacker IP is locked
        for (let i = 0; i < 5; i++) await login(app, "owner", "wrong-password", "198.51.100.66");
        expect((await login(app, "owner", "wrong-password", "198.51.100.66")).status).toBe(429);

        // ...but the owner, from their own IP, gets through (to the MFA step)
        const victim = await login(app, "owner", OWNER_PASSWORD, "198.51.100.7");
        expect(victim.status).toBe(200);
        expect(victim.body.data.authState).toBe("otp");
    });

    it("a correct password clears the account+IP lockout and isn't counted against the IP", async () => {
        const {app, owner} = await serverWithOwner({}, OWNER_PASSWORD);
        await createUserVia(owner, "bob", "bob-password-123");

        for (let i = 0; i < 4; i++) await login(app, "bob", "wrong-password");
        await loginAgent(app, "bob", "bob-password-123");
        for (let i = 0; i < 4; i++) {
            expect((await login(app, "bob", "wrong-password")).status).toBe(200);
        }
    });

    it("stops at the first exceeded tier: no per-account counters once the IP is blocked (M4)", async () => {
        const store = new MemoryRateLimitStore();
        const limiter = new AuthRateLimiter(store);

        for (let i = 0; i < 20; i++) {
            expect((await limiter.consumeLogin("192.0.2.1", `name-${i}`)).allowed).toBe(true);
        }
        const sizeAtLimit = store.size;
        expect(sizeAtLimit).toBe(1 + 20 + 20);

        for (let i = 20; i < 100; i++) {
            const result = await limiter.consumeLogin("192.0.2.1", `name-${i}`);
            expect(result.allowed).toBe(false);
            expect(result.retryAfterSeconds).toBeGreaterThan(0);
        }
        expect(store.size).toBe(sizeAtLimit);
    });

    it("logs one warning per key and window, without the username (L31)", async () => {
        const warn = vi.spyOn(Logger.prototype, "warn");
        const limiter = new AuthRateLimiter(new MemoryRateLimitStore());

        // 15 attempts: only the account+IP tier (5) is exceeded, the IP tier (20) is not
        for (let i = 0; i < 15; i++) await limiter.consumeLogin("192.0.2.1", "Secret-Looking\nName");
        const warnings = warn.mock.calls.map(([message]) => String(message));

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("login per account and IP");
        expect(warnings[0]).not.toContain("Secret");
        expect(warnings[0]).not.toContain("\n");

        advanceClock(16 * 60 * 1000);
        for (let i = 0; i < 15; i++) await limiter.consumeLogin("192.0.2.1", "Secret-Looking\nName");
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("the global limiter logs once per client and window", async () => {
        const warn = vi.spyOn(Logger.prototype, "warn");
        const {RateLimiter} = await import("@server/libs/security/RateLimiter");
        const limiter = new RateLimiter(60_000, 3);
        const express = (await import("express")).default;
        const app = express().use(limiter.middleware()).get("/", (_req, res) => res.send("ok"));

        const statuses: number[] = [];
        for (let i = 0; i < 10; i++) statuses.push((await request(app).get("/")).status);

        expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
        expect(warn.mock.calls.filter(([message]) => String(message).includes("Rate limit exceeded"))).toHaveLength(1);
    });
});

describe("bucket pruning (M4)", () => {
    it("prunes expired windows and keeps live ones", async () => {
        const store = new MemoryRateLimitStore();
        store.increment("short", 1_000);
        store.increment("long", 60 * 60 * 1000);
        expect(store.size).toBe(2);

        advanceClock(2_000);
        expect(store.prune()).toBe(1);
        expect(store.size).toBe(1);
    });

    it("sweeps on an unref'd timer between start() and stop()", () => {
        vi.useFakeTimers({toFake: ["setInterval", "clearInterval", "Date"]});
        try {
            const store = new MemoryRateLimitStore();
            store.start();
            store.increment("k", 1_000);
            advanceClock(2_000);
            vi.advanceTimersByTime(61_000);
            expect(store.size).toBe(0);
            store.stop();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("the server starts and stops the configured store with its lifecycle", async () => {
        resetFakeDb();
        const calls: string[] = [];
        const inner = new MemoryRateLimitStore();
        const store: RateLimitStore = {
            increment: (key, windowMs) => inner.increment(key, windowMs),
            decrement: key => inner.decrement(key),
            reset: key => inner.reset(key),
            start: () => void calls.push("start"),
            stop: () => void calls.push("stop"),
        };
        const server = createServer({prisma: fakePrisma, logger: {patchConsole: false}, http: {port: 0, host: "127.0.0.1"}, security: {rateLimitStore: store}});

        await server.start();
        await server.stop();
        expect(calls).toEqual(["start", "stop"]);
    });
});

describe("re-authentication and CSRF endpoint limits (H9, M4)", () => {
    it("rate-limits password confirmation per account", async () => {
        const {app, owner} = await serverWithOwner({}, OWNER_PASSWORD);
        await createUserVia(owner, "carol", "carol-password-1");
        const carol = await loginAgent(app, "carol", "carol-password-1");

        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
            statuses.push((await postJson(carol, "/api/account/api-key", {password: `wrong-${i}`})).status);
        }

        expect(statuses.slice(0, 10).every(status => status === 403)).toBe(true);
        expect(statuses[10]).toBe(429);
        // The correct password is refused too until the window ends (each check costs a hash)
        const res = await postJson(carol, "/api/account/api-key", {password: "carol-password-1"});
        expect(res.status).toBe(429);
        expect(res.body.code).toBe("RATE_LIMITED");
        expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("rate-limits GET /api/auth/csrf per IP", async () => {
        const {app} = await freshServer();
        let last = 0;
        for (let i = 0; i < 121; i++) last = (await request(app).get("/api/auth/csrf")).status;
        expect(last).toBe(429);
    });
});
