import {beforeAll, describe, expect, it} from "vitest";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// These tests exercise the BUILT package: run `npm run build:stack` first (CI does).
const packageRoot = path.resolve(__dirname, "../..");
const fixtureConfig = path.join(packageRoot, "fixtures/consumer/tsconfig.json");

beforeAll(() => {
    if (!fs.existsSync(path.join(packageRoot, "dist"))) {
        throw new Error("dist/ is missing: run `npm run build:stack` before these tests.");
    }
});

const childScript = `
const {createServer} = await import("toto-stack");
const fake = {
    user: {count: async () => 0},
    role: {findMany: async () => [], upsert: async () => ({})},
    session: {},
    $queryRaw: async () => [],
};
const server = createServer({prisma: fake, http: {port: 0, host: "127.0.0.1"}});
await server.createApp();
await server.start();
await server.stop();
console.log("done");
// no process.exit(): the process must end by itself
`;

describe("built package", () => {
    it("has no import-time side effects and leaves no handles after stop()", () => {
        const importOnly = spawnSync(process.execPath, ["--input-type=module", "-e", `await import("toto-stack"); console.log("imported");`], {
            cwd: packageRoot,
            encoding: "utf8",
            timeout: 15_000,
        });
        expect(importOnly.error).toBeUndefined();
        expect(importOnly.signal).toBeNull();
        expect(importOnly.status).toBe(0);
        expect(importOnly.stdout.trim()).toBe("imported");

        const lifecycle = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
            cwd: packageRoot,
            encoding: "utf8",
            timeout: 15_000,
            env: {...process.env, NODE_ENV: "test"},
        });
        expect(lifecycle.error, lifecycle.stderr).toBeUndefined();
        expect(lifecycle.signal, "process had to be killed: something kept it alive").toBeNull();
        expect(lifecycle.status, lifecycle.stderr).toBe(0);
        expect(lifecycle.stdout).toContain("done");
    });

    it("exposes a type contract consumers can extend (CustomServices, Request.user)", () => {
        const parsed = ts.getParsedCommandLineOfConfigFile(fixtureConfig, undefined, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: diagnostic => {
                throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
            },
        });
        const program = ts.createProgram(parsed!.fileNames, parsed!.options);
        const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => {
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
            return diagnostic.file ? `${path.basename(diagnostic.file.fileName)}: ${message}` : message;
        });

        // The fixture must resolve to the built declarations, not the sources
        const resolvedFromDist = program.getSourceFiles().some(file => file.fileName.startsWith(path.join(packageRoot, "dist")));
        expect(resolvedFromDist).toBe(true);
        expect(diagnostics).toEqual([]);
    }, 60_000);
});
