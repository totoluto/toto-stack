// Shared helpers for the release-validation scripts (zero dependencies).
import {spawn, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const isWindows = process.platform === "win32";

const color = (code) => (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = color(32);
export const red = color(31);
export const yellow = color(33);
export const dim = color(2);

/** Parses `--flag`, `--key value`, `--key=value` (repeatable keys collect into arrays). */
export function parseArgs(argv, {multi = [], flags = []} = {}) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
        const [rawKey, inline] = arg.slice(2).split(/=(.*)/s);
        const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (flags.includes(rawKey) && inline === undefined) {
            options[key] = true;
            continue;
        }
        const value = inline ?? argv[++i];
        if (value === undefined) throw new Error(`--${rawKey} needs a value`);
        if (multi.includes(rawKey)) (options[key] ??= []).push(...value.split(",").filter(Boolean));
        else options[key] = value;
    }
    return options;
}

/**
 * Runs a command and captures its output. `npm`/`npx` go through the
 * shell on Windows. `unset` removes inherited variables (matched by name or
 * RegExp). Never throws for a non-zero exit: check `ok`.
 */
export function run(command, args, {cwd = repoRoot, env, unset = [], timeoutMs = 15 * 60_000, input} = {}) {
    const started = Date.now();
    const childEnv = {...process.env, ...env};

    for (const key of Object.keys(childEnv)) {
        if (unset.some((pattern) => (typeof pattern === "string" ? pattern === key : pattern.test(key)))) delete childEnv[key];
    }

    const result = spawnSync(command, args, {
        cwd,
        env: childEnv,
        encoding: "utf8",
        input,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        shell: isWindows && /^(npm|npx)$/.test(command),
        killSignal: "SIGKILL",
    });

    const timedOut = result.error?.code === "ETIMEDOUT";

    return {
        ok: result.status === 0 && !result.error,
        status: result.status,
        signal: result.signal,
        timedOut,
        error: result.error,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ms: Date.now() - started,
        output() {
            return `${this.stdout}${this.stderr}`.trim();
        },
    };
}

/** Like run(), but resolves while the child keeps running; for servers. */
export function start(command, args, {cwd = repoRoot, env} = {}) {
    const child = spawn(command, args, {cwd, env: {...process.env, ...env}, stdio: ["ignore", "pipe", "pipe"]});
    let output = "";

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({code, signal})));

    return {child, exited, output: () => output};
}

/** Collects named checks and prints a summary; exit code 1 when any failed. */
export class Checks {
    constructor(title) {
        this.title = title;
        this.results = [];
    }

    pass(name, detail = "") {
        this.results.push({name, status: "pass", detail});
        console.log(`${green("PASS")} ${name}${detail ? dim(`  ${detail}`) : ""}`);
    }

    fail(name, detail = "") {
        this.results.push({name, status: "fail", detail});
        console.log(`${red("FAIL")} ${name}${detail ? `\n${indent(detail)}` : ""}`);
    }

    skip(name, why) {
        this.results.push({name, status: "skip", detail: why});
        console.log(`${yellow("SKIP")} ${name}${dim(`  ${why}`)}`);
    }

    /** Runs fn; a thrown error or a returned string (the problem) fails the check. */
    async check(name, fn) {
        try {
            const outcome = await fn();
            if (typeof outcome === "string" && outcome) this.fail(name, outcome);
            else this.pass(name, outcome && typeof outcome === "object" ? outcome.detail ?? "" : "");
        } catch (err) {
            this.fail(name, err instanceof Error ? err.message : String(err));
        }
    }

    get failed() {
        return this.results.filter((result) => result.status === "fail");
    }

    summary() {
        const count = (status) => this.results.filter((result) => result.status === status).length;
        console.log(`\n${this.title}: ${green(`${count("pass")} passed`)}, ${count("fail") ? red(`${count("fail")} failed`) : "0 failed"}, ${count("skip")} skipped`);

        for (const result of this.failed) {
            console.log(`  ${red("✘")} ${result.name}`)
        }

        return this.failed.length === 0 ? 0 : 1;
    }
}

export function indent(text, prefix = "    ") {
    return String(text).trim().split("\n").slice(-60).map((line) => prefix + line).join("\n");
}

export function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${prefix}-`));
}

export function writeFiles(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
    }
}

/** Builds the stack (dist/) unless told not to. */
export function buildStack() {
    const result = run("npm", ["run", "build:stack"]);
    if (!result.ok) {
        throw new Error(`npm run build:stack failed:\n${result.output()}`)
    };
}

/**
 * `npm pack` of both published packages into `dest`. Returns
 * {stack, cli} with {name, version, filename, path, files: string[]}.
 */
export function packPackages(dest) {
    const result = run("npm", ["pack", "--json", "--pack-destination", dest, "-w", "toto-stack", "-w", "create-toto-app"]);

    if (!result.ok) {
        throw new Error(`npm pack failed:\n${result.output()}`)
    }

    // Lifecycle scripts (prepack) may print before the JSON array.
    const json = result.stdout.slice(result.stdout.search(/^\[/m));
    const packed = JSON.parse(json).map((entry) => ({
        name: entry.name,
        version: entry.version,
        filename: entry.filename,
        path: path.join(dest, entry.filename),
        files: entry.files.map((file) => file.path),
    }));

    const byName = (name) => {
        const entry = packed.find((candidate) => candidate.name === name);
        if (!entry) throw new Error(`npm pack produced no ${name} tarball`);
        return entry;
    };
    
    return {stack: byName("toto-stack"), cli: byName("create-toto-app")};
}

/** Versions in the root lockfile, to pin consumer projects to what the repo already uses. */
export function lockedVersion(name, fallback) {
    try {
        const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
        return lock.packages?.[`node_modules/${name}`]?.version ?? fallback;
    } catch {
        return fallback;
    }
}
