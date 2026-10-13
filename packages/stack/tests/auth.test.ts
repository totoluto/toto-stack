import {describe, expect, it} from "vitest";
import {UserAuthState} from "@shared/types/user";
import {advanceClock, agentFor, createOwnerContext, createTestApp, postJson, TEST_SETUP_TOKEN, totp} from "./helpers";

const USERNAME = "owner";
const PASSWORD = "super-secret-password";

/** A six-digit code that is valid in none of the accepted steps (now ± 1). */
function wrongCode(secret: string): string {
    const valid = new Set([-30_000, 0, 30_000].map(offset => totp(secret, Date.now() + offset)));
    for (let code = 0; ; code++) {
        const candidate = String(code).padStart(6, "0");
        if (!valid.has(candidate)) return candidate;
    }
}

async function startSetup() {
    const app = await createTestApp();
    const agent = agentFor(app);
    const res = await postJson(agent, "/api/auth/setup/start", {username: USERNAME, password: PASSWORD, setupToken: TEST_SETUP_TOKEN});
    return {app, agent, res, secret: res.body.data?.key as string};
}

// Every test builds its own app and database: no test depends on another one.
describe("setup and authentication flow", () => {
    it("reports setup as required before any user exists", async () => {
        const res = await agentFor(await createTestApp()).get("/api/auth/me");

        expect(res.status).toBe(200);
        expect(res.body.data.authState).toBe(UserAuthState.SETUP);
    });

    it("starts setup and returns a TOTP enrollment", async () => {
        const {res} = await startSetup();

        expect(res.status).toBe(200);
        expect(res.body.data.qrCode).toMatch(/^data:image\//);
        expect(res.body.data.key).toBeTruthy();
    });

    it("rejects setup verification with a wrong token", async () => {
        const {agent, secret} = await startSetup();
        const res = await postJson(agent, "/api/auth/setup/verify", {token: wrongCode(secret)});

        expect(res.status).toBe(200);
        expect(res.body.data.user).toBeNull();
        expect(res.body.data.authState).toBe(UserAuthState.SETUP_VERIFY);
    });

    it("completes setup with a valid TOTP token and authenticates as owner", async () => {
        const {agent, secret} = await startSetup();
        const res = await postJson(agent, "/api/auth/setup/verify", {token: totp(secret)});

        expect(res.status).toBe(200);
        expect(res.body.data.authState).toBe(UserAuthState.AUTHENTICATED);
        expect(res.body.data.user.username).toBe(USERNAME);
        expect(res.body.data.user.roles).toContain("owner");
    });

    it("blocks setup once completed", async () => {
        const {app} = await createOwnerContext({}, USERNAME, PASSWORD);
        const res = await postJson(agentFor(app), "/api/auth/setup/start", {username: "attacker", password: "whatever-password", setupToken: TEST_SETUP_TOKEN});

        expect(res.status).toBe(403);
    });

    it("logs out", async () => {
        const {owner} = await createOwnerContext({}, USERNAME, PASSWORD);
        const res = await postJson(owner, "/api/auth/logout", {});

        expect(res.status).toBe(200);
        expect(res.body.data.authState).toBe(UserAuthState.LOGIN);

        const me = await owner.get("/api/auth/me");
        expect(me.body.data.user).toBeNull();
    });

    it("rejects a wrong password without leaking details", async () => {
        const {app} = await createOwnerContext({}, USERNAME, PASSWORD);
        const res = await postJson(agentFor(app), "/api/auth/login", {username: USERNAME, password: "wrong-password"});

        expect(res.status).toBe(200);
        expect(res.body.data.user).toBeNull();
        expect(res.body.data.authState).toBe(UserAuthState.LOGIN);
    });

    it("requires MFA after a correct password and authenticates with a valid token", async () => {
        const {app, ownerSecret} = await createOwnerContext({}, USERNAME, PASSWORD);
        // Move past the TOTP step consumed during setup (replay protection)
        advanceClock(31_000);
        const agent = agentFor(app);

        const loginRes = await postJson(agent, "/api/auth/login", {username: USERNAME, password: PASSWORD});

        expect(loginRes.status).toBe(200);
        expect(loginRes.body.data.authState).toBe(UserAuthState.OTP);
        expect(loginRes.body.data.user).toBeNull();

        const verifyRes = await postJson(agent, "/api/auth/login/verify", {token: totp(ownerSecret)});

        expect(verifyRes.status).toBe(200);
        expect(verifyRes.body.data.authState).toBe(UserAuthState.AUTHENTICATED);
    });

    it("rejects a replayed TOTP token", async () => {
        const {app, ownerSecret} = await createOwnerContext({}, USERNAME, PASSWORD);
        advanceClock(31_000);
        const replayToken = totp(ownerSecret);

        // First use authenticates
        const first = agentFor(app);
        await postJson(first, "/api/auth/login", {username: USERNAME, password: PASSWORD});
        const firstUse = await postJson(first, "/api/auth/login/verify", {token: replayToken});
        expect(firstUse.body.data.authState).toBe(UserAuthState.AUTHENTICATED);

        // A second use of the same token within the same step must fail
        const second = agentFor(app);
        await postJson(second, "/api/auth/login", {username: USERNAME, password: PASSWORD});
        const replay = await postJson(second, "/api/auth/login/verify", {token: replayToken});

        expect(replay.body.data.authState).toBe(UserAuthState.OTP);
        expect(replay.body.data.user).toBeNull();
    });
});
