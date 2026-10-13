import crypto from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, inject} from "vitest";
import type {Express} from "express";
import {createServer, Server, StackConfig, StackPrismaClient} from "toto-stack";
import {TEST_SETUP_TOKEN} from "../helpers";
import {PROD_SECRET} from "../core/support";
import {withTemplateRoutes} from "../templateRoutes";
import "./env";

export const db = inject("integrationDb");

/** describe() that is skipped (with the reason in its name) when no test database is configured. */
export const describeDb = (name: string, fn: () => void) =>
    db.available ? describe(name, fn) : describe.skip(`${name} [skipped: ${db.reason}]`, fn);

/** The real generated client, typed by what the stack and the tests use. */
export type RealPrisma = StackPrismaClient & {
    $disconnect(): Promise<void>;
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    session: StackPrismaClient["session"] & {
        findUnique(args: object): Promise<{id: string; userId: number | null; data: unknown; userAgent: string | null; expiresAt: Date} | null>;
        findMany(args?: object): Promise<{id: string; userId: number | null; data: unknown; userAgent: string | null; expiresAt: Date}[]>;
        count(args?: object): Promise<number>;
        createMany(args: object): Promise<{count: number}>;
        update(args: object): Promise<unknown>;
    };
    user: StackPrismaClient["user"] & {findMany(args?: object): Promise<Record<string, unknown>[]>; count(args?: object): Promise<number>};
    role: StackPrismaClient["role"] & {findMany(args?: object): Promise<{name: string}[]>};
    setupLock: StackPrismaClient["setupLock"] & {count(): Promise<number>};
};

/** The session secret both server instances share in multi-instance tests (a strong one). */
export const SESSION_SECRET = PROD_SECRET;

/** A new Prisma 7 client (template schema, MariaDB driver adapter) on the test database. */
export async function createPrisma(): Promise<RealPrisma> {
    if (!db.available) throw new Error("No integration database.");
    const {PrismaClient} = await import(/* @vite-ignore */ db.clientPath);
    const {PrismaMariaDb} = await import("@prisma/adapter-mariadb");
    const url = new URL(db.url);
    const adapter = new PrismaMariaDb({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        connectionLimit: 10,
    });
    return new PrismaClient({adapter}) as RealPrisma;
}

/** Deletes every row (children first), keeping the migrated schema. */
export async function resetDatabase(prisma: RealPrisma): Promise<void> {
    for (const table of ["Session", "UserRole", "SetupLock", "User", "Role"]) {
        await prisma.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    }
}

/**
 * One Prisma client per test file (a second one for multi-instance tests),
 * with the tables emptied before each test.
 */
export function useDatabase(): {prisma: () => RealPrisma; second: () => RealPrisma} {
    let first: RealPrisma | undefined;
    let other: RealPrisma | undefined;

    beforeAll(async () => {
        if (!db.available) return;
        first = await createPrisma();
        other = await createPrisma();
    });
    beforeEach(async () => {
        if (first) await resetDatabase(first);
    });
    afterAll(async () => {
        await first?.$disconnect();
        await other?.$disconnect();
    });

    return {prisma: () => first!, second: () => other!};
}

export async function createRealServer(prisma: StackPrismaClient, config: Omit<StackConfig, "prisma"> = {}): Promise<{server: Server; app: Express}> {
    const server = createServer({
        logger: {patchConsole: false},
        ...config,
        routes: withTemplateRoutes(config.routes),
        prisma,
        security: {setupToken: TEST_SETUP_TOKEN, sessionSecret: SESSION_SECRET, ...config.security},
    });
    return {server, app: await server.createApp()};
}

/** The session id behind a signed express-session cookie value ("s:<sid>.<signature>"). */
export function sessionIdFromCookie(cookieHeader: string, name: string): string {
    const pair = cookieHeader.split(/;\s*/).find(part => part.startsWith(`${name}=`));
    if (!pair) throw new Error(`No ${name} cookie in ${cookieHeader}`);
    const value = decodeURIComponent(pair.slice(name.length + 1));
    return value.slice(2, value.lastIndexOf("."));
}

/** A signed express-session cookie for a session id. */
export function signedSessionCookie(name: string, sid: string, secret = SESSION_SECRET): string {
    const signature = crypto.createHmac("sha256", secret).update(sid).digest("base64").replace(/=+$/, "");
    return `${name}=${encodeURIComponent(`s:${sid}.${signature}`)}`;
}

/** The `name=value` pair of a cookie set by a response. */
export function setCookie(res: {headers: Record<string, unknown>}, name: string): string {
    const header = res.headers["set-cookie"];
    const cookies = Array.isArray(header) ? header as string[] : typeof header === "string" ? [header] : [];
    const cookie = cookies.find(value => value.startsWith(`${name}=`));
    if (!cookie) throw new Error(`The response set no ${name} cookie.`);
    return cookie.split(";")[0];
}

type Gate = {reached: Promise<void>; release(): void};

/**
 * Wraps a client so a session write (create/update/updateMany/upsert) of a
 * chosen session id can be held until released. Hand `client` to the server,
 * then call hold(sid) before triggering the request.
 */
export function sessionWriteGate(prisma: RealPrisma): {client: RealPrisma; hold(sid: string): Gate} {
    let pending: {sid: string; signal(): void; released: Promise<void>} | undefined;
    const writes = new Set(["create", "update", "updateMany", "upsert"]);

    const session = new Proxy(prisma.session, {
        get(target, operation, receiver) {
            const value = Reflect.get(target, operation, receiver);
            if (typeof operation !== "string" || !writes.has(operation) || typeof value !== "function") return value;
            return async (args: {where?: {id?: unknown}; create?: {id?: unknown}; data?: {id?: unknown}}) => {
                const id = args.where?.id ?? args.create?.id ?? args.data?.id;
                if (pending && id === pending.sid) {
                    const {signal, released} = pending;
                    pending = undefined;
                    signal();
                    await released;
                }
                return value.call(target, args);
            };
        },
    });
    const client = new Proxy(prisma, {
        get(target, property, receiver) {
            if (property === "session") return session;
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    return {
        client,
        hold(sid) {
            let signal!: () => void;
            let release!: () => void;
            const reached = new Promise<void>(resolve => (signal = resolve));
            const released = new Promise<void>(resolve => (release = resolve));
            pending = {sid, signal, released};
            const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`No session write for ${sid} within 10 s`)), 10_000).unref());
            return {reached: Promise.race([reached, timeout]), release};
        },
    };
}

/** Counts calls per "model.operation" on a client (wraps every delegate). */
export function countCalls(prisma: RealPrisma): {client: RealPrisma; counts: Map<string, number>} {
    const counts = new Map<string, number>();
    const wrap = (model: string, delegate: object) => new Proxy(delegate, {
        get(target, operation, receiver) {
            const value = Reflect.get(target, operation, receiver);
            if (typeof operation !== "string" || typeof value !== "function") return value;
            return (...args: unknown[]) => {
                counts.set(`${model}.${operation}`, (counts.get(`${model}.${operation}`) ?? 0) + 1);
                return value.apply(target, args);
            };
        },
    });
    const client = new Proxy(prisma, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof property === "string" && !property.startsWith("$") && typeof value === "object" && value !== null) return wrap(property, value);
            if (typeof property === "string" && typeof value === "function") {
                return (...args: unknown[]) => {
                    counts.set(property, (counts.get(property) ?? 0) + 1);
                    return value.apply(target, args);
                };
            }
            return value;
        },
    });
    return {client, counts};
}
