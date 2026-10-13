#!/usr/bin/env node
// create-toto-app: scaffold a new toto-stack app. Zero dependencies by design.
import {randomBytes} from "node:crypto";
import {execFileSync} from "node:child_process";
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {parseArgs} from "node:util";

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(PACKAGE_DIR, "template");
const OWN_PACKAGE = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));

const USAGE = `Usage: npm create toto-app@latest <directory> [-- options]
       npx create-toto-app <directory> [options]

Creates a new toto-stack app in <directory> (a valid npm package name),
or in the current directory when <directory> is "." (it must be empty).

Options:
  --git          Initialize a git repository in the new app
  --no-git       Do not initialize a git repository (default)
  -h, --help     Show this help
  -v, --version  Show the create-toto-app version
`;

/** Expected, user-facing failure: printed without a stack trace. */
export class CliError extends Error {}

// --- naming ---

/**
 * Validates an app/package name against npm's rules (a strict subset: no
 * scopes, URL-safe characters only). Returns an error message or null.
 */
export function validateAppName(name) {
    if (!name) return "The app name must not be empty.";
    if (name.length > 214) return "The app name must be at most 214 characters.";
    if (name !== name.trim()) return "The app name must not start or end with spaces.";
    if (/[/\\]/.test(name)) return "The app name must not contain path separators; pass a plain name (or \".\").";
    if (name.startsWith(".") || name.startsWith("_")) return "The app name must not start with \".\" or \"_\".";
    if (name !== name.toLowerCase()) return "The app name must be lowercase.";
    if (name === "node_modules" || name === "favicon.ico") return `"${name}" is not allowed as an app name.`;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        return "The app name may only contain lowercase letters, digits, \"-\", \"_\" and \".\", and must start with a letter or digit.";
    }
    return null;
}

/** Best-effort conversion of a directory name into a valid package name. */
export function toPackageName(dirName) {
    return dirName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[._-]+/, "")
        .replace(/-+$/, "")
        .slice(0, 214);
}

// --- package manager ---

const PACKAGE_MANAGERS = {
    npm: {install: "npm install", run: (script) => `npm run ${script}`},
    pnpm: {install: "pnpm install", run: (script) => `pnpm ${script}`},
    yarn: {install: "yarn", run: (script) => `yarn ${script}`},
    bun: {install: "bun install", run: (script) => `bun run ${script}`},
};

/** Detects the package manager that invoked us (npm_config_user_agent). */
export function detectPackageManager(userAgent = "") {
    const name = userAgent.split(" ")[0]?.split("/")[0];
    return Object.hasOwn(PACKAGE_MANAGERS, name) ? name : "npm";
}

// --- copy ---
// Never copied, at any depth.
const SKIP_NAMES = new Set(["node_modules", ".DS_Store"]);
// Local state/build output; only skipped at these exact template paths.
const SKIP_PATHS = new Set(["dist", "logs", "coverage", "server/public", "server/data", "prisma/client"]);

/** Decides whether a template path (relative, any separator) is scaffolded. */
export function shouldCopy(relativePath) {
    if (!relativePath) return true;
    const rel = relativePath.split(path.sep).join("/");
    const segments = rel.split("/");
    const base = segments.at(-1);

    if (segments.some((segment) => SKIP_NAMES.has(segment))) return false;
    if (SKIP_PATHS.has(rel)) return false;
    if (base === ".env" || base.startsWith(".env.")) return false;
    if (base.endsWith(".tsbuildinfo")) return false;
    return true;
}

/** Copies the template into targetDir; returns the copied shell scripts. */
export function copyTemplate(templateDir, targetDir) {
    const scripts = [];
    cpSync(templateDir, targetDir, {
        recursive: true,
        filter: (src) => {
            const rel = path.relative(templateDir, src);
            if (!shouldCopy(rel)) return false;
            if (rel.endsWith(".sh")) scripts.push(path.join(targetDir, rel));
            return true;
        },
    });
    return scripts;
}

// -- app files ---

