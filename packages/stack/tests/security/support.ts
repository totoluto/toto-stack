import type {Express} from "express";
import {createServer, StackConfig} from "toto-stack";
import fakePrisma, {resetFakeDb} from "../fakePrisma";
import {agentFor, completeSetup, postJson, TEST_SETUP_TOKEN} from "../helpers";
import {withTemplateRoutes} from "../templateRoutes";

export {fakePrisma, resetFakeDb};

/** A server on a fresh fake database, with the test setup token and the template's routes. */
export async function freshServer(config: Omit<StackConfig, "prisma"> = {}) {
    resetFakeDb();
    const server = createServer({
        prisma: fakePrisma,
        logger: {patchConsole: false},
        ...config,
        routes: withTemplateRoutes(config.routes),
        security: {setupToken: TEST_SETUP_TOKEN, ...config.security},
    });
    const app: Express = await server.createApp();
    return {server, app};
}

/** A fresh server with an owner (MFA enabled via setup), logged in on `owner`. */
export async function serverWithOwner(config: Omit<StackConfig, "prisma"> = {}, password = "owner-password-123") {
    const {server, app} = await freshServer(config);
    const owner = agentFor(app);
    const {secret} = await completeSetup(owner, "owner", password);
    return {server, app, owner, ownerSecret: secret};
}

/** Creates a user through the API (as `creator`) and returns its id. */
export async function createUserVia(creator: ReturnType<typeof agentFor>, username: string, password: string, roles: string[] = [], currentPassword = "owner-password-123"): Promise<number> {
    const res = await postJson(creator, "/api/users", {username, password, roles, currentPassword});
    if (res.status !== 201) {
        throw new Error(`create ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.user.id;
}

/** Logs a password-only user in on a new agent. */
export async function loginAgent(app: Express, username: string, password: string) {
    const agent = agentFor(app);
    const res = await postJson(agent, "/api/auth/login", {username, password});
    if (res.body.data?.authState !== "authenticated") {
        throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return agent;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
