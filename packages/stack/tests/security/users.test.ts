import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import request from "supertest";
import {createServer, type Server} from "toto-stack";
import {createFakePrisma} from "../fakePrisma";
import {advanceClock, agentFor, postJson} from "../helpers";

const ACTOR_PASSWORD = "owner-password-123";
const NEW_PASSWORD = "member-password-123";

describe("user management password confirmation", () => {
    let server: Server;
    let prisma: ReturnType<typeof createFakePrisma>;
    let app: Awaited<ReturnType<Server["createApp"]>>;
    let key: string;

    beforeEach(async () => {
        prisma = createFakePrisma();
        server = createServer({prisma, roles: ["editor"], http: {trustProxy: 1}, logger: {patchConsole: false}, security: {setupToken: "test-setup-token-0123456789"}});
        app = await server.createApp();
        const owner = await server.dependencies.userService.createUser("owner", ACTOR_PASSWORD, ["owner"]);
        key = await server.dependencies.userService.issueApiKey(owner.id);
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await server.stop();
    });

    it("rejects creation without the actor's password even with a valid owner key", async () => {
        const response = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "member", password: NEW_PASSWORD});
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("VALIDATION_FAILED");
        expect(await prisma.user.count()).toBe(1);
    });

    it.each([
        {body: {}, status: 400, code: "VALIDATION_FAILED"},
        {body: {currentPassword: ""}, status: 400, code: "VALIDATION_FAILED"},
        {body: {currentPassword: NEW_PASSWORD}, status: 403, code: "PASSWORD_CONFIRMATION_FAILED"},
    ])("rejects deletion with invalid actor confirmation ($code)", async ({body, status, code}) => {
        const member = await server.dependencies.userService.createUser("member", NEW_PASSWORD);
        const rejected = await request(app).delete(`/api/users/${member.id}`).set("Authorization", `Bearer ${key}`).send(body);
        expect(rejected.status).toBe(status);
        expect(rejected.body.code).toBe(code);
        expect(await server.dependencies.userService.getSessionUser(member.id)).not.toBeNull();

        const accepted = await request(app).delete(`/api/users/${member.id}`).set("Authorization", `Bearer ${key}`)
            .send({currentPassword: ACTOR_PASSWORD});
        expect(accepted.status).toBe(200);
        expect(await server.dependencies.userService.getSessionUser(member.id)).toBeNull();
    });

    it("throttles duplicate creation before either password hash", async () => {
        const create = () => request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "owner", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
        for (let i = 0; i < 5; i++) expect((await create()).status).toBe(409);

        const verify = vi.spyOn(server.dependencies.userService, "verifyPassword");
        const write = vi.spyOn(server.dependencies.userService, "createUser");
        const blocked = await create();
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe("RATE_LIMITED");
        expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
        expect(verify).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(await prisma.user.count()).toBe(1);
    });

    it("checks the actor's password, not the password chosen for the new user", async () => {
        const rejected = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "member", password: NEW_PASSWORD, currentPassword: NEW_PASSWORD});
        expect(rejected.status).toBe(403);
        expect(rejected.body.code).toBe("PASSWORD_CONFIRMATION_FAILED");
        expect(await prisma.user.count()).toBe(1);

        const accepted = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "member", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD, roles: ["editor"]});
        expect(accepted.status).toBe(201);
        const member = await server.dependencies.userService.getByUsername("member");
        expect(await server.dependencies.userService.verifyPassword(member!, NEW_PASSWORD)).toBe(true);
    });

    it("requires actor confirmation for cookie-authenticated mutations too", async () => {
        const actor = agentFor(app);
        expect((await postJson(actor, "/api/auth/login", {username: "owner", password: ACTOR_PASSWORD})).body.data.authState).toBe("authenticated");
        const missing = await postJson(actor, "/api/users", {username: "member", password: NEW_PASSWORD});
        expect(missing.status).toBe(400);
        const wrong = await postJson(actor, "/api/users", {username: "member", password: NEW_PASSWORD, currentPassword: NEW_PASSWORD});
        expect(wrong.status).toBe(403);
        expect(wrong.body.code).toBe("PASSWORD_CONFIRMATION_FAILED");
        const created = await postJson(actor, "/api/users", {username: "member", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
        expect(created.status).toBe(201);
        const id = created.body.data.user.id;

        const csrf = (await actor.get("/api/auth/csrf")).body.data.token;
        const denied = await actor.delete(`/api/users/${id}`).set("X-CSRF-Token", csrf).send({currentPassword: NEW_PASSWORD});
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe("PASSWORD_CONFIRMATION_FAILED");
        const deleted = await actor.delete(`/api/users/${id}`).set("X-CSRF-Token", csrf).send({currentPassword: ACTOR_PASSWORD});
        expect(deleted.status).toBe(200);
    });

    it("shares the password confirmation budget with account operations", async () => {
        for (let i = 0; i < 10; i++) {
            const failed = await request(app).post("/api/account/api-key").set("Authorization", `Bearer ${key}`).send({password: NEW_PASSWORD});
            expect(failed.status).toBe(403);
        }
        const member = await server.dependencies.userService.createUser("member", NEW_PASSWORD);
        const verify = vi.spyOn(server.dependencies.userService, "verifyPassword");
        const create = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "new-member", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
        expect(create.status).toBe(429);
        const deleted = await request(app).delete(`/api/users/${member.id}`).set("Authorization", `Bearer ${key}`).send({currentPassword: ACTOR_PASSWORD});
        expect(deleted.status).toBe(429);
        expect(deleted.body.code).toBe("RATE_LIMITED");
        expect(Number(deleted.headers["retry-after"])).toBeGreaterThan(0);
        expect(verify).not.toHaveBeenCalled();
        expect(await prisma.user.count()).toBe(2);
    });

    it("rate-limits repeated deletion confirmations and cannot evade the budget through account endpoints", async () => {
        const member = await server.dependencies.userService.createUser("member", NEW_PASSWORD);
        for (let i = 0; i < 10; i++) {
            const failed = await request(app).delete(`/api/users/${member.id}`).set("Authorization", `Bearer ${key}`).send({currentPassword: NEW_PASSWORD});
            expect(failed.status).toBe(403);
        }
        const deleted = await request(app).delete(`/api/users/${member.id}`).set("Authorization", `Bearer ${key}`).send({currentPassword: ACTOR_PASSWORD});
        expect(deleted.status).toBe(429);
        const account = await request(app).post("/api/account/api-key").set("Authorization", `Bearer ${key}`).send({password: ACTOR_PASSWORD});
        expect(account.status).toBe(429);
        expect(await server.dependencies.userService.getSessionUser(member.id)).not.toBeNull();
    });

    it("counts failed confirmations against the creation limit across IPs and key rotations", async () => {
        for (let i = 0; i < 5; i++) {
            const failed = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`).set("X-Forwarded-For", `192.0.2.${i + 1}`)
                .send({username: `member-${i}`, password: NEW_PASSWORD, currentPassword: NEW_PASSWORD});
            expect(failed.status).toBe(403);
        }
        const owner = await server.dependencies.userService.getByUsername("owner");
        key = await server.dependencies.userService.issueApiKey(owner!.id);
        const blocked = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`).set("X-Forwarded-For", "192.0.2.99")
            .send({username: "member", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
        expect(blocked.status).toBe(429);
        expect(await prisma.user.count()).toBe(1);

        advanceClock(15 * 60 * 1000 + 1000);
        const accepted = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "member", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
        expect(accepted.status).toBe(201);
    });

    it("limits creation by IP even when different actors stay within their individual budgets", async () => {
        for (let actor = 0; actor < 4; actor++) {
            const owner = await server.dependencies.userService.createUser(`owner-${actor}`, ACTOR_PASSWORD, ["owner"]);
            const actorKey = await server.dependencies.userService.issueApiKey(owner.id);
            for (let attempt = 0; attempt < 5; attempt++) {
                const duplicate = await request(app).post("/api/users").set("Authorization", `Bearer ${actorKey}`)
                    .send({username: "owner", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
                expect(duplicate.status).toBe(409);
            }
        }
        const verify = vi.spyOn(server.dependencies.userService, "verifyPassword");
        const blocked = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "member", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe("RATE_LIMITED");
        expect(verify).not.toHaveBeenCalled();
    });

    it("counts successful creations without blocking listing or permitted deletion", async () => {
        let memberId: number | undefined;
        for (let i = 0; i < 5; i++) {
            const created = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
                .send({username: `member-${i}`, password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
            expect(created.status).toBe(201);
            memberId = created.body.data.user.id;
        }
        const blocked = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({username: "member-extra", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
        expect(blocked.status).toBe(429);
        expect((await request(app).get("/api/users").set("Authorization", `Bearer ${key}`)).status).toBe(200);
        const deleted = await request(app).delete(`/api/users/${memberId}`).set("Authorization", `Bearer ${key}`).send({currentPassword: ACTOR_PASSWORD});
        expect(deleted.status).toBe(200);
    });

    it("reserves the creation budget before concurrent requests start hashing", async () => {
        const create = vi.spyOn(server.dependencies.userService, "createUser");
        const statuses = await Promise.all(Array.from({length: 6}, async () => {
            const response = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
                .send({username: "owner", password: NEW_PASSWORD, currentPassword: ACTOR_PASSWORD});
            return response.status;
        }));
        expect(statuses.sort()).toEqual([409, 409, 409, 409, 409, 429]);
        expect(create).toHaveBeenCalledTimes(5);
    });
});
