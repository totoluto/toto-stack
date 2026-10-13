import {describe, expect, it} from "vitest";
import request from "supertest";
import {advanceClock, agentFor, csrf, postJson, totp} from "../helpers";
import {createUserVia, fakePrisma, freshServer, loginAgent, serverWithOwner, sleep} from "./support";

const OWNER_PASSWORD = "owner-password-123";

describe("anonymous CSRF tokens (M4)", () => {
    it("GET /api/auth/csrf creates no session rows for anonymous visitors", async () => {
        const {app} = await freshServer();
        let upserts = 0;
        const create = fakePrisma.session.create;
        fakePrisma.session.create = async args => {
            upserts++;
            return create(args);
        };

        try {
            for (let i = 0; i < 50; i++) {
                const res = await request(app).get("/api/auth/csrf");
                expect(res.status).toBe(200);
                expect(res.body.data.token).toMatch(/^a\./);
            }
            // A failed anonymous login doesn't write either
            await postJson(agentFor(app), "/api/auth/login", {username: "nobody", password: "wrong-password"});
        } finally {
            fakePrisma.session.create = create;
        }

        expect(upserts).toBe(0);
    });

    it("binds the anonymous token to the browser's nonce cookie and expires it", async () => {
        const {app} = await serverWithOwner({}, OWNER_PASSWORD);
        const alice = agentFor(app);
        const mallory = agentFor(app);
        const aliceToken = await csrf(alice);

        const stolen = await mallory.post("/api/auth/login").set("X-CSRF-Token", aliceToken).send({username: "owner", password: OWNER_PASSWORD});
        expect(stolen.status).toBe(403);
        expect(stolen.body.code).toBe("CSRF_INVALID");

        const forged = await alice.post("/api/auth/login").set("X-CSRF-Token", aliceToken.replace(/.$/, c => (c === "A" ? "B" : "A"))).send({username: "x", password: "y"});
        expect(forged.status).toBe(403);

        expect((await alice.post("/api/auth/login").set("X-CSRF-Token", aliceToken).send({username: "x", password: "y"})).status).toBe(200);

        advanceClock(13 * 60 * 60 * 1000);
        expect((await alice.post("/api/auth/login").set("X-CSRF-Token", aliceToken).send({username: "x", password: "y"})).status).toBe(403);
    });

    it("authenticated sessions accept only their session-bound token", async () => {
        const {app, owner} = await serverWithOwner({}, OWNER_PASSWORD);
        await createUserVia(owner, "dave", "dave-password-123");

        const dave = agentFor(app);
        const anonToken = await csrf(dave);
        await dave.post("/api/auth/login").set("X-CSRF-Token", anonToken).send({username: "dave", password: "dave-password-123"});

        const stale = await dave.post("/api/auth/logout").set("X-CSRF-Token", anonToken).send({});
        expect(stale.status).toBe(403);
        expect(stale.body.code).toBe("CSRF_INVALID");

        const sessionToken = await csrf(dave);
        expect(sessionToken).not.toMatch(/^a\./);
        expect(await csrf(dave)).toBe(sessionToken);
        expect((await dave.post("/api/auth/logout").set("X-CSRF-Token", sessionToken).send({})).status).toBe(200);
    });
});

