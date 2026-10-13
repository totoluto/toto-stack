import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import express from "express";
import request from "supertest";
import {z} from "zod";
import {AppError, BaseRoute, Dependencies} from "toto-stack";
import {RateLimiter} from "@server/libs/security/RateLimiter";
import {resetFakeDb} from "../fakePrisma";
import {makeServer, productionConfig} from "./support";

class FailingRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/fail", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        this.get("/app-error", () => {
            throw new AppError(409, "Already exists.", {code: "CONFLICT", details: {field: "name"}});
        });
        this.get("/app-error-500", () => {
            throw new AppError(503, "Upstream secret detail");
        });
        this.get("/crash", async () => {
            throw new Error("database password is hunter2");
        });
        this.get("/after-headers", (_req, res) => {
            res.status(200).write("partial");
            throw new Error("too late");
        });
        this.post("/echo", z.object({name: z.string().min(2)}).strict(), (_req, res, body) => res.json(body));
        this.put("/echo", z.object({name: z.string()}).strict(), (_req, res, body) => res.json({method: "put", ...body}));
        this.patch("/echo", z.object({name: z.string()}).strict(), (_req, res, body) => res.json({method: "patch", ...body}));
    }
}

const json = (app: express.Express, path: string) => request(app).post(path).set("Content-Type", "application/json");

describe("error responses (M1)", () => {
    beforeEach(() => resetFakeDb());
    afterEach(() => vi.unstubAllEnvs());

    it("maps malformed JSON to 400 with the standard envelope", async () => {
        const app = await makeServer().createApp();
        const res = await json(app, "/api/auth/login").send("{not json");

        expect(res.status).toBe(400);
        expect(res.body).toEqual({status: "error", message: "Malformed JSON request body.", code: "INVALID_JSON"});
    });

    it("maps oversized bodies to 413 and honours http.bodyLimit", async () => {
        const app = await makeServer({http: {bodyLimit: "1kb"}}).createApp();
        const res = await json(app, "/api/auth/login").send(JSON.stringify({username: "a", password: "x".repeat(2048)}));

        expect(res.status).toBe(413);
        expect(res.body).toEqual({status: "error", message: "Request body is too large.", code: "PAYLOAD_TOO_LARGE"});

        const defaultApp = await makeServer().createApp();
        const big = await json(defaultApp, "/api/auth/login").send(JSON.stringify({password: "x".repeat(20_000)}));
        expect(big.status).toBe(413);
    });

    it("sends AppError status, message, code and details", async () => {
        const app = await makeServer({routes: [FailingRoute]}).createApp();
        const res = await request(app).get("/api/fail/app-error");

        expect(res.status).toBe(409);
        expect(res.body).toEqual({status: "error", message: "Already exists.", code: "CONFLICT", details: {field: "name"}});
    });

    it("validates bodies for post/put/patch and reports the issues", async () => {
        const app = await makeServer({routes: [FailingRoute]}).createApp();
        const agent = request.agent(app);
        const token = (await agent.get("/api/auth/csrf")).body.data.token;

        const bad = await agent.post("/api/fail/echo").set("X-CSRF-Token", token).send({name: "x"});
        expect(bad.status).toBe(400);
        expect(bad.body).toMatchObject({status: "error", code: "VALIDATION_FAILED", details: [{path: "name"}]});

        expect((await agent.post("/api/fail/echo").set("X-CSRF-Token", token).send({name: "ok"})).body).toEqual({name: "ok"});
        expect((await agent.put("/api/fail/echo").set("X-CSRF-Token", token).send({name: "a"})).body).toEqual({method: "put", name: "a"});
        expect((await agent.patch("/api/fail/echo").set("X-CSRF-Token", token).send({name: "b"})).body).toEqual({method: "patch", name: "b"});
    });

    it("shows unexpected error messages in development", async () => {
        const app = await makeServer({routes: [FailingRoute]}).createApp();
        const res = await request(app).get("/api/fail/crash");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({status: "error", message: "database password is hunter2", code: "INTERNAL_ERROR"});
    });

    it("hides 5xx messages in production", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const app = await makeServer({...productionConfig, routes: [FailingRoute]}).createApp();

        const crash = await request(app).get("/api/fail/crash");
        expect(crash.status).toBe(500);
        expect(crash.body).toEqual({status: "error", message: "Internal Server Error", code: "INTERNAL_ERROR"});

        const appError = await request(app).get("/api/fail/app-error-500");
        expect(appError.status).toBe(503);
        expect(appError.body).toEqual({status: "error", message: "Service Unavailable", code: "SERVICE_UNAVAILABLE"});

        // 4xx stay informative
        const bad = await json(app, "/api/auth/login").send("{not json");
        expect(bad.status).toBe(400);
    });

    it("does not try to send a body once headers are sent", async () => {
        const app = await makeServer({routes: [FailingRoute]}).createApp();
        const outcome = await request(app).get("/api/fail/after-headers").then(res => res.text, (err: Error) => err.message);

        expect(outcome).not.toContain('"status":"error"');
    });

    it("uses the envelope for API and non-API 404s", async () => {
        const app = await makeServer().createApp();

        const api = await request(app).get("/api/nope");
        expect(api.status).toBe(404);
        expect(api.body).toEqual({status: "error", message: "API endpoint does not exist", code: "NOT_FOUND"});

        const page = await request(app).get("/some/page");
        expect(page.status).toBe(404);
        expect(page.body).toEqual({status: "error", message: "Not Found", code: "NOT_FOUND"});
    });

    it("uses the envelope for the global rate limiter's 429", async () => {
        const limiter = new RateLimiter(60_000, 1);
        const app = express().use(limiter.middleware()).get("/", (_req, res) => res.json({ok: true}));

        expect((await request(app).get("/")).status).toBe(200);
        const limited = await request(app).get("/");
        expect(limited.status).toBe(429);
        expect(limited.body).toEqual({status: "error", message: "Too many requests, please try again later", code: "RATE_LIMITED"});
        expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    });
});
