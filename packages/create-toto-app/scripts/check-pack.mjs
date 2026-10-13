#!/usr/bin/env node
// prepack guard: refuse to pack/publish if the tarball would contain local
// secrets or build artifacts from a dev checkout of the template (C4).
// Zero dependencies: asks npm itself for the exact file list it would pack.
import {execFileSync} from "node:child_process";
import {existsSync, realpathSync} from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Path prefixes (relative to the package root) that must never be packed.
const FORBIDDEN_DIRS = [
    "template/node_modules/",
    "template/dist/",
    "template/server/public/",
    "template/server/data/",
    "template/prisma/client/",
    "template/logs/",
    "template/coverage/",
];

// Basename rules that apply at any depth.
const FORBIDDEN_NAMES = [
    {test: (name) => name === ".env" || name.startsWith(".env."), why: "env file"},
    {test: (name) => name.endsWith(".tsbuildinfo"), why: "TypeScript build info"},
    {test: (name) => name === ".DS_Store", why: "macOS metadata"},
    {test: (name) => name === ".npmrc", why: "npm config (may hold tokens)"},
    {test: (name) => name.endsWith(".tgz"), why: "packed tarball"},
];

// Files the scaffolder needs; their absence means the `files` list is broken.
const REQUIRED = [
    "index.js",
    "package.json",
    "template/package.json",
    "template/sample.env",
    "template/gitignore",
    "template/.dockerignore",
    "LICENSE",
    "README.md",
];

/**
 * How to run npm. Always npm, whatever package manager started this script:
 * pnpm/yarn have different `pack --json` output (or none). Prefers the
 * running npm (npm_execpath), then the npm bundled with this Node, then
 * `npm` from PATH.
 */
export function resolveNpm(env = process.env, execPath = process.execPath, platform = process.platform) {
    const candidates = [];
    if (env.npm_execpath && path.basename(env.npm_execpath) === "npm-cli.js") candidates.push(env.npm_execpath);
    const nodeDir = path.dirname(execPath);
    candidates.push(
        platform === "win32"
            ? path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
            : path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );

    const cli = candidates.find((candidate) => existsSync(candidate));

    if (cli) {
        return {command: execPath, args: [cli], shell: false};
    }

    return platform === "win32" ? {command: "npm.cmd", args: [], shell: true} : {command: "npm", args: [], shell: false};
}

function npmPackDryRun() {
    const npm = resolveNpm();
    let out;
    try {
        out = execFileSync(npm.command, [...npm.args, "pack", "--dry-run", "--json", "--ignore-scripts"], {
            cwd: pkgDir,
            encoding: "utf8",
            shell: npm.shell,
            stdio: ["ignore", "pipe", "inherit"],
        });
    } catch (err) {
        throw new Error(`could not run \`npm pack --dry-run\` (${[npm.command, ...npm.args].join(" ")}): ${err.message}`);
    }

    let result;
    try {
        [result] = JSON.parse(out);
    } catch {
        // fall through to the shape check
    }

    if (!result || !Array.isArray(result.files)) {
        throw new Error(`unexpected \`npm pack --dry-run --json\` output: ${out.slice(0, 200)}`);
    }

    return result.files.map((file) => file.path.split(path.sep).join("/"));
}

function main() {
    let files;
    try {
        files = npmPackDryRun();
    } catch (err) {
        console.error(`create-toto-app prepack check failed: ${err.message}`);
        process.exit(1);
    }

    const problems = [];
    for (const file of files) {
        const dir = FORBIDDEN_DIRS.find((prefix) => file.startsWith(prefix));
        if (dir) {
            problems.push(`${file} (inside ${dir})`);
            continue;
        }

        const segments = file.split("/");
        if (segments.includes("node_modules")) {
            problems.push(`${file} (node_modules)`);
            continue;
        }

        const rule = FORBIDDEN_NAMES.find((r) => r.test(segments[segments.length - 1]));
        if (rule) problems.push(`${file} (${rule.why})`);
    }

    for (const required of REQUIRED) {
        if (!files.includes(required)) problems.push(`${required} is missing from the package`);
    }

    if (problems.length > 0) {
        console.error("create-toto-app prepack check failed. The tarball would contain forbidden or miss required files:");
        for (const problem of problems) console.error(`  - ${problem}`);
        console.error("Fix the `files` list in package.json or remove the local artifacts.");
        process.exit(1);
    }

    console.log(`create-toto-app prepack check passed (${files.length} files).`);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntrypoint) {
    main();
}
