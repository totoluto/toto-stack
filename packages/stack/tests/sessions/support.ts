import type {Express} from "express";
import type {Agent} from "supertest";
import {createServer, type StackConfig} from "toto-stack";
import fakePrisma, {resetFakeDb} from "../fakePrisma";
import {agentFor, completeSetup, postJson, TEST_SETUP_TOKEN} from "../helpers";
import {withTemplateRoutes} from "../templateRoutes";

export {fakePrisma, resetFakeDb};

const READS = new Set(["findUnique", "findFirst", "findMany", "count", "$queryRaw"]);

/**
 * fakePrisma behind a recorder: every delegate call is logged as
 * "model.method" (calls go through to the current fakePrisma methods, so
 * tests can still patch those).
 */
export function countingPrisma() {
    const calls: string[] = [];

    const delegate = <M extends "user" | "role" | "session" | "setupLock">(model: M) =>
        new Proxy(fakePrisma[model], {
            get(target, method: string) {
                const value = (target as Record<string, unknown>)[method];
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    calls.push(`${model}.${method}`);
                    return (target as Record<string, (...a: unknown[]) => unknown>)[method](...args);
                };
            },
        });

    const prisma = {
        ...fakePrisma,
        user: delegate("user"),
        role: delegate("role"),
        session: delegate("session"),
        setupLock: delegate("setupLock"),
        $queryRaw: (...args: Parameters<typeof fakePrisma.$queryRaw>) => {
            calls.push("$queryRaw");
            return fakePrisma.$queryRaw(...args);
        },
        $transaction: (<R>(fn: Parameters<typeof fakePrisma.$transaction<R>>[0]) => {
            calls.push("$transaction");
            return fakePrisma.$transaction(fn);
        }) as typeof fakePrisma.$transaction,
    } satisfies typeof fakePrisma;

    const isRead = (call: string) => READS.has(call.slice(call.lastIndexOf(".") + 1));

    return {
        prisma,
        calls,
        reads: () => calls.filter(isRead),
        writes: () => calls.filter(call => !isRead(call)),
        sessionCalls: () => calls.filter(call => call.startsWith("session.")),
        reset: () => {
            calls.length = 0;
        },
    };
}

export type Counter = ReturnType<typeof countingPrisma>;

/** A server on a fresh fake database whose Prisma calls are recorded. */
export async function countedServer(config: Omit<StackConfig, "prisma"> = {}) {
    resetFakeDb();
    const counter = countingPrisma();
    const server = createServer({
        prisma: counter.prisma,
        logger: {patchConsole: false},
        ...config,
        routes: withTemplateRoutes(config.routes),
        security: {setupToken: TEST_SETUP_TOKEN, ...config.security},
    });
    const app: Express = await server.createApp();
    return {server, app, counter};
}

/** Completes the owner setup and creates + logs in a password-only user ("user"). */
export async function withLoggedInUser(app: Express, password = "user-password-123"): Promise<{owner: Agent; user: Agent}> {
    const owner = agentFor(app);
    await completeSetup(owner, "owner", "owner-password-123");
    const created = await postJson(owner, "/api/users", {username: "user", password, roles: []});
    if (created.status !== 201) throw new Error(`create user failed: ${created.status}`);

    const user = agentFor(app);
    const login = await postJson(user, "/api/auth/login", {username: "user", password});
    if (login.body.data?.authState !== "authenticated") throw new Error(`login failed: ${JSON.stringify(login.body)}`);

    return {owner, user};
}

/** The Set-Cookie headers of a response. */
export function setCookies(res: {headers: Record<string, unknown>}): string[] {
    const header = res.headers["set-cookie"];
    return Array.isArray(header) ? header : header ? [String(header)] : [];
}

/** The session id inside a signed `s:<sid>.<signature>` cookie value. */
export function sessionIdOf(cookieHeader: string, name = "connect.sid"): string {
    const value = cookieHeader.split(";")[0].slice(name.length + 1);
    return decodeURIComponent(value).replace(/^s:/, "").replace(/\.[^.]*$/, "");
}

/** All session rows (via the fake, not counted). */
export async function sessionRows() {
    const rows = await fakePrisma.session.findMany({where: {expiresAt: {lt: new Date(8.64e15)}}});
    return rows as unknown as {id: string; data: unknown; userId: number | null; createdAt: Date; lastSeenAt: Date; expiresAt: Date; userAgent: string | null; ipAddress: string | null}[];
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
