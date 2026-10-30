import {expect, it} from "vitest";
import type {Express} from "express";
import type {Agent} from "supertest";
import {agentFor, completeSetup, csrf, del, postJson} from "../helpers";
import {createRealServer, describeDb, useDatabase} from "./support";

const OWNER_PASSWORD = "owner-password-123";
const BOB_PASSWORD = "bob-password-1234";

async function login(app: Express, username: string, password: string, userAgent?: string): Promise<Agent> {
    const agent = agentFor(app);
    const token = await csrf(agent);
    const req = agent.post("/api/auth/login").set("X-CSRF-Token", token);
    if (userAgent) req.set("User-Agent", userAgent);
    const res = await req.send({username, password});
    expect(res.body.data?.authState, JSON.stringify(res.body)).toBe("authenticated");
    return agent;
}

describeDb("users on MariaDB", () => {
    const db = useDatabase();

    async function withOwner(config = {}) {
        const {app, server} = await createRealServer(db.prisma(), config);
        const owner = agentFor(app);
        await completeSetup(owner, "owner", OWNER_PASSWORD);
        const createUser = async (username: string, password: string, roles: string[] = [], as: Agent = owner, currentPassword = OWNER_PASSWORD) =>
            postJson(as, "/api/users", {username, password, roles, currentPassword});
        return {app, server, owner, createUser};
    }

    it("an admin can't grant owner or admin (H1)", async () => {
        const {app, createUser} = await withOwner();
        expect((await createUser("admin", "admin-password-1", ["admin"])).status).toBe(201);
        const admin = await login(app, "admin", "admin-password-1");

        for (const roles of [["owner"], ["admin"]]) {
            const res = await createUser(`x-${roles[0]}`, "some-password-123", roles, admin, "admin-password-1");
            expect(res.status).toBe(403);
            expect(res.body.code).toBe("ROLE_NOT_GRANTABLE");
        }
        expect(await db.prisma().user.count()).toBe(2);
    });

    it("logs in with a 400-character User-Agent and stores it (VARCHAR(512), M13)", async () => {
        const {app, createUser} = await withOwner();
        await createUser("bob", BOB_PASSWORD);

        await login(app, "bob", BOB_PASSWORD, "Mozilla/5.0 ".padEnd(400, "x"));
        await login(app, "bob", BOB_PASSWORD, "y".repeat(2000));

        const agents = (await db.prisma().session.findMany({where: {userId: {not: null}}})).map(row => row.userAgent?.length);
        expect(agents).toEqual(expect.arrayContaining([400, 512]));
    });

    it("usernames are unique case-insensitively (utf8mb4_unicode_ci) and P2002 maps to 409 (L3)", async () => {
        const {createUser} = await withOwner();
        expect((await createUser("alice", BOB_PASSWORD)).status).toBe(201);

        const upper = await createUser("ALICE", BOB_PASSWORD);
        expect(upper.status).toBe(409);
        expect(upper.body.code).toBe("USERNAME_TAKEN");

        const raced = await Promise.all([createUser("carol", BOB_PASSWORD), createUser("Carol", BOB_PASSWORD)]);
        expect(raced.map(res => res.status).sort()).toEqual([201, 409]);
        expect(await db.prisma().user.count({where: {username: "CAROL"}})).toBe(1);
    });

    it("deleting a user cascades to their sessions", async () => {
        const {app, owner, createUser} = await withOwner();
        const bobId = (await createUser("bob", BOB_PASSWORD)).body.data.user.id as number;
        const laptop = await login(app, "bob", BOB_PASSWORD);
        await login(app, "bob", BOB_PASSWORD);
        expect(await db.prisma().session.count({where: {userId: bobId}})).toBe(2);

        expect((await del(owner, `/api/users/${bobId}`, {currentPassword: OWNER_PASSWORD})).status).toBe(200);

        expect(await db.prisma().session.count({where: {userId: bobId}})).toBe(0);
        expect((await laptop.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("the user listing returns no secrets", async () => {
        const {app, owner, createUser} = await withOwner();
        await createUser("bob", BOB_PASSWORD);
        const bob = await login(app, "bob", BOB_PASSWORD);
        expect((await postJson(bob, "/api/account/api-key", {password: BOB_PASSWORD})).status).toBe(200);

        // The secrets exist in the database ...
        const stored = await db.prisma().user.findMany();
        expect(stored.every(user => typeof user.password === "string")).toBe(true);
        expect(stored.some(user => typeof user.apiKey === "string")).toBe(true);
        expect(stored.some(user => typeof user.otpSecret === "string")).toBe(true);

        // ... but never leave through the API.
        const res = await owner.get("/api/users");
        expect(res.status).toBe(200);
        expect(res.body.data.users).toHaveLength(2);
        for (const user of res.body.data.users) {
            for (const secret of ["password", "apiKey", "otpSecret", "otpLastUsedStep"]) expect(user).not.toHaveProperty(secret);
        }
        expect(JSON.stringify(res.body)).not.toMatch(/\$argon2id\$|toto_/);
    });
});
