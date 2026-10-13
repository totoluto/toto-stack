import {beforeEach, describe, expect, it} from "vitest";
import {Express} from "express";
import {Agent} from "supertest";
import {UserAuthState} from "@shared/types/user";
import {advanceClock, agentFor, createOwnerContext, del, postJson, totp} from "./helpers";
import type {FakePrisma} from "./fakePrisma";

const ADMIN_PASSWORD = "admin-secret-password";
const MEMBER_PASSWORD = "member-secret-pass";

// Each test starts from a fresh database with only the owner.
describe("user management", () => {
    let app: Express;
    let prisma: FakePrisma;
    let owner: Agent;

    beforeEach(async () => {
        ({app, prisma, owner} = await createOwnerContext({}, "owner", "owner-secret-password"));
    });

    async function createUser(username: string, password: string, roles: string[] = []): Promise<number> {
        const res = await postJson(owner, "/api/users", {username, password, roles});
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.user.id;
    }

    async function login(username: string, password: string): Promise<Agent> {
        const agent = agentFor(app);
        const res = await postJson(agent, "/api/auth/login", {username, password});
        expect(res.body.data.authState).toBe(UserAuthState.AUTHENTICATED);
        return agent;
    }

    async function issueKey(agent: Agent, password: string): Promise<string> {
        const res = await postJson(agent, "/api/account/api-key", {password});
        expect(res.status).toBe(200);
        return res.body.data.apiKey;
    }

    it("lets an owner create users without handing out API keys", async () => {
        const res = await postJson(owner, "/api/users", {username: "admin", password: ADMIN_PASSWORD, roles: ["admin"]});

        expect(res.status).toBe(201);
        expect(res.body.data.user.roles).toContain("admin");
        expect(res.body.data.apiKey).toBeUndefined();

        // Users issue their own key
        const key = await issueKey(await login("admin", ADMIN_PASSWORD), ADMIN_PASSWORD);
        expect(key).toMatch(/^toto_/);

        const memberRes = await postJson(owner, "/api/users", {username: "member", password: MEMBER_PASSWORD, roles: []});
        expect(memberRes.status).toBe(201);
    });

    it("rejects duplicate usernames", async () => {
        await createUser("admin", ADMIN_PASSWORD, ["admin"]);
        const res = await postJson(owner, "/api/users", {username: "admin", password: "another-password", roles: []});

        expect(res.status).toBe(409);
    });

    it("treats usernames that differ only in case as duplicates (utf8mb4_unicode_ci)", async () => {
        await createUser("alice", MEMBER_PASSWORD);
        const res = await postJson(owner, "/api/users", {username: "ALICE", password: "another-password", roles: []});

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("USERNAME_TAKEN");
    });

    it("lists users without exposing secrets", async () => {
        await createUser("admin", ADMIN_PASSWORD, ["admin"]);
        await createUser("member", MEMBER_PASSWORD);
        // Give the admin a key and the owner has a TOTP secret, so every secret column is set
        await issueKey(await login("admin", ADMIN_PASSWORD), ADMIN_PASSWORD);

        const res = await owner.get("/api/users");

        expect(res.status).toBe(200);
        const usernames = res.body.data.users.map((user: {username: string}) => user.username);
        expect(usernames).toEqual(expect.arrayContaining(["owner", "admin", "member"]));
        for (const user of res.body.data.users) {
            expect(user.password).toBeUndefined();
            expect(user.apiKey).toBeUndefined();
            expect(user.otpSecret).toBeUndefined();
            expect(user.otpLastUsedStep).toBeUndefined();
        }
        // The query itself selects no secret columns
        const listing = prisma.$fake.calls.filter(call => call.model === "user" && call.operation === "findMany").at(-1);
        expect(Object.keys((listing?.args as {select: object}).select).sort()).toEqual(["createdAt", "id", "otpEnabled", "roles", "username"]);
    });

    it("denies user management to non-admin users", async () => {
        await createUser("member", MEMBER_PASSWORD);
        const member = await login("member", MEMBER_PASSWORD);

        const res = await member.get("/api/users");
        expect(res.status).toBe(403);
    });

    it("authenticates API clients via hashed Bearer keys", async () => {
        await createUser("admin", ADMIN_PASSWORD, ["admin"]);
        const key = await issueKey(await login("admin", ADMIN_PASSWORD), ADMIN_PASSWORD);

        const ok = await agentFor(app).get("/api/users").set("Authorization", `Bearer ${key}`);
        expect(ok.status).toBe(200);

        const bad = await agentFor(app).get("/api/users").set("Authorization", "Bearer not-a-real-key");
        expect(bad.status).toBe(401);
    });

    it("rotates the API key and invalidates the old one", async () => {
        await createUser("admin", ADMIN_PASSWORD, ["admin"]);
        const admin = await login("admin", ADMIN_PASSWORD);
        const oldKey = await issueKey(admin, ADMIN_PASSWORD);

        const denied = await postJson(admin, "/api/account/api-key", {password: "wrong-password"});
        expect(denied.status).toBe(403);

        const newKey = await issueKey(admin, ADMIN_PASSWORD);

        const viaOld = await agentFor(app).get("/api/users").set("Authorization", `Bearer ${oldKey}`);
        expect(viaOld.status).toBe(401);

        const viaNew = await agentFor(app).get("/api/users").set("Authorization", `Bearer ${newKey}`);
        expect(viaNew.status).toBe(200);
    });

    it("changes the password with confirmation and invalidates the old one", async () => {
        await createUser("member", MEMBER_PASSWORD);
        const member = await login("member", MEMBER_PASSWORD);

        const denied = await postJson(member, "/api/account/password", {currentPassword: "wrong-password", newPassword: "brand-new-password"});
        expect(denied.status).toBe(403);

        const ok = await postJson(member, "/api/account/password", {currentPassword: MEMBER_PASSWORD, newPassword: "brand-new-password"});
        expect(ok.status).toBe(200);

        const freshAgent = agentFor(app);
        const failed = await postJson(freshAgent, "/api/auth/login", {username: "member", password: MEMBER_PASSWORD});
        expect(failed.body.data.user).toBeNull();

        const success = await postJson(freshAgent, "/api/auth/login", {username: "member", password: "brand-new-password"});
        expect(success.body.data.authState).toBe(UserAuthState.AUTHENTICATED);
    });

    it("enrolls and disables MFA with password + token confirmation", async () => {
        await createUser("admin", ADMIN_PASSWORD, ["admin"]);
        const admin = await login("admin", ADMIN_PASSWORD);

        const start = await postJson(admin, "/api/account/mfa/start", {password: ADMIN_PASSWORD});
        expect(start.status).toBe(200);
        const secret = start.body.data.key;

        const verify = await postJson(admin, "/api/account/mfa/verify", {token: totp(secret)});
        expect(verify.status).toBe(200);

        const again = await postJson(admin, "/api/account/mfa/start", {password: ADMIN_PASSWORD});
        expect(again.status).toBe(409);

        // Move to the next TOTP step so the disable token isn't a replay
        advanceClock(31_000);

        const disable = await postJson(admin, "/api/account/mfa/disable", {password: ADMIN_PASSWORD, token: totp(secret)});
        expect(disable.status).toBe(200);
    });

    it("protects against self-deletion and owner deletion", async () => {
        const memberId = await createUser("member", MEMBER_PASSWORD);
        const users = await owner.get("/api/users");
        const ownerId = users.body.data.users.find((user: {username: string}) => user.username === "owner").id;

        const self = await del(owner, `/api/users/${ownerId}`);
        expect(self.status).toBe(400);

        const missing = await del(owner, "/api/users/9999");
        expect(missing.status).toBe(404);

        const deleted = await del(owner, `/api/users/${memberId}`);
        expect(deleted.status).toBe(200);
    });
});
