import {afterEach, describe, expect, it, vi} from "vitest";
import request from "supertest";
import * as server from "toto-stack";
import * as client from "toto-stack/client";
import * as shared from "toto-stack/shared";
import {AppError, BaseRoute, type Dependencies, ErrorCode} from "toto-stack";
import {errorCodeForStatus} from "@server/libs/ErrorHandler";
import {makeServer, productionConfig} from "../core/support";
import {captureLogs} from "./support";

class FailingRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/fail", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        this.get("/coded-503", () => {
            throw new AppError(503, "Upstream secret detail", {code: "UPSTREAM_DOWN"});
        });
        this.get("/exposed-503", () => {
            throw new AppError(503, "Try again shortly.", {code: "UPSTREAM_DOWN", expose: true, headers: {"Retry-After": "2"}});
        });
        this.get("/plain-409", () => {
            throw new AppError(409, "Taken.");
        });
    }
}

describe("ErrorCode", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("is one object exported from every entry point; AuthErrorCode is gone", () => {
        expect(client.ErrorCode).toBe(server.ErrorCode);
        expect(shared.ErrorCode).toBe(server.ErrorCode);
        expect("AuthErrorCode" in server || "AuthErrorCode" in client || "AuthErrorCode" in shared).toBe(false);
        for (const [key, value] of Object.entries(ErrorCode)) expect(value).toBe(key);
    });

    it("maps statuses to generic codes", () => {
        expect([400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503].map(errorCodeForStatus)).toEqual([
            "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "PAYLOAD_TOO_LARGE",
            "UNSUPPORTED_MEDIA_TYPE", "BAD_REQUEST", "RATE_LIMITED", "INTERNAL_ERROR", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE",
        ]);
    });

    it("sends a code on every error response, including body-parser failures", async () => {
        const app = await makeServer({routes: [FailingRoute]}).createApp();
        const post = (body: string, type = "application/json") => request(app).post("/api/auth/login").set("Content-Type", type).send(body);

        expect((await post("{oops")).body.code).toBe(ErrorCode.INVALID_JSON);
        expect((await post("{}", "application/json; charset=klingon")).body.code).toBe(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
        expect((await request(app).get("/api/nope")).body.code).toBe(ErrorCode.NOT_FOUND);
        expect((await request(app).get("/api/users")).body.code).toBe(ErrorCode.UNAUTHORIZED);
        expect((await request(app).get("/api/fail/plain-409")).body).toEqual({status: "error", message: "Taken.", code: ErrorCode.CONFLICT});
    });

    it.each(["development", "production"])("never echoes body-parser internals to the client (%s)", async mode => {
        vi.stubEnv("NODE_ENV", mode);
        const app = await makeServer({...productionConfig, http: {bodyLimit: "1kb"}}).createApp();
        const post = (body: string, type = "application/json") => request(app).post("/api/auth/login").set("Content-Type", type).send(body);

        // Captured after createServer(), which sets the format for the mode; capture pins pretty/debug.
        const capture = captureLogs("debug");
        let malformed, tooLarge, charset;
        try {
            malformed = await post('{"username": "a",}');
            tooLarge = await post(JSON.stringify({password: "x".repeat(4096)}));
            charset = await post("{}", "application/json; charset=klingon");
        } finally {
            capture.restore();
        }

        expect(malformed.status).toBe(400);
        expect(malformed.body).toEqual({status: "error", message: "Malformed JSON request body.", code: ErrorCode.INVALID_JSON});
        expect(tooLarge.status).toBe(413);
        expect(tooLarge.body).toEqual({status: "error", message: "Request body is too large.", code: ErrorCode.PAYLOAD_TOO_LARGE});
        expect(charset.status).toBe(415);
        expect(charset.body).toEqual({status: "error", message: "Unsupported request body charset.", code: ErrorCode.UNSUPPORTED_MEDIA_TYPE});
        for (const res of [malformed, tooLarge, charset]) expect(JSON.stringify(res.body)).not.toMatch(/position|JSON at|entity|klingon/i);

        // The parser's detail stays in the server log, at debug level.
        expect(capture.stdout.join("")).toMatch(/\[DEBUG\]\[ErrorHandler\].*POST \/api\/auth\/login -> 400: .*JSON/);
    });

    it("hides an unexposed 5xx's own code in production (generic code only), keeps exposed ones with headers", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const app = await makeServer({...productionConfig, routes: [FailingRoute]}).createApp();

        const hidden = await request(app).get("/api/fail/coded-503");
        expect(hidden.status).toBe(503);
        expect(hidden.body).toEqual({status: "error", message: "Service Unavailable", code: ErrorCode.SERVICE_UNAVAILABLE});

        const exposed = await request(app).get("/api/fail/exposed-503");
        expect(exposed.status).toBe(503);
        expect(exposed.headers["retry-after"]).toBe("2");
        expect(exposed.body).toEqual({status: "error", message: "Try again shortly.", code: "UPSTREAM_DOWN"});
    });

    it("includes OVERLOADED", () => {
        expect(ErrorCode.OVERLOADED).toBe("OVERLOADED");
    });
});