/**
 * Fills sample.env's secrets with random values for a ready-to-run .env.
 * Keys that sample.env only documents (commented out) are enabled too.
 */
export function createEnvFile(sampleEnv) {
    const secrets = {
        SESSION_SECRET: randomBytes(48).toString("base64"),
        SETUP_TOKEN: randomBytes(24).toString("base64url"),
        OTP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        MYSQL_PASSWORD: randomBytes(24).toString("hex"),
        MYSQL_ROOT_PASSWORD: randomBytes(24).toString("hex"),
    };

    const keys = Object.keys(secrets).join("|");
    return sampleEnv.replace(new RegExp(`^(?:#\\s*)?(${keys})=.*$`, "gm"), (_line, key) => `${key}="${secrets[key]}"`);
}

function personalizePackageJson(pkgPath, appName) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.name = appName;
    // Templates ship in lockstep with toto-stack: depend on the matching release line.
    if (pkg.dependencies?.["toto-stack"]) {
        pkg.dependencies["toto-stack"] = `^${OWN_PACKAGE.version}`;
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function initGit(targetDir) {
    try {
        execFileSync("git", ["init", "--quiet"], {cwd: targetDir, stdio: "ignore"});
        return true;
    } catch {
        return false;
    }
}

// --- main ---

function colors(stream, env) {
    const enabled = Boolean(stream?.isTTY) && !env.NO_COLOR && (typeof stream.hasColors !== "function" || stream.hasColors());
    const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
    return {red: wrap(31), green: wrap(32), cyan: wrap(36), bold: wrap(1), dim: wrap(2)};
}

/** Entries that may already exist in a directory we scaffold into. */
const IGNORABLE_EXISTING = new Set([".git", ".DS_Store", "Thumbs.db"]);

function prepareTarget(targetDir, label) {
    if (!existsSync(targetDir)) {
        mkdirSync(targetDir, {recursive: true});
        return {created: true};
    }

    if (!statSync(targetDir).isDirectory()) {
        throw new CliError(`"${label}" already exists and is not a directory.`);
    }

    const existing = readdirSync(targetDir).filter((entry) => !IGNORABLE_EXISTING.has(entry));
    if (existing.length > 0) {
        throw new CliError(`Directory "${label}" is not empty. Choose a new name or empty it first.`);
    }
    return {created: false};
}

function cleanupTarget(targetDir, created) {
    try {
        if (created) {
            rmSync(targetDir, {recursive: true, force: true});
            return;
        }
        for (const entry of readdirSync(targetDir)) {
            if (!IGNORABLE_EXISTING.has(entry)) rmSync(path.join(targetDir, entry), {recursive: true, force: true});
        }
    } catch {
        // best effort
    }
}

function nextSteps({appName, dirArg, packageManager, gitInitialized}) {
    const pm = PACKAGE_MANAGERS[packageManager];
    const steps = [
        ...(dirArg === "." ? [] : [[`cd ${dirArg}`, ""]]),
        [pm.install, "installs deps and generates the Prisma client"],
        ["docker compose up -d --wait db", "local MariaDB (or point .env at your own)"],
        [pm.run("db:deploy"), "applies the database migrations"],
        [pm.run("dev"), "client on :3000, API on :3001"],
    ];
    const width = Math.max(...steps.map(([command]) => command.length)) + 2;
    const lines = steps.map(([command, comment]) => `  ${comment ? command.padEnd(width) + "# " + comment : command}`);

    const notes = [
        ".env was generated with random secrets (see sample.env for all options).",
        "Open http://localhost:3000/login and create the owner account with the SETUP_TOKEN from .env.",
        "Keep OTP_ENCRYPTION_KEY stable and backed up: changing it breaks MFA sign-in.",
    ];
    if (packageManager === "pnpm") {
        notes.push("pnpm: if it skipped dependency build scripts (prisma, esbuild), run `pnpm approve-builds`.");
    }
    if (packageManager !== "npm") {
        notes.push("The Dockerfile installs with npm: commit a package-lock.json (`npm install`) for reproducible images.");
    }
    if (gitInitialized === false) {
        notes.push("git init failed (is git installed?); the app was created without a repository.");
    }
    return {title: `Created ${appName}`, lines, notes};
}

/**
 * Runs the CLI. Returns the process exit code. All I/O dependencies are
 * injectable for tests.
 */
export function main({
    argv = process.argv.slice(2),
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    templateDir = TEMPLATE_DIR,
} = {}) {
    const out = colors(stdout, env);
    const err = colors(stderr, env);
    const fail = (message) => {
        stderr.write(`${err.red(`✖ ${message}`)}\n`);
        return 1;
    };

    let args;
    try {
        args = parseArgs({
            args: argv,
            allowPositionals: true,
            allowNegative: true,
            options: {
                git: {type: "boolean", default: false},
                help: {type: "boolean", short: "h"},
                version: {type: "boolean", short: "v"},
            },
        });
    } catch (e) {
        return fail(`${e.message}\nRun "create-toto-app --help" for usage.`);
    }

    if (args.values.help) {
        stdout.write(USAGE);
        return 0;
    }
    if (args.values.version) {
        stdout.write(`${OWN_PACKAGE.version}\n`);
        return 0;
    }
    if (args.positionals.length !== 1) {
        const code = fail(args.positionals.length === 0 ? "Missing <directory> argument." : `Expected one <directory>, got ${args.positionals.length}: ${args.positionals.join(" ")}`);
        stderr.write(`\n${USAGE}`);
        return code;
    }

    const dirArg = args.positionals[0];
    const inPlace = dirArg === ".";
    const targetDir = inPlace ? cwd : path.resolve(cwd, dirArg);
    const appName = inPlace ? toPackageName(path.basename(targetDir)) : dirArg;
    const nameError = validateAppName(appName);
    if (nameError) {
        return fail(inPlace
            ? `The current directory name "${path.basename(targetDir)}" can't be turned into a valid package name: ${nameError}`
            : `Invalid app name "${dirArg}". ${nameError}`);
    }

    let target;
    try {
        target = prepareTarget(targetDir, inPlace ? "." : dirArg);
    } catch (e) {
        return fail(e instanceof CliError ? e.message : `Could not create "${dirArg}": ${e.message}`);
    }

    stdout.write(`\nScaffolding ${out.bold(appName)} in ${targetDir}...\n`);

    let gitInitialized;
    try {
        const scripts = copyTemplate(templateDir, targetDir);
        // npm drops the executable bit when packing; restore it.
        for (const script of scripts) chmodSync(script, 0o755);

        // gitignore is stored without the dot because npm strips .gitignore files on publish
        const gitignore = path.join(targetDir, "gitignore");
        if (existsSync(gitignore)) renameSync(gitignore, path.join(targetDir, ".gitignore"));

        const sampleEnv = path.join(targetDir, "sample.env");
        if (existsSync(sampleEnv)) {
            writeFileSync(path.join(targetDir, ".env"), createEnvFile(readFileSync(sampleEnv, "utf8")), {mode: 0o600});
        }

        personalizePackageJson(path.join(targetDir, "package.json"), appName);

        if (args.values.git) gitInitialized = initGit(targetDir);
    } catch (e) {
        cleanupTarget(targetDir, target.created);
        return fail(`Scaffolding failed (the partially created files were removed): ${e.message}`);
    }

    const summary = nextSteps({appName, dirArg, packageManager: detectPackageManager(env.npm_config_user_agent), gitInitialized});
    stdout.write(`\n${out.green(`✔ ${summary.title}`)}\n\nNext steps:\n${summary.lines.map(out.cyan).join("\n")}\n\n${summary.notes.map((note) => out.dim(note)).join("\n")}\n\n`);
    return 0;
}

function isEntrypoint() {
    if (!process.argv[1]) return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
        return false;
    }
}

if (isEntrypoint()) {
    process.exitCode = main();
}
