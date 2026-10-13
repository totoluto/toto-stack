import {afterEach, describe, expect, it, vi} from "vitest";
import {Logger} from "@server/libs/Logger";
import {agentFor, completeSetup, csrf, postJson, TEST_SETUP_TOKEN, totp} from "../helpers";
import {fakePrisma, freshServer, sleep} from "./support";
import {createServer} from "toto-stack";
import {resetFakeDb} from "../fakePrisma";

const PASSWORD = "owner-password-123";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("first-run setup (C3)", () => {
    it("rejects setup without a token or with a wrong token", async () => {
        const {app} = await freshServer();
        const agent = agentFor(app);

        const missing = await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD});
        expect(missing.status).toBe(400);

        const wrong = await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD, setupToken: "not-the-token-at-all"});
        expect(wrong.status).toBe(403);
        expect(wrong.body.code).toBe("SETUP_TOKEN_INVALID");

        // Without a started setup, verify can't create anyone
        const verify = await postJson(agent, "/api/auth/setup/verify", {token: "123456"});
        expect(verify.status).toBe(400);
        expect(await fakePrisma.user.count()).toBe(0);
    });

    it("applies the normal password policy to the owner password", async () => {
        const {app} = await freshServer();
        const res = await postJson(agentFor(app), "/api/auth/setup/start", {username: "owner", password: "x", setupToken: TEST_SETUP_TOKEN});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_FAILED");
    });

    it("rate-limits setup token guessing per IP", async () => {
        const {app} = await freshServer();
        const agent = agentFor(app);
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
            statuses.push((await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD, setupToken: `guess-${i}-xxxxxxxxxxxx`})).status);
        }
        expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
        expect(statuses[5]).toBe(429);
    });

    it("generates a one-time token when none is configured, prints it once to stderr, and accepts only it", async () => {
        resetFakeDb();
        // Even with a logger that drops everything (e.g. LOG_LEVEL=silent) the token must be visible
        const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const server = createServer({prisma: fakePrisma, logger: {patchConsole: false}});
        const app = await server.createApp();
        await server.createApp();

        const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).filter(chunk => chunk.includes("one-time setup token"));
        expect(printed).toHaveLength(1);
        const token = /token:\n\n {4}(\S+)\n/.exec(printed[0])![1];
        expect(token.length).toBeGreaterThanOrEqual(32);

        // The logger gets a notice, never the token itself
        const notices = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("setup token"));
        expect(notices).toHaveLength(1);
        expect(notices[0]).not.toContain(token);
        stderr.mockRestore();

        const agent = agentFor(app);
        const wrong = await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
        expect(wrong.status).toBe(403);

        await completeSetup(agent, "owner", PASSWORD, token);
        expect(server.dependencies.state.setupComplete).toBe(true);

        // A server booting with users generates no token
        const stderrAgain = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await createServer({prisma: fakePrisma, logger: {patchConsole: false}}).createApp();
        expect(stderrAgain.mock.calls.some(([chunk]) => String(chunk).includes("setup token"))).toBe(false);
    });

    it("creates exactly one owner when two setups race (simulated DB latency)", async () => {
        const {app} = await freshServer();
        const a = agentFor(app);
        const b = agentFor(app);

        const startA = await postJson(a, "/api/auth/setup/start", {username: "realowner", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
        const startB = await postJson(b, "/api/auth/setup/start", {username: "attacker", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
        expect([startA.status, startB.status]).toEqual([200, 200]);

        const create = fakePrisma.user.create;
        const slowCreate: typeof create = async args => {
            await sleep(20);
            return create(args);
        };
        fakePrisma.user.create = slowCreate;

        try {
            const [ta, tb] = [await csrf(a), await csrf(b)];
            const [va, vb] = await Promise.all([
                a.post("/api/auth/setup/verify").set("X-CSRF-Token", ta).send({token: totp(startA.body.data.key)}),
                b.post("/api/auth/setup/verify").set("X-CSRF-Token", tb).send({token: totp(startB.body.data.key)}),
            ]);

            const winners = [va, vb].filter(res => res.body.data?.user);
            const losers = [va, vb].filter(res => !res.body.data?.user);
            expect(winners).toHaveLength(1);
            expect(losers[0].status).toBe(403);
            expect(losers[0].body.code).toBe("SETUP_COMPLETED");
        } finally {
            fakePrisma.user.create = create;
        }

        const users = await fakePrisma.user.findMany({include: {roles: {include: {role: true}}}});
        expect(users).toHaveLength(1);
        expect(users[0].roles.map(userRole => userRole.role.name)).toEqual(["owner"]);
        expect(await fakePrisma.setupLock.findMany()).toHaveLength(1);
    });

    it("answers 403, not 500, when the losing setup fails with a write conflict (MariaDB >= 11.6: P2039)", async () => {
        const {app} = await freshServer();
        const a = agentFor(app);
        const b = agentFor(app);
        const startA = await postJson(a, "/api/auth/setup/start", {username: "realowner", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
        const startB = await postJson(b, "/api/auth/setup/start", {username: "attacker", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});

        // Like innodb_snapshot_isolation: the loser gets "Record has changed since last read" (1020) instead of a unique violation
        const create = fakePrisma.user.create;
        const createLock = fakePrisma.setupLock.create;
        fakePrisma.user.create = async args => {
            await sleep(20);
            return create(args);
        };
        fakePrisma.setupLock.create = async args => {
            if ((await fakePrisma.setupLock.findMany()).length > 0) {
                throw Object.assign(new Error("Record has changed since last read in table 'SetupLock'"), {code: "P2039"});
            }
            return createLock(args);
        };

        try {
            const [ta, tb] = [await csrf(a), await csrf(b)];
            const results = await Promise.all([
                a.post("/api/auth/setup/verify").set("X-CSRF-Token", ta).send({token: totp(startA.body.data.key)}),
                b.post("/api/auth/setup/verify").set("X-CSRF-Token", tb).send({token: totp(startB.body.data.key)}),
            ]);

            expect(results.map(res => res.status).sort()).toEqual([200, 403]);
            expect(results.find(res => res.status === 403)!.body.code).toBe("SETUP_COMPLETED");
        } finally {
            fakePrisma.user.create = create;
            fakePrisma.setupLock.create = createLock;
        }

        expect(await fakePrisma.user.count()).toBe(1);
        expect(await fakePrisma.setupLock.findMany()).toHaveLength(1);
    });

    it("still fails with 500 when the setup transaction fails and no owner exists", async () => {
        const {app, server} = await freshServer();
        const agent = agentFor(app);
        const start = await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});

        const createLock = fakePrisma.setupLock.create;
        fakePrisma.setupLock.create = async () => {
            throw Object.assign(new Error("Connection lost"), {code: "P1017"});
        };

        try {
            const res = await postJson(agent, "/api/auth/setup/verify", {token: totp(start.body.data.key)});
            expect(res.status).toBe(500);
        } finally {
            fakePrisma.setupLock.create = createLock;
        }

        // Rolled back; setup is still possible
        expect(await fakePrisma.user.count()).toBe(0);
        expect(server.dependencies.state.setupComplete).toBe(false);
    });

    it("re-checks the database: a setup completed elsewhere blocks this instance (M5)", async () => {
        const {app, server} = await freshServer();
        const agent = agentFor(app);
        const start = await postJson(agent, "/api/auth/setup/start", {username: "owner", password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
        expect(start.status).toBe(200);

        // Another instance completed setup meanwhile
        await fakePrisma.user.create({data: {username: "other-owner", password: "x"}});
        expect(server.dependencies.state.setupComplete).toBe(false);

        const verify = await postJson(agent, "/api/auth/setup/verify", {token: totp(start.body.data.key)});
        expect(verify.status).toBe(403);
        expect(await fakePrisma.user.count()).toBe(1);
        expect(server.dependencies.state.setupComplete).toBe(true);
    });

    it("stores the owner with MFA, an Argon2id hash and the used TOTP step", async () => {
        const {app} = await freshServer();
        await completeSetup(agentFor(app), "owner", PASSWORD);

        const owner = await fakePrisma.user.findFirst({where: {username: "owner"}});
        expect(owner?.password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
        expect(owner?.otpEnabled).toBe(true);
        expect(owner?.otpLastUsedStep).toBe(Math.floor(Date.now() / 30_000));
        expect(owner?.apiKey).toBeNull();
    });

    it("discloses only the auth state on /api/auth/me", async () => {
        const {app} = await freshServer();
        const anonymous = await agentFor(app).get("/api/auth/me");
        expect(anonymous.body.data).toEqual({user: null, authState: "setup"});

        const agent = agentFor(app);
        await completeSetup(agent, "owner", PASSWORD);

        const me = await agent.get("/api/auth/me");
        expect(me.body.data).toEqual({user: {id: 1, username: "owner", roles: ["owner"]}, authState: "authenticated"});
        expect((await agentFor(app).get("/api/auth/me")).body.data).toEqual({user: null, authState: "login"});
    });
});
