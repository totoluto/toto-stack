import {afterEach, beforeEach, describe, expect, it} from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import {BackgroundService, BaseRoute, Dependencies} from "toto-stack";
import fakePrisma, {resetFakeDb} from "../fakePrisma";
import {makeServer} from "./support";

type Server = ReturnType<typeof makeServer>;
const servers: Server[] = [];
const track = (server: Server) => {
    servers.push(server);
    return server;
};

function portOf(server: Server): number {
    return (server.httpServer!.address() as net.AddressInfo).port;
}

function service(name: string, log: string[], fail?: "start" | "stop"): BackgroundService {
    return {
        name,
        start() {
            if (fail === "start") throw new Error(`${name} start failed`);
            log.push(`start:${name}`);
        },
        stop() {
            if (fail === "stop") throw new Error(`${name} stop failed`);
            log.push(`stop:${name}`);
        },
    };
}

class HangingRoute extends BaseRoute {
    public static hits = 0;

    constructor(dependencies: Dependencies) {
        super("/hang", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        this.get("/", () => {
            HangingRoute.hits++;
            return new Promise(() => undefined);
        });
    }
}

beforeEach(() => resetFakeDb());
afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map(server => server.stop()));
});

describe("start() failures (M1/M14)", () => {
    it("rejects with the original EADDRINUSE error", async () => {
        const blocker = net.createServer();
        await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
        const port = (blocker.address() as net.AddressInfo).port;

        try {
            const calls: string[] = [];
            const server = track(makeServer({
                http: {port, host: "127.0.0.1"},
                hooks: {onReady: () => void calls.push("ready"), onShutdown: () => void calls.push("shutdown")},
            }));
            const err = await server.start().catch((error: NodeJS.ErrnoException) => error);

            expect(err).toBeInstanceOf(Error);
            expect((err as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
            expect(calls).toEqual([]);
            expect(server.httpServer).toBeUndefined();
            await expect(server.stop()).resolves.toBeUndefined();
        } finally {
            blocker.close();
        }
    });

    it("stops services that already started when a later one fails to start", async () => {
        const log: string[] = [];
        const server = track(makeServer({
            http: {port: 0, host: "127.0.0.1"},
            backgroundServices: () => [service("a", log), service("b", log, "start"), service("c", log)],
        }));

        await expect(server.start()).rejects.toThrow("b start failed");
        expect(log).toEqual(["start:a", "stop:a"]);
    });

    it("does not run onShutdown when onReady failed", async () => {
        const calls: string[] = [];
        const server = track(makeServer({
            http: {port: 0, host: "127.0.0.1"},
            hooks: {
                onReady: () => {
                    throw new Error("ready failed");
                },
                onShutdown: () => void calls.push("shutdown"),
            },
        }));

        await expect(server.start()).rejects.toThrow("ready failed");
        await server.stop();
        expect(calls).toEqual([]);
    });
});

describe("stop() (M14)", () => {
    it("is idempotent and runs onShutdown exactly once after onReady", async () => {
        const calls: string[] = [];
        const server = track(makeServer({
            http: {port: 0, host: "127.0.0.1"},
            hooks: {
                onHttpServerCreated: () => void calls.push("http"),
                onReady: () => void calls.push("ready"),
                onShutdown: () => void calls.push("shutdown"),
            },
        }));

        await server.start();
        const res = await fetch(`http://127.0.0.1:${portOf(server)}/api/status`);
        expect(res.status).toBe(200);

        const first = server.stop();
        const second = server.stop();
        expect(second).toBe(first);
        await first;
        await server.stop();

        expect(calls).toEqual(["http", "ready", "shutdown"]);
        expect(server.httpServer).toBeUndefined();
        await expect(server.start()).rejects.toThrow(/stopped/);
    });

    it("keeps stopping past a throwing service and reports the failure", async () => {
        const log: string[] = [];
        const server = track(makeServer({
            http: {port: 0, host: "127.0.0.1"},
            backgroundServices: () => [service("a", log), service("b", log, "stop"), service("c", log)],
        }));
        await server.start();
        const httpServer = server.httpServer!;

        const err = await server.stop().catch((error: unknown) => error);

        expect(err).toBeInstanceOf(AggregateError);
        expect((err as AggregateError).errors.map(error => (error as Error).message)).toEqual([
            'Background service "b" failed to stop: b stop failed',
        ]);
        expect(log).toEqual(["start:a", "start:b", "start:c", "stop:c", "stop:a"]);
        expect(httpServer.listening).toBe(false);
    });

    it("closes lingering connections after shutdown.timeoutMs", async () => {
        HangingRoute.hits = 0;
        const server = track(makeServer({http: {port: 0, host: "127.0.0.1"}, routes: [HangingRoute], shutdown: {timeoutMs: 200}}));
        await server.start();

        const pending = new Promise<void>(resolve => {
            http.get(`http://127.0.0.1:${portOf(server)}/api/hang`).on("error", () => resolve());
        });
        while (HangingRoute.hits === 0) await new Promise(resolve => setTimeout(resolve, 10));

        const started = Date.now();
        await server.stop();
        expect(Date.now() - started).toBeLessThan(2000);
        await pending;
    });

    it("installs signal handlers only when asked and removes them on stop", async () => {
        const before = process.listenerCount("SIGTERM");

        const plain = track(makeServer({http: {port: 0, host: "127.0.0.1"}}));
        await plain.start();
        expect(process.listenerCount("SIGTERM")).toBe(before);
        await plain.stop();

        const handling = track(makeServer({http: {port: 0, host: "127.0.0.1"}, shutdown: {handleSignals: true}}));
        await handling.start();
        expect(process.listenerCount("SIGTERM")).toBe(before + 1);
        expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
        await handling.stop();
        expect(process.listenerCount("SIGTERM")).toBe(before);
    });

    it("patches console only while running and restores it on stop", async () => {
        const original = console.log;
        const server = track(makeServer({http: {port: 0, host: "127.0.0.1"}, logger: {patchConsole: true}}));

        await server.start();
        expect(console.log).not.toBe(original);
        await server.stop();
        expect(console.log).toBe(original);
    });

    it("does not disconnect the app-owned Prisma client", async () => {
        let disconnected = false;
        const prisma = Object.assign(Object.create(fakePrisma), {$disconnect: async () => void (disconnected = true)});
        const {createServer} = await import("toto-stack");
        const server = track(createServer({prisma, http: {port: 0, host: "127.0.0.1"}, logger: {patchConsole: false}}));

        await server.start();
        await server.stop();
        expect(disconnected).toBe(false);
    });
});

describe("createApp() and per-instance state (H3/L22)", () => {
    it("is idempotent", async () => {
        const server = makeServer();
        const [a, b] = await Promise.all([server.createApp(), server.createApp()]);

        expect(a).toBe(b);
        expect(await server.createApp()).toBe(a);
    });

    it("keeps setup state per server instance", async () => {
        const first = makeServer();
        await first.createApp();
        expect(first.dependencies.state.setupComplete).toBe(false);

        await fakePrisma.user.create({data: {username: "owner", password: "x", apiKey: "k"}});
        const second = makeServer();
        await second.createApp();

        expect(second.dependencies.state.setupComplete).toBe(true);
        expect(first.dependencies.state.setupComplete).toBe(false);
        expect(second.dependencies).not.toBe(first.dependencies);
    });

    it("runs configureApp before body parsing, session and CSRF", async () => {
        const app = await makeServer({
            hooks: {
                configureApp: (expressApp) => {
                    expressApp.post("/api/webhooks/test", express.raw({type: "*/*"}), (req, res) => {
                        res.json({raw: Buffer.isBuffer(req.body), length: (req.body as Buffer).length, session: "session" in req});
                    });
                },
            },
        }).createApp();

        const res = await request(app).post("/api/webhooks/test").set("Content-Type", "application/json").send('{"a":1}');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({raw: true, length: 7, session: false});
    });

    it("types and attaches custom services, rejecting name clashes", async () => {
        const server = makeServer({services: () => ({greeter: {greet: (name: string) => `hi ${name}`}})});
        expect((server.dependencies as unknown as {greeter: {greet(name: string): string}}).greeter.greet("x")).toBe("hi x");

        expect(() => makeServer({services: () => ({prisma: {}})})).toThrow(/conflicts with a built-in dependency/);
    });
});

describe("frontend (M7)", () => {
    const tempDirs: string[] = [];
    const tempDir = (prefix: string) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        tempDirs.push(dir);
        return dir;
    };
    afterEach(() => {
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
    });

    it("serves the SPA from frontend.dir with an index.html fallback", async () => {
        const dir = tempDir("toto-frontend-");
        fs.writeFileSync(path.join(dir, "index.html"), "<h1>app</h1>");
        fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)");

        const app = await makeServer({frontend: {dir}}).createApp();

        expect((await request(app).get("/dashboard")).text).toBe("<h1>app</h1>");
        expect((await request(app).get("/app.js")).text).toBe("console.log(1)");
        expect((await request(app).get("/api/nope")).status).toBe(404);
    });

    it("is API-only by default", async () => {
        const app = await makeServer().createApp();
        const res = await request(app).get("/");

        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toMatch(/json/);
    });

    it("returns 404 (not 500) when the build is missing", async () => {
        const dir = tempDir("toto-empty-");
        const app = await makeServer({frontend: {dir}}).createApp();

        expect((await request(app).get("/dashboard")).status).toBe(404);
    });
});

