import {beforeEach, describe, expect, it} from "vitest";
import request from "supertest";
import {createServer} from "toto-stack";
import {createFakePrisma} from "../fakePrisma";

const OWNER_PASSWORD = "owner-password-123";

// Deliberately do not load templateRoutes: user management belongs to the package.
describe("built-in user API", () => {
    async function context() {
        const prisma = createFakePrisma();
        const server = createServer({prisma, roles: ["editor"], logger: {patchConsole: false}});
        const app = await server.createApp();
        const {userService} = server.dependencies;
        const owner = await userService.createUser("owner", OWNER_PASSWORD, ["owner"]);
        const key = await userService.issueApiKey(owner.id);
        return {app, prisma, server, key, owner};
    }

    let ctx: Awaited<ReturnType<typeof context>>;
    beforeEach(async () => { ctx = await context(); });

    it("creates, lists and deletes users without any app routes", async () => {
        const {app, key} = ctx;
        const created = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`)
            .send({currentPassword: OWNER_PASSWORD, username: " member ", password: "member-password-123", roles: ["editor", "editor"]});
        expect(created.status).toBe(201);
        expect(created.body.data.user).toEqual({id: expect.any(Number), username: "member", roles: ["editor"]});

        const listed = await request(app).get("/api/users").set("Authorization", `Bearer ${key}`);
        expect(listed.status).toBe(200);
        expect(listed.body.data.users).toEqual(expect.arrayContaining([
            {id: created.body.data.user.id, username: "member", roles: ["editor"], otpEnabled: false, createdAt: expect.any(String)},
        ]));
        const deleted = await request(app).delete(`/api/users/${created.body.data.user.id}`).set("Authorization", `Bearer ${key}`).send({currentPassword: OWNER_PASSWORD});
        expect(deleted.status).toBe(200);
        const missing = await request(app).delete(`/api/users/${created.body.data.user.id}`).set("Authorization", `Bearer ${key}`).send({currentPassword: OWNER_PASSWORD});
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe("USER_NOT_FOUND");
    });

    it("requires authentication for every user management endpoint", async () => {
        const {app} = ctx;
        for (const req of [request(app).get("/api/users"), request(app).post("/api/users").send({username: "member", password: "member-password-123", currentPassword: OWNER_PASSWORD}), request(app).delete("/api/users/2").send({currentPassword: OWNER_PASSWORD})]) {
            const res = await req.set("Authorization", "Bearer invalid");
            expect(res.status).toBe(401);
            expect(res.body.code).toBe("UNAUTHORIZED");
        }
    });

    it("denies all user management endpoints to ordinary users", async () => {
        const {app, server} = ctx;
        const member = await server.dependencies.userService.createUser("member", "member-password-123");
        const key = await server.dependencies.userService.issueApiKey(member.id);
        for (const req of [request(app).get("/api/users"), request(app).post("/api/users").send({username: "other", password: "other-password-123", currentPassword: "member-password-123"}), request(app).delete("/api/users/1").send({currentPassword: "member-password-123"})]) {
            const res = await req.set("Authorization", `Bearer ${key}`);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe("FORBIDDEN");
        }
    });

    it("validates user creation before writing to the database", async () => {
        const {app, prisma, key} = ctx;
        for (const body of [
            {username: "member", password: "short"},
            {username: " ", password: "member-password-123"},
            {username: "member", password: "member-password-123", roles: ["unknown"]},
            {username: "member", password: "member-password-123", apiKey: "injected"},
        ]) {
            const res = await request(app).post("/api/users").set("Authorization", `Bearer ${key}`).send({...body, currentPassword: OWNER_PASSWORD});
            expect(res.status).toBe(400);
            expect(res.body.code).toBe("VALIDATION_FAILED");
        }
        expect(await prisma.user.count()).toBe(1);
    });

    it("loads only identity and roles when checking a deletion target", async () => {
        const {app, prisma, key, server, owner} = ctx;
        const member = await server.dependencies.userService.createUser("member", "member-password-123");
        const start = prisma.$fake.calls.length;
        const res = await request(app).delete(`/api/users/${member.id}`).set("Authorization", `Bearer ${key}`).send({currentPassword: OWNER_PASSWORD});
        expect(res.status).toBe(200);
        const lookups = prisma.$fake.calls.slice(start).filter(call => call.model === "user" && (call.operation === "findFirst" || call.operation === "findUnique"));
        expect(lookups).toEqual([
            expect.objectContaining({operation: "findUnique"}), // Bearer authentication
            expect.objectContaining({operation: "findUnique", args: {
                where: {id: member.id},
                select: {id: true, username: true, roles: {select: {role: {select: {name: true}}}}},
            }}),
            expect.objectContaining({operation: "findFirst", args: {
                where: {id: owner.id},
                include: {roles: {include: {role: true}}},
            }}), // Actor lookup for password verification includes credentials.
        ]);
    });

    it("rejects malformed and out-of-range IDs without looking up a target", async () => {
        const {app, prisma, key} = ctx;
        const start = prisma.$fake.calls.length;
        const ids = ["0", "-1", "1.5", "abc", "1e0", "0x1", "01", "9007199254740992", "2147483648"];
        for (const id of ids) {
            const res = await request(app).delete(`/api/users/${id}`).set("Authorization", `Bearer ${key}`).send({currentPassword: OWNER_PASSWORD});
            expect(res.status, id).toBe(400);
            expect(res.body.code, id).toBe("INVALID_USER_ID");
        }
        const userQueries = prisma.$fake.calls.slice(start).filter(call => call.model === "user");
        // Only the Bearer authentication lookup is allowed for each request.
        expect(userQueries).toHaveLength(ids.length);
        for (const query of userQueries) {
            expect(query).toMatchObject({operation: "findUnique", args: {where: {apiKey: expect.any(String)}}});
        }
    });
});
