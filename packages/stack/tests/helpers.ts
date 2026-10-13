import {vi} from "vitest";
import {Express} from "express";
import request, {Agent} from "supertest";
import {createServer, Server, StackConfig} from "toto-stack";
import {generateSync} from "@otplib/totp";
import {crypto as nodeCryptoPlugin} from "@otplib/plugin-crypto-node";
import {base32} from "@otplib/plugin-base32-scure";
import {createFakePrisma, FakePrisma} from "./fakePrisma";
import {withTemplateRoutes} from "./templateRoutes";

/** The setup token createTestApp() configures. */
export const TEST_SETUP_TOKEN = "test-setup-token-0123456789";

export type TestContextOptions = Omit<StackConfig, "prisma"> & {
    /** Defaults to a fresh fake database for this app. */
    prisma?: FakePrisma;
};

export type TestContext = {app: Express; server: Server; prisma: FakePrisma};

/**
 * A server on its own fresh fake database (unless `prisma` is given), with
 * the test setup token and the template's routes (before `routes`).
 */
export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
    const {prisma = createFakePrisma(), ...config} = options;
    const server = createServer({
        logger: {patchConsole: false},
        ...config,
        routes: withTemplateRoutes(config.routes),
        prisma,
        security: {setupToken: TEST_SETUP_TOKEN, ...config.security},
    });
    return {app: await server.createApp(), server, prisma};
}

/** createTestContext(), returning only the Express app. */
export async function createTestApp(options: TestContextOptions = {}): Promise<Express> {
    return (await createTestContext(options)).app;
}

/** The current TOTP code of a base32 secret (what an authenticator app shows). */
export function totp(secret: string, timeMs: number = Date.now()): string {
    return generateSync({secret, epoch: timeMs / 1000, crypto: nodeCryptoPlugin, base32});
}

// Fetches a fresh CSRF token bound to the agent's session.
export async function csrf(agent: Agent): Promise<string> {
    const res = await agent.get("/api/auth/csrf");
    return res.body.data.token;
}

export function agentFor(app: Express): Agent {
    return request.agent(app);
}

// POSTs JSON with a freshly fetched CSRF token (fetched before the request is created).
export async function postJson(agent: Agent, url: string, body?: object) {
    const token = await csrf(agent);
    return agent.post(url).set("X-CSRF-Token", token).send(body ?? {});
}

// DELETEs with a freshly fetched CSRF token.
export async function del(agent: Agent, url: string) {
    const token = await csrf(agent);
    return agent.delete(url).set("X-CSRF-Token", token);
}

/**
 * Moves the wall clock (`Date`, `Date.now()`) forward; it keeps running from
 * there. Timers and sockets stay real. Used to move past a TOTP step or a
 * rate-limit window. Uses vitest's fake Date, which tests/setup.ts resets to
 * real time after every test. A test that fakes other timers itself must
 * include "Date" in `toFake`.
 */
export function advanceClock(ms: number): void {
    if (!vi.isFakeTimers()) {
        vi.useFakeTimers({toFake: ["Date"], shouldAdvanceTime: true});
    }
    vi.setSystemTime(Date.now() + ms);
}

// Runs the initial owner setup (username + password + TOTP) through the API.
export async function completeSetup(agent: Agent, username: string, password: string, setupToken: string = TEST_SETUP_TOKEN): Promise<{secret: string}> {
    const startRes = await postJson(agent, "/api/auth/setup/start", {username, password, setupToken});

    if (startRes.status !== 200) {
        throw new Error(`setup/start failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
    }

    const secret: string = startRes.body.data.key;

    const verifyRes = await postJson(agent, "/api/auth/setup/verify", {token: totp(secret)});

    if (verifyRes.status !== 200 || !verifyRes.body.data?.user) {
        throw new Error(`setup/verify failed: ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
    }

    return {secret};
}

/** A fresh app with an owner (MFA enabled through setup), logged in on `owner`. */
export async function createOwnerContext(options: TestContextOptions = {}, username = "owner", password = "owner-password-123") {
    const context = await createTestContext(options);
    const owner = agentFor(context.app);
    const {secret} = await completeSetup(owner, username, password);
    return {...context, owner, ownerSecret: secret};
}
