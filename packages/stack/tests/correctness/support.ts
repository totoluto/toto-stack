import {vi} from "vitest";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {stripVTControlCharacters} from "node:util";
import {configureLogger} from "@server/libs/Logger";

export const packageRoot = path.resolve(__dirname, "../..");

/**
 * Captures what the Logger writes in pretty mode (it writes to the process
 * streams directly). Strips ANSI colours. Call `restore()` when done.
 */
export function captureLogs(level: "debug" | "info" | "warn" | "error" = "debug") {
    configureLogger({format: "pretty", level});
    const stdout: string[] = [];
    const stderr: string[] = [];
    const strip = (chunk: unknown) => stripVTControlCharacters(String(chunk));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
        stdout.push(strip(chunk));
        return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
        stderr.push(strip(chunk));
        return true;
    });

    return {
        stdout,
        stderr,
        all: () => [...stdout, ...stderr].join(""),
        restore() {
            out.mockRestore();
            err.mockRestore();
            configureLogger(undefined);
        },
    };
}

/** Runs an ES module snippet in a child node process from the package root (imports resolve to dist/). */
export function runNode(code: string, env: Record<string, string | undefined> = {}) {
    if (!fs.existsSync(path.join(packageRoot, "dist/index.js"))) {
        throw new Error("dist/ is missing: run `npm run build:stack` before these tests.");
    }

    const merged: Record<string, string | undefined> = {...process.env, NODE_ENV: undefined, LOG_LEVEL: undefined, FORCE_COLOR: "0", ...env};
    const childEnv = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 20_000,
        env: childEnv,
    });
    if (result.error) throw result.error;
    return result;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