describe("MFA login flow (M6, M15)", () => {
    it("logout and a new login never dead-end after a correct password", async () => {
        const {app, ownerSecret} = await serverWithOwner({}, OWNER_PASSWORD);
        const agent = agentFor(app);

        const first = await postJson(agent, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        expect(first.body.data.authState).toBe("otp");

        // A new login replaces the pending one
        const again = await postJson(agent, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        expect(again.status).toBe(200);
        expect(again.body.data.authState).toBe("otp");

        // Logout clears the pending MFA state
        const logout = await postJson(agent, "/api/auth/logout", {});
        expect(logout.status).toBe(200);
        expect((await agent.get("/api/auth/me")).body.data.authState).toBe("login");
        expect((await postJson(agent, "/api/auth/login/verify", {token: "123456"})).status).toBe(401);

        // Logout without any session is fine too
        expect((await postJson(agentFor(app), "/api/auth/logout", {})).status).toBe(200);

        advanceClock(31_000);
        await postJson(agent, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        const verified = await postJson(agent, "/api/auth/login/verify", {token: totp(ownerSecret)});
        expect(verified.body.data.authState).toBe("authenticated");
    });

    it("a pending MFA login does not survive a password change (F4)", async () => {
        const {app, owner, ownerSecret} = await serverWithOwner({}, OWNER_PASSWORD);
        const attacker = agentFor(app);
        expect((await postJson(attacker, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD})).body.data.authState).toBe("otp");

        // The owner notices and changes the password
        expect((await postJson(owner, "/api/account/password", {currentPassword: OWNER_PASSWORD, newPassword: "a-brand-new-password-9"})).status).toBe(200);

        advanceClock(31_000);
        const res = await postJson(attacker, "/api/auth/login/verify", {token: totp(ownerSecret)});
        expect(res.body.data).toEqual({user: null, authState: "login"});
        expect((await attacker.get("/api/auth/me")).body.data.authState).toBe("login");

        // A pending login started after the change works
        advanceClock(31_000);
        const fresh = agentFor(app);
        await postJson(fresh, "/api/auth/login", {username: "owner", password: "a-brand-new-password-9"});
        expect((await postJson(fresh, "/api/auth/login/verify", {token: totp(ownerSecret)})).body.data.authState).toBe("authenticated");
    });

    it("a pending MFA login survives the rehash done by that login (outdated Argon2 parameters)", async () => {
        const {app, ownerSecret} = await serverWithOwner({}, OWNER_PASSWORD);
        const argon2 = await import("@node-rs/argon2");
        const owner = (await fakePrisma.user.findFirst({where: {username: "owner"}}))!;
        await fakePrisma.user.update({where: {id: owner.id}, data: {password: await argon2.hash(OWNER_PASSWORD, {memoryCost: 8192, timeCost: 2, parallelism: 1})}});

        advanceClock(31_000);
        const agent = agentFor(app);
        await postJson(agent, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        expect((await fakePrisma.user.findFirst({where: {id: owner.id}}))!.password).toMatch(/^\$argon2id\$v=19\$m=19456,/);
        expect((await postJson(agent, "/api/auth/login/verify", {token: totp(ownerSecret)})).body.data.authState).toBe("authenticated");
    });

    it("expires a pending MFA login after 10 minutes", async () => {
        const {app, ownerSecret} = await serverWithOwner({}, OWNER_PASSWORD);
        const agent = agentFor(app);
        await postJson(agent, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});

        advanceClock(11 * 60 * 1000);
        const res = await postJson(agent, "/api/auth/login/verify", {token: totp(ownerSecret)});
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("MFA_NOT_PENDING");
    });

    it("accepts a code from the next step (clock drift) and rejects replays, also concurrent ones", async () => {
        const {app, ownerSecret} = await serverWithOwner({}, OWNER_PASSWORD);
        advanceClock(31_000);

        // The phone is one step ahead
        const drifted = agentFor(app);
        await postJson(drifted, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        const ahead = totp(ownerSecret, Date.now() + 30_000);
        expect((await postJson(drifted, "/api/auth/login/verify", {token: ahead})).body.data.authState).toBe("authenticated");

        // That step is used: the same code and the current (older) one are rejected now
        const replay = agentFor(app);
        await postJson(replay, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        expect((await postJson(replay, "/api/auth/login/verify", {token: ahead})).body.data.authState).toBe("otp");
        expect((await postJson(replay, "/api/auth/login/verify", {token: totp(ownerSecret)})).body.data.authState).toBe("otp");

        // Two sessions submit the same fresh code at the same time: exactly one wins
        advanceClock(90_000);
        const a = agentFor(app);
        const b = agentFor(app);
        await postJson(a, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        await postJson(b, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        const [ta, tb] = [await csrf(a), await csrf(b)];
        const code = totp(ownerSecret);

        const findFirst = fakePrisma.user.findFirst;
        fakePrisma.user.findFirst = async args => {
            const user = await findFirst(args);
            await sleep(20); // both requests read the same otpLastUsedStep
            return user;
        };

        try {
            const results = await Promise.all([
                a.post("/api/auth/login/verify").set("X-CSRF-Token", ta).send({token: code}),
                b.post("/api/auth/login/verify").set("X-CSRF-Token", tb).send({token: code}),
            ]);
            expect(results.map(res => res.body.data.authState).sort()).toEqual(["authenticated", "otp"]);
        } finally {
            fakePrisma.user.findFirst = findFirst;
        }
    });

    it("encrypts TOTP secrets at rest when a key is configured, and seals secrets stored before the key was set (L37)", async () => {
        const otpEncryptionKey = "c6d2d8797bfc0e7966c30ed330f5277132da58da6880aaae358708efbb037c6f";
        const {app, ownerSecret} = await serverWithOwner({security: {otpEncryptionKey}}, OWNER_PASSWORD);

        const stored = (await fakePrisma.user.findFirst({where: {username: "owner"}}))!;
        expect(stored.otpSecret).toMatch(/^enc:v1:/);
        expect(stored.otpSecret).not.toContain(ownerSecret);

        // Simulate a secret stored before encryption was enabled
        await fakePrisma.user.update({where: {id: stored.id}, data: {otpSecret: ownerSecret}});
        advanceClock(31_000);
        const agent = agentFor(app);
        await postJson(agent, "/api/auth/login", {username: "owner", password: OWNER_PASSWORD});
        expect((await postJson(agent, "/api/auth/login/verify", {token: totp(ownerSecret)})).body.data.authState).toBe("authenticated");
        expect((await fakePrisma.user.findFirst({where: {id: stored.id}}))!.otpSecret).toMatch(/^enc:v1:/);
    });
});

describe("session freshness (L17, L18)", () => {
    it("/me returns roles from the database, not the session", async () => {
        const {app, owner} = await serverWithOwner({roles: ["editor"]}, OWNER_PASSWORD);
        const id = await createUserVia(owner, "erin", "erin-password-123", ["editor"]);
        const erin = agentFor(app);
        const login = await postJson(erin, "/api/auth/login", {username: "erin", password: "erin-password-123"});
        expect((await erin.get("/api/auth/me")).body.data.user.roles).toEqual(["editor"]);

        // Session data claiming other roles (stale or tampered) is not trusted
        const cookie = (login.headers["set-cookie"] as unknown as string[]).find(header => header.startsWith("connect.sid="))!;
        const sessionId = decodeURIComponent(cookie.split(";")[0].slice("connect.sid=".length)).replace(/^s:/, "").replace(/\.[^.]*$/, "");
        const row = (await fakePrisma.session.findUnique({where: {id: sessionId}}))!;
        await fakePrisma.session.update({where: {id: sessionId}, data: {data: {...(row.data as object), roles: ["owner"]}}});
        expect((await erin.get("/api/auth/me")).body.data.user.roles).toEqual(["editor"]);

        // A deleted user is signed out
        await fakePrisma.user.delete({where: {id}});
        expect((await erin.get("/api/auth/me")).body.data.authState).toBe("login");
    });

    it("enabling and disabling MFA sign out the user's other sessions", async () => {
        const {app, owner} = await serverWithOwner({}, OWNER_PASSWORD);
        await createUserVia(owner, "gina", "gina-password-123");
        const gina = await loginAgent(app, "gina", "gina-password-123");
        const otherDevice = await loginAgent(app, "gina", "gina-password-123");

        const start = await postJson(gina, "/api/account/mfa/start", {password: "gina-password-123"});
        const secret = start.body.data.key;
        expect((await postJson(gina, "/api/account/mfa/verify", {token: totp(secret)})).status).toBe(200);
        expect((await otherDevice.get("/api/auth/me")).body.data.authState).toBe("login");

        // Log in on another device (password + MFA)
        advanceClock(31_000);
        const second = agentFor(app);
        await postJson(second, "/api/auth/login", {username: "gina", password: "gina-password-123"});
        expect((await postJson(second, "/api/auth/login/verify", {token: totp(secret)})).body.data.authState).toBe("authenticated");

        // The code just used can't disable MFA (replay); the next one can
        const replay = await postJson(gina, "/api/account/mfa/disable", {password: "gina-password-123", token: totp(secret)});
        expect(replay.status).toBe(400);
        expect(replay.body.code).toBe("MFA_INVALID");

        advanceClock(31_000);
        expect((await postJson(gina, "/api/account/mfa/disable", {password: "gina-password-123", token: totp(secret)})).status).toBe(200);
        expect((await second.get("/api/auth/me")).body.data.authState).toBe("login");
        expect((await gina.get("/api/auth/me")).body.data.authState).toBe("authenticated");
    });
});