describe("built-in routes (M10/M11)", () => {
    it("are only the sign-in flow, /api/account and /api/health; everything else is app code", async () => {
        // Without the template's routes (makeServer() adds them).
        const {createServer} = await import("toto-stack");
        const app = await createServer({prisma: fakePrisma, logger: {patchConsole: false}}).createApp();

        for (const path of ["/api/users", "/api/notifications/handlers", "/api/status"]) {
            const res = await request(app).get(path);
            expect(res.status).toBe(404);
            expect(res.body.code).toBe("NOT_FOUND");
        }

        expect((await request(app).get("/api/health")).status).toBe(200);
        expect((await request(app).get("/api/auth/me")).body.data.authState).toBe("setup");
        // Mounted: an invalid API key is a 401, not a 404.
        expect((await request(app).delete("/api/account/api-key").set("Authorization", "Bearer toto_invalid")).status).toBe(401);
    });

    it("mounts app routes after the built-ins (the template's users, notifications and status)", async () => {
        const server = makeServer({notifications: {handlers: {ops: {send: async () => undefined}}}});
        const app = await server.createApp();
        const {userService} = server.dependencies;
        const apiKey = await userService.issueApiKey((await userService.createUser("boss", "a-long-password", ["owner"])).id);
        const asOwner = (path: string) => request(app).get(path).set("Authorization", `Bearer ${apiKey}`);

        expect((await asOwner("/api/users")).body.data.users).toEqual([expect.objectContaining({username: "boss", roles: ["owner"]})]);
        expect((await asOwner("/api/notifications/handlers")).body.data.handlers).toEqual(["ops"]);
        expect((await request(app).get("/api/status")).status).toBe(200);
    });
});
