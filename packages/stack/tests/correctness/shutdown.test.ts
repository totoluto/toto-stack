import {afterEach, describe, expect, it} from "vitest";
import {spawn} from "node:child_process";
import type {AddressInfo} from "node:net";
import {BaseRoute, type Dependencies} from "toto-stack";
import {makeServer} from "../core/support";
import {captureLogs, packageRoot, sleep} from "./support";

describe("stop() order", () => {
    const servers: Array<ReturnType<typeof makeServer>> = [];
    afterEach(async () => {
        await Promise.allSettled(servers.splice(0).map(server => server.stop()));
    });

    it("drains requests and stops services before onShutdown; beforeShutdown runs first", async () => {
        const log: string[] = [];
        let hits = 0;

        class SlowRoute extends BaseRoute {
            constructor(dependencies: Dependencies) {
                super("/slow", dependencies, {auth: false});
            }

            protected registerRoutes(): void {
                this.get("/", async (_req, res) => {
                    hits++;
                    await sleep(300);
                    log.push("request:end");
                    res.json({status: "success", message: "done"});
                });
            }
        }

        const capture = captureLogs();
        const server = makeServer({
            http: {port: 0, host: "127.0.0.1"},
            routes: [SlowRoute],
            // Far beyond any CI hiccup: hitting it would mean the drain waited for the timeout.
            shutdown: {timeoutMs: 20_000},
            backgroundServices: () => [{name: "worker", start: () => undefined, stop: () => void log.push("service:stop")}],
            hooks: {
                beforeShutdown: () => void log.push("beforeShutdown"),
                onShutdown: () => void log.push("onShutdown"),
            },
        });
        servers.push(server);
        await server.start();
        const close = server.dependencies.emailService.close.bind(server.dependencies.emailService);
        server.dependencies.emailService.close = async () => {
            log.push("email:close");
            await close();
        };

        const port = (server.httpServer!.address() as AddressInfo).port;
        const response = fetch(`http://127.0.0.1:${port}/api/slow`);
        while (hits === 0) await sleep(5);

        try {
            await server.stop();
        } finally {
            capture.restore();
        }

        expect((await response).status).toBe(200);
        expect(log).toEqual(["beforeShutdown", "request:end", "service:stop", "email:close", "onShutdown"]);
        // The keep-alive connection was closed when its response ended, not force-closed at the timeout.
        expect(capture.all()).not.toContain("Connections still open");
    });
});

// Child processes running the BUILT package with shutdown.handleSignals.
const childScript = (options: {beforeShutdown?: string; onShutdown?: string; timeoutMs?: number}) => `
const realExit = process.exit.bind(process);
process.exit = code => { process.stdout.write("EXIT_CALLED " + code + "\\n"); realExit(code); };
process.on("exit", code => process.stdout.write("EXITING " + code + "\\n"));

const {createServer, BaseRoute} = await import("toto-stack");
class Slow extends BaseRoute {
    constructor(dependencies) { super("/slow", dependencies, {auth: false}); }
    registerRoutes() {
        this.get("/", async (_req, res) => {
            process.stdout.write("REQUEST_START\\n");
            await new Promise(resolve => setTimeout(resolve, 400));
            process.stdout.write("REQUEST_END\\n");
            res.json({status: "success", message: "done"});
        });
    }
}
const prisma = {user: {count: async () => 0}, role: {findMany: async () => [], upsert: async () => ({})}, session: {}, $queryRaw: async () => []};
const server = createServer({
    prisma,
    routes: [Slow],
    http: {port: 0, host: "127.0.0.1"},
    logger: {patchConsole: false, level: "warn"},
    shutdown: {handleSignals: true, timeoutMs: ${options.timeoutMs ?? 15_000}},
    hooks: {
        onReady: () => process.stdout.write("READY " + server.httpServer.address().port + "\\n"),
        beforeShutdown: ${options.beforeShutdown ?? "() => undefined"},
        onShutdown: ${options.onShutdown ?? `async () => { await new Promise(r => setTimeout(r, 50)); process.stdout.write("ON_SHUTDOWN\\n"); }`},
    },
});
await server.start();
`;

const children: Array<ReturnType<typeof spawn>> = [];

function startChild(script: string) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: packageRoot,
        env: {...process.env, NODE_ENV: "test", FORCE_COLOR: "0"},
        stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null; at: number}>(resolve => {
        child.on("exit", (code, signal) => resolve({code, signal, at: Date.now()}));
    });
    const waitFor = async (marker: string, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!stdout.includes(marker)) {
            if (Date.now() > deadline || child.exitCode !== null) throw new Error(`"${marker}" not seen.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
            await sleep(10);
        }
    };
    const port = async () => {
        await waitFor("READY ");
        return Number(/READY (\d+)/.exec(stdout)![1]);
    };
    return {child, exited, waitFor, port, output: () => ({stdout, stderr})};
}

describe("shutdown.handleSignals (built package)", () => {
    afterEach(() => {
        for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });

    it("on SIGTERM drains the in-flight request, then runs onShutdown, then exits 0 by itself", async () => {
        const run = startChild(childScript({}));
        const port = await run.port();

        const response = fetch(`http://127.0.0.1:${port}/api/slow`);
        await run.waitFor("REQUEST_START");
        run.child.kill("SIGTERM");

        expect((await response).status).toBe(200);
        const {code, signal} = await run.exited;
        const {stdout, stderr} = run.output();

        expect(signal, stderr).toBeNull();
        expect(code, stderr).toBe(0);
        expect(stdout).not.toContain("EXIT_CALLED");
        expect(stdout).toContain("EXITING 0");
        expect(stdout.indexOf("REQUEST_END")).toBeGreaterThan(-1);
        expect(stdout.indexOf("ON_SHUTDOWN")).toBeGreaterThan(stdout.indexOf("REQUEST_END"));
        // Drained without waiting for the timeout, and exited naturally (the fallback would call process.exit).
        expect(stderr).not.toContain("Connections still open");
        expect(stderr).not.toContain("Forcing exit");
    });

    it("exits immediately with 128 + signal on a second signal during shutdown", async () => {
        const run = startChild(childScript({beforeShutdown: "() => new Promise(() => setInterval(() => undefined, 1000))"}));
        await run.port();

        run.child.kill("SIGTERM");
        await sleep(200);
        expect(run.child.exitCode).toBeNull();
        run.child.kill("SIGINT");

        const {code} = await run.exited;
        expect(code).toBe(130);
        expect(run.output().stdout).toContain("EXIT_CALLED 130");
        expect(run.output().stdout).not.toContain("ON_SHUTDOWN");
    });

    it("force-exits with 1 when shutdown hangs past timeoutMs + grace", async () => {
        const run = startChild(childScript({timeoutMs: 100, onShutdown: "() => new Promise(() => setInterval(() => undefined, 1000))"}));
        await run.port();

        const signalledAt = Date.now();
        run.child.kill("SIGTERM");
        const {code, at} = await run.exited;

        expect(code).toBe(1);
        expect(run.output().stdout).toContain("EXIT_CALLED 1");
        expect(run.output().stderr).toContain("Forcing exit");
        // Never before timeoutMs + 5 s grace; the upper bound only guards against a hang.
        expect(at - signalledAt).toBeGreaterThanOrEqual(5_000);
        expect(at - signalledAt).toBeLessThan(25_000);
    });
});
