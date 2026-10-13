import {beforeEach, describe, expect, it} from "vitest";
import {Express} from "express";
import {agentFor, completeSetup, createTestApp, csrf, postJson} from "./helpers";

describe("request security", () => {
    let app: Express;

    // A fresh app and database per test: the brute-force test exhausts rate limits.
    beforeEach(async () => {
        app = await createTestApp();
        const setupAgent = agentFor(app);
        await completeSetup(setupAgent, "owner", "super-secret-password");
    });

    it("rejects API mutations without a CSRF token", async () => {
        const agent = agentFor(app);
        const res = await agent
            .post("/api/auth/login")
            .send({username: "owner", password: "super-secret-password"});

        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/CSRF/i);
    });

    it("rejects requests from a disallowed origin", async () => {
        const agent = agentFor(app);
        const res = await agent
            .get("/api/auth/me")
            .set("Origin", "https://evil.example.com");

        expect(res.status).toBe(403);
    });

    it("returns 401 for protected routes without authentication", async () => {
        const agent = agentFor(app);
        const res = await postJson(agent, "/api/account/password", {currentPassword: "x", newPassword: "new-password-123"});

        expect(res.status).toBe(401);
    });

    it("returns 404 for unknown API endpoints", async () => {
        const res = await agentFor(app).get("/api/does-not-exist");
        expect(res.status).toBe(404);
    });

    it("locks out login brute force and keeps failed attempts counted", async () => {
        const agent = agentFor(app);
        const token = await csrf(agent);

        // Username bucket allows 5 attempts per window - all fail here
        for (let attempt = 1; attempt <= 5; attempt++) {
            const res = await agent
                .post("/api/auth/login")
                .set("X-CSRF-Token", token)
                .send({username: "owner", password: `wrong-${attempt}`});

            expect(res.status).toBe(200);
            expect(res.body.data.user).toBeNull();
        }

        // 6th attempt must be blocked - proving failures never reset the limiter
        const blocked = await agent
            .post("/api/auth/login")
            .set("X-CSRF-Token", token)
            .send({username: "owner", password: "super-secret-password"});

        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("rejects invalid payloads", async () => {
        const agent = agentFor(app);
        const res = await postJson(agent, "/api/auth/login", {username: "owner", password: "pw", extraField: "nope"});

        expect(res.status).toBe(400);
    });
});
