import path from "node:path";
import {ConfigError, createServer} from "toto-stack";
import prisma from "./prisma";
import {routes} from "./routes";

/** Logs a startup failure (config errors without a stack trace) and exits. */
async function fail(message: string, err: unknown): Promise<never> {
    console.error(message, err instanceof ConfigError ? err.message : err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
}

// Configuration comes from the environment (see sample.env); options set here win.
const server = await Promise.resolve().then(() => createServer({
    prisma,
    // The built client next to this file: server/public in development
    // (after `npm run build:client`), dist/public in the production bundle.
    frontend: {dir: path.join(import.meta.dirname, "public")},
    // The app's API routes (users, notifications, status): see server/routes.
    // The stack adds the sign-in flow (/api/auth), /api/account and /api/health.
    routes,
    // SIGINT/SIGTERM: drain requests, stop jobs, then onShutdown; a second
    // signal exits immediately.
    shutdown: {handleSignals: true},
    hooks: {
        // The app owns the Prisma client: the stack never disconnects it.
        // onShutdown runs last, when nothing uses the database anymore.
        onShutdown: () => prisma.$disconnect(),
        // onHttpServerCreated: (http, deps) => attachSocketIo(http, deps),
    },
    // Extend here as the app grows:
    // roles: ["editor"],
    // services: (deps) => ({socketService: new SocketService(deps)}),
    // backgroundServices: (deps) => [new MyWorker(deps)],
    // cronJobs: (deps) => [new MyNightlyJob(deps)],
    // session: {absoluteTimeout: 7 * 24 * 60 * 60 * 1000, idleTimeout: 24 * 60 * 60 * 1000},
})).catch((err) => fail("Invalid configuration:", err));

// A failed start has already cleaned up the server; release the database too.
await server.start().catch((err) => fail("Failed to start the server:", err));
