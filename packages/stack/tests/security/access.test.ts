import {beforeAll, beforeEach, describe, expect, it} from "vitest";
import request from "supertest";
import type {Express} from "express";
import type {Agent} from "supertest";
import {agentFor, del, postJson} from "../helpers";
import {createUserVia, fakePrisma, loginAgent, serverWithOwner, sleep} from "./support";

const ADMIN_PASSWORD = "admin-password-123";
const ALICE_PASSWORD = "alice-password-123";

describe("role granting (H1)", () => {
    let app: Express;
    let owner: Agent;
    let admin: Agent;

    beforeEach(async () => {
        ({app, owner} = await serverWithOwner({roles: ["editor"]}));
        await createUserVia(owner, "admin", ADMIN_PASSWORD, ["admin"]);
        admin = await loginAgent(app, "admin", ADMIN_PASSWORD);
    });

    it("an admin cannot create an owner or an admin", async () => {
        for (const roles of [["owner"], ["admin"], ["editor", "admin"]]) {
            const res = await postJson(admin, "/api/users", {username: `x-${roles.join("-")}`, password: "some-password-123", roles});
            expect(res.status).toBe(403);
            expect(res.body.code).toBe("ROLE_NOT_GRANTABLE");
        }
        expect((await fakePrisma.user.findMany()).map(user => user.username).sort()).toEqual(["admin", "owner"]);
    });

    it("an admin can grant app roles; an owner can grant admin", async () => {
        const editor = await postJson(admin, "/api/users", {username: "ed", password: "editor-password-1", roles: ["editor", "editor"]});
        expect(editor.status).toBe(201);
        expect(editor.body.data.user.roles).toEqual(["editor"]);

        const second = await postJson(owner, "/api/users", {username: "admin2", password: ADMIN_PASSWORD, roles: ["admin"]});
        expect(second.status).toBe(201);
    });

    it("rejects unknown roles", async () => {
        const res = await postJson(owner, "/api/users", {username: "ghost", password: "ghost-password-1", roles: ["superuser"]});
        expect(res.status).toBe(400);
    });

    it("admins cannot delete owners or admins; owners can delete admins", async () => {
        await createUserVia(admin, "ed", "editor-password-1", ["editor"]);
        await createUserVia(owner, "admin2", ADMIN_PASSWORD, ["admin"]);
        const users = await fakePrisma.user.findMany();
        const idOf = (name: string) => users.find(user => user.username === name)!.id;

        expect((await del(admin, `/api/users/${idOf("owner")}`)).status).toBe(403);
        expect((await del(admin, `/api/users/${idOf("admin2")}`)).status).toBe(403);
        expect((await del(admin, `/api/users/${idOf("admin")}`)).status).toBe(400); // self
        expect((await del(owner, `/api/users/${idOf("owner")}`)).status).toBe(400); // self
        expect((await del(admin, `/api/users/${idOf("ed")}`)).status).toBe(200);
        expect((await del(owner, `/api/users/${idOf("admin2")}`)).status).toBe(200);
    });

    it("a delete racing another delete answers 404, not 500", async () => {
        const id = await createUserVia(owner, "racer", "racer-password-1");
        const findFirst = fakePrisma.user.findFirst;
        fakePrisma.user.findFirst = async args => {
            const user = await findFirst(args);
            await sleep(10); // both requests see the user before either deletes it
            return user;
        };

        try {
            const [first, second] = await Promise.all([del(owner, `/api/users/${id}`), del(owner, `/api/users/${id}`)]);
            expect([first.status, second.status].sort()).toEqual([200, 404]);
            expect([first, second].find(res => res.status === 404)!.body.code).toBe("USER_NOT_FOUND");
        } finally {
            fakePrisma.user.findFirst = findFirst;
        }
    });

    it("maps a concurrent duplicate username to 409, not 500 (L3)", async () => {
        const create = fakePrisma.user.create;
        fakePrisma.user.create = async args => {
            await sleep(10);
            return create(args);
        };

        try {
            const [first, second] = await Promise.all([
                postJson(owner, "/api/users", {username: "twin", password: "twin-password-1", roles: []}),
                postJson(owner, "/api/users", {username: "twin", password: "twin-password-1", roles: []}),
            ]);
            expect([first.status, second.status].sort()).toEqual([201, 409]);
            expect([first, second].find(res => res.status === 409)!.body.code).toBe("USERNAME_TAKEN");
        } finally {
            fakePrisma.user.create = create;
        }
    });
});

