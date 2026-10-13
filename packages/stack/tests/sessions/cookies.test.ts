import {afterEach, describe, expect, it, vi} from "vitest";
import request from "supertest";
import {Logger} from "@server/libs/Logger";
import {productionConfig} from "../core/support";
import {agentFor, postJson} from "../helpers";
import {countedServer, DAY, setCookies, withLoggedInUser} from "./support";

// L34: one source for the session cookie name and attributes.

afterEach(() => {
    vi.unstubAllEnvs();
});

function attributes(cookie: string): string[] {
    return cookie.split(";").slice(1).map(part => part.trim().replace(/^Expires=.*/, "Expires"));
}

/** A minimal cookie jar for HTTPS-only cookies (supertest's jar never sends Secure cookies over http). */
class Jar {
    private readonly cookies = new Map<string, string>();

    store(res: {headers: Record<string, unknown>}): void {
        for (const header of setCookies(res)) {
            const [pair] = header.split(";");
            const name = pair.slice(0, pair.indexOf("="));
            const value = pair.slice(pair.indexOf("=") + 1);
            if (!value || header.includes("Expires=Thu, 01 Jan 1970")) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
    }

    names(): string[] {
        return [...this.cookies.keys()];
    }

    header(): string {
        return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
}

describe("session cookie (L34)", () => {
    it("development: the configured name without prefix; logout clears the same cookie", async () => {
        const {app, server} = await countedServer({session: {cookieName: "app.sid"}});
        expect(server.dependencies.sessionService.cookieName).toBe("app.sid");
        const {user} = await withLoggedInUser(app);

        const login = await postJson(agentFor(app), "/api/auth/login", {username: "user", password: "user-password-123"});
        const cookie = setCookies(login).find(header => header.startsWith("app.sid="))!;
        expect(attributes(cookie)).toEqual(["Path=/", "Expires", "HttpOnly", "SameSite=Lax"]);
        const expires = Date.parse(/Expires=([^;]+)/.exec(cookie)![1]);
        expect(Math.abs(expires - (Date.now() + 7 * DAY))).toBeLessThan(2000);

        const logout = await postJson(user, "/api/auth/logout");
        const cleared = setCookies(logout).find(header => header.startsWith("app.sid="))!;
        expect(cleared).toMatch(/^app\.sid=;/);
        expect(cleared).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(attributes(cleared)).toEqual(["Path=/", "Expires", "HttpOnly", "SameSite=Lax"]);
        expect((await user.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("production: __Host- prefixed, Secure; logout clears the same cookie", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const {app, server} = await countedServer({...productionConfig, http: {trustProxy: 1}});
        const {sessionService, userService} = server.dependencies;
        expect(sessionService.cookieName).toBe("__Host-connect.sid");
        expect(sessionService.cookieOptions).toEqual({httpOnly: true, sameSite: "lax", secure: true, path: "/"});
        await userService.createUser("prod", "prod-password-123");

        const jar = new Jar();
        const https = (req: request.Test) => req.set("X-Forwarded-Proto", "https").set("Cookie", jar.header());

        const anon = await https(request(app).get("/api/auth/csrf"));
        jar.store(anon);
        const login = await https(request(app).post("/api/auth/login")).set("X-CSRF-Token", anon.body.data.token).send({username: "prod", password: "prod-password-123"});
        expect(login.body.data.authState).toBe("authenticated");
        const cookie = setCookies(login).find(header => header.startsWith("__Host-connect.sid="))!;
        expect(attributes(cookie)).toEqual(["Path=/", "Expires", "HttpOnly", "Secure", "SameSite=Lax"]);
        expect(cookie).not.toMatch(/Domain=/i);
        jar.store(login);

        expect((await https(request(app).get("/api/auth/me"))).body.data.authState).toBe("authenticated");

        const token = await https(request(app).get("/api/auth/csrf"));
        jar.store(token);
        const logout = await https(request(app).post("/api/auth/logout")).set("X-CSRF-Token", token.body.data.token).send({});
        expect(logout.status).toBe(200);
        const cleared = setCookies(logout).find(header => header.startsWith("__Host-connect.sid="))!;
        expect(cleared).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(attributes(cleared)).toEqual(["Path=/", "Expires", "HttpOnly", "Secure", "SameSite=Lax"]);
        jar.store(logout);
        expect(jar.names()).not.toContain("__Host-connect.sid");
    });
});

describe("untrusted TLS proxy (F6)", () => {
    const proxyWarnings = (spy: {mock: {calls: unknown[][]}}) => spy.mock.calls.filter(([message]) => String(message).includes("TRUST_PROXY=1"));

    it("production: warns once when an HTTPS proxy is not trusted (the Secure cookie would be dropped)", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const warn = vi.spyOn(Logger.prototype, "warn");
        try {
            const {app, server} = await countedServer(productionConfig);
            await server.dependencies.userService.createUser("prod", "prod-password-123");

            const anon = await request(app).get("/api/auth/csrf").set("X-Forwarded-Proto", "https");
            const nonce = setCookies(anon).map(cookie => cookie.split(";")[0]).join("; ");
            const login = await request(app).post("/api/auth/login").set("X-Forwarded-Proto", "https").set("Cookie", nonce)
                .set("X-CSRF-Token", anon.body.data.token).send({username: "prod", password: "prod-password-123"});

            // The footgun: "authenticated", but no session cookie
            expect(login.body.data.authState).toBe("authenticated");
            expect(setCookies(login).some(cookie => cookie.startsWith("__Host-connect.sid="))).toBe(false);

            await request(app).get("/api/auth/me").set("X-Forwarded-Proto", "https");
            expect(proxyWarnings(warn)).toHaveLength(1);
        } finally {
            warn.mockRestore();
        }
    });

    it("stays quiet when the proxy is trusted, without the header, and in development", async () => {
        const warn = vi.spyOn(Logger.prototype, "warn");
        try {
            const dev = await countedServer();
            await request(dev.app).get("/api/auth/me").set("X-Forwarded-Proto", "https");

            vi.stubEnv("NODE_ENV", "production");
            const trusted = await countedServer({...productionConfig, http: {trustProxy: 1}});
            await request(trusted.app).get("/api/auth/me").set("X-Forwarded-Proto", "https");
            const direct = await countedServer(productionConfig);
            await request(direct.app).get("/api/auth/me");

            expect(proxyWarnings(warn)).toEqual([]);
        } finally {
            warn.mockRestore();
        }
    });
});
