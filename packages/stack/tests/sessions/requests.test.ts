import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import request from "supertest";
import {advanceClock, agentFor, csrf, postJson} from "../helpers";
import {countedServer, fakePrisma, MINUTE, sessionRows, withLoggedInUser} from "./support";

// H8: per-request database cost.

let frontendDir: string;

beforeAll(() => {
    frontendDir = fs.mkdtempSync(path.join(os.tmpdir(), "toto-sessions-spa-"));
    fs.mkdirSync(path.join(frontendDir, "assets"));
    fs.writeFileSync(path.join(frontendDir, "index.html"), "<!doctype html><title>app</title>");
    fs.writeFileSync(path.join(frontendDir, "assets", "index-B1x2y3z4.js"), "console.log('app');");
    fs.writeFileSync(path.join(frontendDir, "favicon.ico"), "icon");
});

afterAll(() => {
    fs.rmSync(frontendDir, {recursive: true, force: true});
});

describe("database calls per request (H8)", () => {
    it("anonymous API requests cost no queries", async () => {
        const {app, counter} = await countedServer();
        await withLoggedInUser(app);
        counter.reset();

        expect((await request(app).get("/api/auth/me")).body.data.authState).toBe("login");
        expect((await request(app).get("/api/auth/csrf")).status).toBe(200);
        expect((await request(app).get("/api/status")).status).toBe(200);

        expect(counter.calls).toEqual([]);
    });

    it("a logged-in API request does 1 read (session + user in one query) and no write within the touch interval", async () => {
        const {app, counter} = await countedServer();
        const {user} = await withLoggedInUser(app);
        await user.get("/api/auth/me");
        counter.reset();

        for (let i = 0; i < 5; i++) {
            advanceClock(30_000);
            const res = await user.get("/api/auth/me");
            expect(res.body.data.user.username).toBe("user");
        }

        expect(counter.calls).toEqual(Array(5).fill("session.findUnique"));
        expect(counter.writes()).toEqual([]);
    });

    it("records activity with one write per touch interval", async () => {
        const {app, counter} = await countedServer({session: {touchInterval: 5 * MINUTE}});
        const {user} = await withLoggedInUser(app);
        counter.reset();

        advanceClock(5 * MINUTE + 1);
        await user.get("/api/auth/me");
        expect(counter.calls).toEqual(["session.findUnique", "session.updateMany"]);

        counter.reset();
        advanceClock(MINUTE);
        await user.get("/api/auth/me");
        expect(counter.calls).toEqual(["session.findUnique"]);
    });

    it("loads no credential columns to authenticate (session join and Bearer lookup)", async () => {
        const {app, counter} = await countedServer();
        const {user} = await withLoggedInUser(app);

        const selects: unknown[] = [];
        const sessionFind = fakePrisma.session.findUnique;
        const userFind = fakePrisma.user.findUnique;
        fakePrisma.session.findUnique = async args => {
            selects.push(args.select);
            return sessionFind(args);
        };
        fakePrisma.user.findUnique = async args => {
            selects.push(args.select);
            return userFind(args);
        };

        try {
            const issued = await postJson(user, "/api/account/api-key", {password: "user-password-123"});
            const apiKey: string = issued.body.data.apiKey;
            counter.reset();
            selects.length = 0;

            const viaKey = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${apiKey}`);
            expect(viaKey.body.data.user.username).toBe("user");
            expect(counter.calls).toEqual(["user.findUnique"]);

            await user.get("/api/auth/me");
        } finally {
            fakePrisma.session.findUnique = sessionFind;
            fakePrisma.user.findUnique = userFind;
        }

        const userSelect = {id: true, username: true, roles: {select: {role: {select: {name: true}}}}};
        expect(selects).toEqual([
            userSelect,
            {data: true, createdAt: true, lastSeenAt: true, expiresAt: true, user: {select: userSelect}},
        ]);
    });

    it("falls back to a narrow user query when the session was not loaded in this request", async () => {
        const {server} = await countedServer();
        const store = server.dependencies.sessionStore;
        // A session object the store didn't load: no joined user
        expect(store.loadedUser({cookie: {originalMaxAge: null}} as never)).toBeUndefined();
    });
});

describe("static files and health checks bypass the session store (H8)", () => {
    it("serves assets, index.html, the SPA fallback and /api/health without touching the session", async () => {
        const {app, counter} = await countedServer({frontend: {dir: frontendDir}});
        const {user} = await withLoggedInUser(app);
        counter.reset();

        expect((await user.get("/assets/index-B1x2y3z4.js")).status).toBe(200);
        expect((await user.get("/")).status).toBe(200);
        expect((await user.get("/index.html")).status).toBe(200);
        expect((await user.get("/some/client/route")).text).toContain("<title>app</title>");
        expect((await user.get("/favicon.ico")).status).toBe(200);
        expect((await user.get("/assets/missing-00000000.js")).status).toBe(404);
        expect(counter.calls).toEqual([]);

        const health = await user.get("/api/health");
        expect(health.status).toBe(200);
        expect(counter.calls).toEqual(["$queryRaw"]);
        expect(counter.sessionCalls()).toEqual([]);
    });

    it("keeps unknown API paths on the API (JSON 404, not index.html)", async () => {
        const {app} = await countedServer({frontend: {dir: frontendDir}});
        const res = await request(app).get("/api/does-not-exist");
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({status: "error"});
    });

    it("sets cache headers: immutable hashed assets, no-cache index.html (M19)", async () => {
        const {app} = await countedServer({frontend: {dir: frontendDir}});

        const asset = await request(app).get("/assets/index-B1x2y3z4.js");
        expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

        for (const url of ["/", "/index.html", "/deep/link"]) {
            const page = await request(app).get(url);
            expect(page.status).toBe(200);
            expect(page.headers["content-type"]).toMatch(/^text\/html/);
            expect(page.headers["cache-control"]).toBe("no-cache");
        }

        expect((await request(app).get("/favicon.ico")).headers["cache-control"]).toBe("public, max-age=0");

        const missing = await request(app).get("/assets/old-chunk-12345678.js");
        expect(missing.status).toBe(404);
        expect(missing.headers["content-type"]).toMatch(/json/);
    });

    it("anonymous visitors create no session rows (still)", async () => {
        const {app} = await countedServer({frontend: {dir: frontendDir}});
        const visitor = agentFor(app);
        await visitor.get("/");
        await csrf(visitor);
        await visitor.get("/api/auth/me");
        expect(await sessionRows()).toEqual([]);
    });
});