describe("API keys (H11)", () => {
    let app: Express;
    let owner: Agent;
    const createAlice = () => createUserVia(owner, "alice", ALICE_PASSWORD);

    beforeEach(async () => {
        ({app, owner} = await serverWithOwner());
    });

    it("POST /users never returns an API key and users start without one", async () => {
        const res = await postJson(owner, "/api/users", {username: "alice", password: ALICE_PASSWORD, roles: []});
        expect(res.status).toBe(201);
        expect(JSON.stringify(res.body)).not.toMatch(/apiKey|toto_/);
        expect((await fakePrisma.user.findFirst({where: {username: "alice"}}))?.apiKey).toBeNull();
    });

    it("issues a prefixed key on the user's own request (with re-auth), stores only its hash", async () => {
        await createAlice();
        const alice = await loginAgent(app, "alice", ALICE_PASSWORD);

        expect((await postJson(alice, "/api/account/api-key", {password: "wrong-password"})).status).toBe(403);

        const res = await postJson(alice, "/api/account/api-key", {password: ALICE_PASSWORD});
        expect(res.status).toBe(200);
        const key: string = res.body.data.apiKey;
        expect(key).toMatch(/^toto_[A-Za-z0-9_-]{43}$/);

        const stored = (await fakePrisma.user.findFirst({where: {username: "alice"}}))!.apiKey;
        expect(stored).not.toBe(key);
        expect(stored).not.toContain(key.slice(5));

        const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${key}`);
        expect(me.body.data.user.username).toBe("alice");
    });

    it("revokes the key on request", async () => {
        await createAlice();
        const alice = await loginAgent(app, "alice", ALICE_PASSWORD);
        const key = (await postJson(alice, "/api/account/api-key", {password: ALICE_PASSWORD})).body.data.apiKey;

        const revoked = await request(app).delete("/api/account/api-key").set("Authorization", `Bearer ${key}`);
        expect(revoked.status).toBe(200);
        expect((await request(app).post("/api/account/api-key").set("Authorization", `Bearer ${key}`).send({password: ALICE_PASSWORD})).status).toBe(401);
        expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${key}`)).body.data.user).toBeNull();
    });

    it("revokes the key and other sessions when the password changes", async () => {
        await createAlice();
        const alice = await loginAgent(app, "alice", ALICE_PASSWORD);
        const otherDevice = await loginAgent(app, "alice", ALICE_PASSWORD);
        const key = (await postJson(alice, "/api/account/api-key", {password: ALICE_PASSWORD})).body.data.apiKey;

        const changed = await postJson(alice, "/api/account/password", {currentPassword: ALICE_PASSWORD, newPassword: "alice-new-password-1"});
        expect(changed.status).toBe(200);

        const viaKey = await request(app).post("/api/account/api-key").set("Authorization", `Bearer ${key}`).send({password: "alice-new-password-1"});
        expect(viaKey.status).toBe(401);
        expect((await otherDevice.get("/api/auth/me")).body.data.authState).toBe("login");
        expect((await alice.get("/api/auth/me")).body.data.authState).toBe("authenticated");
    });

    it("rejects malformed keys without a database lookup", async () => {
        let lookups = 0;
        const findUnique = fakePrisma.user.findUnique;
        fakePrisma.user.findUnique = async args => {
            lookups++;
            return findUnique(args);
        };

        try {
            for (const header of ["Bearer garbage", "Bearer ", "Bearer", `Bearer toto_${"a".repeat(10)}`]) {
                expect((await request(app).get("/api/users").set("Authorization", header)).status).toBe(401);
            }
            expect(lookups).toBe(0);
        } finally {
            fakePrisma.user.findUnique = findUnique;
        }
    });
});

describe("Bearer requests and CSRF (L1)", () => {
    let app: Express;
    let owner: Agent;

    beforeAll(async () => {
        ({app, owner} = await serverWithOwner());
    });

    it("a junk Bearer header plus a session cookie neither skips CSRF nor authenticates via the session", async () => {
        const body = {username: "nocsrf", password: "nocsrf-password-1", roles: ["admin"]};

        const noCsrf = await owner.post("/api/users").send(body);
        expect(noCsrf.status).toBe(403);
        expect(noCsrf.body.code).toBe("CSRF_INVALID");

        const junkBearer = await owner.post("/api/users").set("Authorization", "Bearer garbage").send(body);
        expect(junkBearer.status).toBe(401);

        const lowercase = await owner.post("/api/users").set("Authorization", "bearer garbage").send(body);
        expect(lowercase.status).toBe(401);

        expect(await fakePrisma.user.findFirst({where: {username: "nocsrf"}})).toBeNull();
    });

    it("non-Bearer Authorization (e.g. proxy Basic auth) keeps session auth and CSRF", async () => {
        const basic = `Basic ${Buffer.from("proxy:pass").toString("base64")}`;
        const res = await owner.post("/api/users").set("Authorization", basic).send({username: "viaBasic", password: "basic-password-1", roles: []});
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("CSRF_INVALID");

        expect((await owner.get("/api/users").set("Authorization", basic)).status).toBe(200);
    });

    it("session endpoints refuse Bearer requests", async () => {
        const bearer = "Bearer whatever";
        for (const path of ["/api/auth/login", "/api/auth/logout", "/api/auth/setup/start", "/api/auth/login/verify"]) {
            const payload = path.endsWith("verify") ? {token: "123456"} : path.endsWith("logout") ? {} : {username: "owner", password: "owner-password-123", setupToken: "x"};
            const res = await agentFor(app).post(path).set("Authorization", bearer).send(payload);
            expect(res.status, path).toBe(400);
        }
    });
});
