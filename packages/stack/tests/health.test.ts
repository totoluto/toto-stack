import {describe, expect, it} from "vitest";
import {agentFor, createTestApp, createTestContext} from "./helpers";

describe("GET /api/health", () => {
    it("reports ok with db up", async () => {
        const app = await createTestApp();
        const res = await agentFor(app).get("/api/health");

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body.db).toBe("ok");
        expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("returns 503 when the database is down", async () => {
        const {app, prisma} = await createTestContext();
        prisma.$queryRaw = async () => {
            throw new Error("db down");
        };

        const res = await agentFor(app).get("/api/health");
        expect(res.status).toBe(503);
        expect(res.body.db).toBe("down");
    });

    it("sets an X-Request-Id header", async () => {
        const app = await createTestApp();
        const res = await agentFor(app).get("/api/health");

        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });
});
