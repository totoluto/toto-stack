import {afterEach, describe, expect, it, vi} from "vitest";
import {configureLogger, installConsoleLogger, Logger} from "@server/libs/Logger";
import {ConfigError, resolveConfig} from "@server/libs/config/StackConfig";
import fakePrisma from "../fakePrisma";
import {captureLogs, runNode} from "./support";
import {PROD_SECRET} from "../core/support";

const lines = (text: string) => text.split("\n").filter(Boolean);

describe("Logger (development format)", () => {
    let capture: ReturnType<typeof captureLogs> | undefined;
    let restoreConsole: (() => void) | undefined;

    afterEach(() => {
        restoreConsole?.();
        restoreConsole = undefined;
        capture?.restore();
        capture = undefined;
        vi.unstubAllEnvs();
    });

    it("writes debug/info to stdout and warn/error to stderr", () => {
        capture = captureLogs();
        const log = new Logger("Billing");

        log.debug("d");
        log.info("i");
        log.warn("w");
        log.error("e");

        expect(capture.stdout.join("")).toMatch(/\[DEBUG\]\[Billing\] d\n/);
        expect(capture.stdout.join("")).toMatch(/\[INFO\]\[Billing\] i\n/);
        expect(capture.stderr.join("")).toMatch(/\[WARN\]\[Billing\] w\n/);
        expect(capture.stderr.join("")).toMatch(/\[ERROR\]\[Billing\] e\n/);
        expect(capture.stdout.join("")).not.toContain("[WARN]");
        expect(capture.stderr.join("")).not.toContain("[INFO]");
    });

    it("filters by level", () => {
        capture = captureLogs("warn");
        const log = new Logger("Quiet");

        log.debug("hidden");
        log.info("hidden");
        log.warn("shown");

        expect(capture.all()).not.toContain("hidden");
        expect(capture.all()).toContain("shown");

        configureLogger({level: "silent"});
        log.error("nothing");
        expect(capture.all()).not.toContain("nothing");
    });

    it("resolves LOG_LEVEL at the first log call, not at import", () => {
        capture = captureLogs();
        configureLogger(undefined); // back to env defaults, resolved lazily
        vi.stubEnv("LOG_LEVEL", "error");

        new Logger("Lazy").warn("dropped");
        new Logger("Lazy").error("kept");

        expect(capture.all()).not.toContain("dropped");
        expect(capture.all()).toContain("kept");
    });

    it("adds no second prefix for loggers created after the console patch", () => {
        capture = captureLogs();
        restoreConsole = installConsoleLogger();
        const late = new Logger("Late");

        late.info("hello");
        console.log("from %s", "console");
        console.error("console error");

        const output = lines(capture.all());
        expect(output).toHaveLength(3);
        for (const line of output) {
            expect(line.match(/\[\d{4}-\d{2}-\d{2}T/g)).toHaveLength(1);
        }
        expect(output.find(line => line.includes("hello"))).toMatch(/\[INFO\]\[Late\] hello$/);
        expect(output.find(line => line.includes("from console"))).toMatch(/\[INFO\]\[console\] from console$/);
        expect(capture.stderr.join("")).toMatch(/\[ERROR\]\[console\] console error/);
    });

    it("prints structured fields and error stacks", () => {
        capture = captureLogs();
        const log = new Logger("Jobs");

        log.info("Invoice sent", {invoiceId: 42});
        log.error("Charge failed", new Error("card declined"));

        expect(capture.stdout.join("")).toContain("Invoice sent { invoiceId: 42 }");
        const stderr = capture.stderr.join("");
        expect(stderr).toContain("Charge failed\n");
        expect(stderr).toContain("Error: card declined");
        expect(stderr).toMatch(/at .*logger\.test\.ts/);
    });
});

describe("logger.level config", () => {
    const base = {prisma: fakePrisma};

    it("comes from logger.level, then LOG_LEVEL, then the mode default", () => {
        const dev = {NODE_ENV: "development"};
        expect(resolveConfig(base, dev).config.logger.level).toBe("debug");
        expect(resolveConfig(base, {...dev, LOG_LEVEL: "WARN"}).config.logger.level).toBe("warn");
        expect(resolveConfig({...base, logger: {level: "error"}}, {...dev, LOG_LEVEL: "warn"}).config.logger.level).toBe("error");

        const prod = {NODE_ENV: "production", SESSION_SECRET: PROD_SECRET, ALLOWED_ORIGINS: "https://app.example.com"};
        expect(resolveConfig(base, prod).config.logger.level).toBe("info");
        expect(resolveConfig(base, {...prod, LOG_LEVEL: "debug"}).config.logger.level).toBe("debug");
        expect(resolveConfig(base, dev).config.logger.format).toBe("pretty");
        expect(resolveConfig(base, prod).config.logger.format).toBe("json");
    });

    it("rejects an unknown level", () => {
        expect(() => resolveConfig(base, {NODE_ENV: "development", LOG_LEVEL: "verbose"})).toThrow(ConfigError);
        expect(() => resolveConfig(base, {NODE_ENV: "development", LOG_LEVEL: "verbose"})).toThrow(/LOG_LEVEL/);
    });
});

// These run the BUILT bundle (dist/), where file names and stack frames differ from src.
describe("Logger in the built package", () => {
    const prodEnv = {
        NODE_ENV: "production",
        SESSION_SECRET: PROD_SECRET,
        ALLOWED_ORIGINS: "https://app.example.com",
    };

    const serverScript = `
const {createServer} = await import("toto-stack");
const prisma = {user: {count: async () => 0}, role: {findMany: async () => [], upsert: async () => ({})}, session: {}, $queryRaw: async () => []};
const server = createServer({prisma, http: {port: 0, host: "127.0.0.1"}});
await server.start();
console.log("from app", {a: 1});
console.error("app failure", new Error("kaput"));
await server.stop();
`;

    it("emits one JSON object per line in production, with explicit service names", () => {
        const result = runNode(serverScript, prodEnv);
        expect(result.status, result.stderr).toBe(0);

        const records = lines(result.stdout).map(line => JSON.parse(line));
        for (const record of records) {
            expect(record).toEqual(expect.objectContaining({level: expect.any(String), time: expect.any(String), service: expect.any(String), msg: expect.any(String)}));
            expect(record.service).not.toBe("getCallerService");
        }

        expect(records).toContainEqual(expect.objectContaining({level: "info", service: "Server", msg: expect.stringContaining("Server listening on http://127.0.0.1:")}));
        expect(records).toContainEqual(expect.objectContaining({level: "info", service: "console", msg: "from app { a: 1 }"}));

        const failure = records.find(record => record.msg === "app failure");
        expect(failure).toMatchObject({level: "error", service: "console", err: {type: "Error", message: "kaput"}});
        expect(failure.err.stack).toContain("Error: kaput");
    });

    it("serializes errors under `err`, honours LOG_LEVEL, and keeps fields", () => {
        const script = `
const {Logger} = await import("toto-stack");
const log = new Logger("Billing");
log.debug("hidden at info");
log.info("Invoice sent", {invoiceId: 7});
log.error("Charge failed", new Error("card declined"));
`;
        const info = runNode(script, {NODE_ENV: "production"});
        expect(info.status, info.stderr).toBe(0);
        const records = lines(info.stdout).map(line => JSON.parse(line));
        expect(records).toHaveLength(2);
        expect(records[0]).toEqual({level: "info", time: expect.any(String), service: "Billing", invoiceId: 7, msg: "Invoice sent"});
        expect(records[1]).toMatchObject({level: "error", service: "Billing", msg: "Charge failed", err: {type: "Error", message: "card declined"}});

        const debug = runNode(script, {NODE_ENV: "production", LOG_LEVEL: "debug"});
        expect(lines(debug.stdout).map(line => JSON.parse(line).msg)).toContain("hidden at info");
    });

    it("tags lines correctly and routes warn/error to stderr in development", () => {
        const result = runNode(serverScript, {NODE_ENV: "development"});
        expect(result.status, result.stderr).toBe(0);

        const stdout = lines(result.stdout);
        expect(stdout.some(line => /\[INFO\]\[Server\] Server listening on/.test(line))).toBe(true);
        expect(stdout.some(line => /\[INFO\]\[console\] from app \{ a: 1 \}$/.test(line))).toBe(true);
        expect(result.stdout).not.toContain("getCallerService");
        for (const line of stdout.filter(line => line.startsWith("["))) {
            expect(line.match(/\[\d{4}-\d{2}-\d{2}T/g)).toHaveLength(1);
        }

        expect(result.stderr).toMatch(/\[ERROR\]\[console\] app failure/);
        expect(result.stderr).toContain("Error: kaput");
        expect(result.stdout).not.toContain("app failure");
    });
});
