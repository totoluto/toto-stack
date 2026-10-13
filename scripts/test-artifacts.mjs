#!/usr/bin/env node
// Tests what ships: packs both packages and checks the tarballs from the
// outside, the way npm users get them (H14, C1, C4, H4, H13).
//
//   node scripts/test-artifacts.mjs [--node 22,24,26] [--no-build] [--skip-lint] [--keep]
//
// 1. pack:     `npm pack` of toto-stack and create-toto-app into a temp dir
// 2. contents: required files and LICENSE in both; nothing local or built
//              (.env*, dist, server/public, prisma/client, node_modules)
//              in create-toto-app; no sources/tests in toto-stack
// 3. lint:     publint --strict (both) and attw --profile esm-only (stack)
// 4. consumer: a fresh project installs the toto-stack tarball, then
//              - ESM import and .cjs require (require(esm)) of all three entries
//              - the process exits by itself and process.report is untouched
//              - createApp() runs against a stub client; Argon2id (native
//                prebuild), TOTP and QR codes work
//              - TypeScript (nodenext and bundler, skipLibCheck off, no
//                @types/express) sees req.user and CustomServices
//              - a Vite browser build of /client + /shared has no server code
// 5. --node:   repeats the runtime checks under other Node versions via
//              `npx -y node@<version>` (e.g. --node 22,24,26)
//
// publint/attw/node are fetched with npx at pinned versions; the consumer
// pins the versions in the repo lockfile. Needs network on first run.
import fs from "node:fs";
import path from "node:path";
import {Checks, buildStack, lockedVersion, makeTempDir, packPackages, parseArgs, run, writeFiles} from "./lib.mjs";

const PUBLINT = "publint@0.3.25";
const ATTW = "@arethetypeswrong/cli@0.18.5";

const options = parseArgs(process.argv.slice(2), {multi: ["node"], flags: ["no-build", "skip-lint", "keep"]});
const checks = new Checks("Artifact tests");

async function main() {
    const work = makeTempDir("toto-artifacts");
    console.log(`Working in ${work}\n`);

    try {
        if (!options.noBuild) {
            await checks.check("build toto-stack (npm run build:stack)", () => buildStack());
        }

        let packed;
        await checks.check("npm pack toto-stack and create-toto-app", () => {
            packed = packPackages(work);
            return {detail: `${packed.stack.filename} (${packed.stack.files.length} files), ${packed.cli.filename} (${packed.cli.files.length} files)`};
        });
        if (!packed) throw new Error("Nothing to test without tarballs.");

        await contentChecks(packed);
        if (options.skipLint) checks.skip("publint / attw", "--skip-lint");
        else await lintChecks(packed);

        const consumer = path.join(work, "consumer");
        let installed = false;
        await checks.check("consumer project installs the toto-stack tarball", () => {
            createConsumer(consumer, packed.stack.path);
            const result = run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], {cwd: consumer});
            if (!result.ok) return result.output();
            installed = true;
            return {detail: `${Math.round(result.ms / 1000)} s`};
        });

        if (installed) {
            await runtimeChecks(consumer, {label: `host ${process.version}`, node: [process.execPath]});
            for (const version of options.node ?? []) {
                const node = ["npx", "-y", `node@${version}`];
                const warm = run(node[0], [...node.slice(1), "--version"], {cwd: consumer, timeoutMs: 10 * 60_000});
                if (!warm.ok) {
                    checks.fail(`node@${version} available via npx`, warm.output());
                    continue;
                }
                await runtimeChecks(consumer, {label: `node ${warm.stdout.trim()}`, node});
            }
            await typeChecks(consumer);
            await browserCheck(consumer);
        }
    } catch (err) {
        checks.fail("artifact tests aborted", err instanceof Error ? err.stack ?? err.message : String(err));
    } finally {
        if (options.keep) console.log(`\nKept ${work}`);
        else fs.rmSync(work, {recursive: true, force: true});
    }

    return checks.summary();
}

/* ------------------------------------------------------------ contents */

async function contentChecks({stack, cli}) {
    await checks.check("both tarballs contain LICENSE", () => {
        const missing = [stack, cli].filter((pkg) => !pkg.files.includes("LICENSE")).map((pkg) => pkg.filename);
        return missing.length ? `LICENSE missing from ${missing.join(", ")}` : undefined;
    });

    await checks.check("toto-stack tarball has its entry points and no sources", () => {
        const required = ["package.json", "README.md", "prisma/base.prisma", ...["index", "client", "shared"].flatMap((entry) => [`dist/${entry}.js`, `dist/${entry}.d.ts`])];
        const missing = required.filter((file) => !stack.files.includes(file));
        const forbidden = stack.files.filter((file) => /^(src|tests|fixtures|coverage|node_modules)\//.test(file) || isLocalFile(file));
        return [
            missing.length ? `missing: ${missing.join(", ")}` : "",
            forbidden.length ? `must not ship: ${forbidden.join(", ")}` : "",
        ].filter(Boolean).join("\n") || undefined;
    });

    await checks.check("create-toto-app tarball has no local secrets or build artifacts (C4)", () => {
        const forbidden = cli.files.filter((file) =>
            isLocalFile(file)
            || /(^|\/)node_modules\//.test(file)
            || /^template\/(dist|server\/public|prisma\/client)\//.test(file));
        const missing = ["index.js", "package.json", "template/package.json", "template/sample.env"].filter((file) => !cli.files.includes(file));
        return [
            forbidden.length ? `must not ship: ${forbidden.join(", ")}` : "",
            missing.length ? `missing: ${missing.join(", ")}` : "",
        ].filter(Boolean).join("\n") || undefined;
    });
}

/** .env, .env.* (but not sample.env), tarballs, npmrc, tsbuildinfo at any depth. */
function isLocalFile(file) {
    const base = path.posix.basename(file);
    return base === ".env" || base.startsWith(".env.") || base === ".npmrc" || base.endsWith(".tgz") || base.endsWith(".tsbuildinfo");
}

/* ---------------------------------------------------------------- lint */

async function lintChecks({stack}) {
    for (const dir of ["packages/stack", "packages/create-toto-app"]) {
        await checks.check(`publint --strict ${dir}`, () => {
            const result = run("npx", ["-y", PUBLINT, "--strict", dir]);
            return result.ok ? {detail: lastLine(result.stdout)} : result.output();
        });
    }
    await checks.check("attw --profile esm-only (toto-stack tarball)", () => {
        const result = run("npx", ["-y", ATTW, stack.path, "--profile", "esm-only", "--exclude-entrypoints", "./prisma/base.prisma", "--format", "table-flipped"]);
        return result.ok ? undefined : result.output();
    });
}

const lastLine = (text) => text.trim().split("\n").at(-1) ?? "";

/* ------------------------------------------------------------ consumer */

function createConsumer(dir, stackTarball) {
    const reactVersion = lockedVersion("react", "19.1.0");
    writeFiles(dir, {
        "package.json": {
            name: "toto-artifact-consumer",
            private: true,
            type: "module",
            dependencies: {
                "toto-stack": `file:${stackTarball}`,
                react: reactVersion,
                "react-dom": lockedVersion("react-dom", reactVersion),
                "react-router": lockedVersion("react-router", "7.18.3"),
            },
            // Deliberately no @types/express: the package's types must be self-sufficient.
            devDependencies: {
                typescript: lockedVersion("typescript", "5.8.3"),
                vite: lockedVersion("vite", "7.3.6"),
                "@types/react": lockedVersion("@types/react", "19.1.4"),
            },
        },
        "smoke-esm.mjs": SMOKE_ESM,
        "smoke-cjs.cjs": SMOKE_CJS,
        "consumer.ts": CONSUMER_TS,
        "tsconfig.nodenext.json": tsconfig({module: "nodenext", moduleResolution: "nodenext"}),
        "tsconfig.bundler.json": tsconfig({module: "preserve", moduleResolution: "bundler"}),
        "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="./browser-entry.js"></script></body></html>\n`,
        "browser-entry.js": BROWSER_ENTRY,
        "build-browser.mjs": BUILD_BROWSER,
    });
}

function tsconfig(resolution) {
    return {
        compilerOptions: {
            ...resolution,
            target: "es2022",
            lib: ["es2022", "dom"],
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            jsx: "react-jsx",
        },
        files: ["consumer.ts"],
    };
}

async function runtimeChecks(dir, {label, node}) {
    const [command, ...prefix] = node;
    const exec = (file) => run(command, [...prefix, file], {cwd: dir, env: {NODE_ENV: "test"}, timeoutMs: 30_000});

    await checks.check(`[${label}] ESM import of all entries; exits by itself; process.report untouched`, () => {
        const result = exec("smoke-esm.mjs");
        if (result.timedOut) return `the process did not exit within 30 s (open handles after import?)\n${result.output()}`;
        if (!result.ok) return result.output();
        if (!result.stdout.includes("smoke-esm ok")) return `unexpected output:\n${result.output()}`;
        return {detail: lastLine(result.stdout)};
    });
    await checks.check(`[${label}] require() of all entries from .cjs (require(esm))`, () => {
        const result = exec("smoke-cjs.cjs");
        if (result.timedOut) return `the process did not exit within 30 s\n${result.output()}`;
        if (!result.ok) return result.output();
        return result.stdout.includes("smoke-cjs ok") ? {detail: lastLine(result.stdout)} : `unexpected output:\n${result.output()}`;
    });
}

async function typeChecks(dir) {
    const tsc = path.join(dir, "node_modules/typescript/bin/tsc");
    for (const mode of ["nodenext", "bundler"]) {
        await checks.check(`TypeScript consumer (${mode}, skipLibCheck: false, no @types/express)`, () => {
            if (fs.existsSync(path.join(dir, "node_modules/@types/express")) && !isTransitive(dir, "@types/express")) {
                return "@types/express is a direct dependency of the consumer";
            }
            const result = run(process.execPath, [tsc, "-p", `tsconfig.${mode}.json`], {cwd: dir});
            return result.ok ? undefined : result.output();
        });
    }
}

function isTransitive(dir, name) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return !pkg.dependencies?.[name] && !pkg.devDependencies?.[name];
}

async function browserCheck(dir) {
    await checks.check("Vite browser build of toto-stack/client + /shared contains no server code", () => {
        const result = run(process.execPath, ["build-browser.mjs"], {cwd: dir});
        if (!result.ok) return result.output();
        const line = result.stdout.split("\n").find((text) => text.startsWith("@@report "));
        if (!line) return `no report from the build:\n${result.output()}`;
        const report = JSON.parse(line.slice("@@report ".length));
        const serverModule = /node_modules\/(express|express-session|helmet|pino|nodemailer|node-cron|qrcode|@node-rs\/argon2|@otplib\/[a-z-]+|chalk)\/|__vite-browser-external|^node:|toto-stack\/dist\/index\.js$/;
        const offenders = report.modules.filter((id) => serverModule.test(id.replaceAll("\\", "/")));
        const textHits = report.textHits;
        if (offenders.length || textHits.length || report.externals.length) {
            return [
                offenders.length ? `server modules in the bundle:\n${offenders.join("\n")}` : "",
                textHits.length ? `server references in the output: ${textHits.join(", ")}` : "",
                report.externals.length ? `unresolved imports: ${report.externals.join(", ")}` : "",
            ].filter(Boolean).join("\n");
        }
        const own = report.modules.filter((id) => id.includes("toto-stack/dist/")).map((id) => path.basename(id));
        return {detail: `${report.modules.length} modules; toto-stack files: ${own.join(", ")}`};
    });
}

/* ------------------------------------------------------- fixture files */

const STUB_PRISMA = `{
    user: {count: async () => 0},
    role: {findMany: async () => [], upsert: async () => ({})},
    session: {},
    setupLock: {},
    $queryRaw: async () => [{1: 1}],
    $transaction: async (fn) => fn({}),
}`;

const REPORT_SNAPSHOT = `() => {
    const keys = ["compact", "directory", "filename", "reportOnFatalError", "reportOnSignal", "reportOnUncaughtException", "signal", "excludeNetwork", "excludeEnv"];
    return JSON.stringify(Object.fromEntries(keys.filter((key) => key in process.report).map((key) => [key, process.report[key]])));
}`;

const SMOKE_ESM = `import assert from "node:assert/strict";
const snapshot = ${REPORT_SNAPSHOT};
const before = snapshot();

const server = await import("toto-stack");
const client = await import("toto-stack/client");
const shared = await import("toto-stack/shared");
const {default: pkg} = await import("toto-stack/package.json", {with: {type: "json"}});

assert.equal(snapshot(), before, "importing toto-stack changed process.report settings");
assert.equal(typeof server.createServer, "function");
assert.equal(typeof server.BaseRoute, "function");
assert.equal(typeof server.AppError, "function");
assert.equal(typeof client.apiFetch, "function");
assert.equal(typeof client.UserProvider, "function");
assert.equal(typeof client.NavLinkRole, "function");
assert.equal(shared.Role.OWNER, "owner");
assert.equal(server.Role, shared.Role, "Role differs between toto-stack and toto-stack/shared");
assert.equal(client.Role, shared.Role, "Role differs between toto-stack/client and toto-stack/shared");
assert.equal(typeof shared.ErrorCode, "object", "toto-stack/shared exports no ErrorCode");
assert.equal(server.ErrorCode, shared.ErrorCode, "ErrorCode differs between toto-stack and toto-stack/shared");
assert.equal(client.ErrorCode, shared.ErrorCode, "ErrorCode differs between toto-stack/client and toto-stack/shared");

// Loads the whole runtime dependency graph (express, session, helmet, ...).
const stack = server.createServer({prisma: ${STUB_PRISMA}, logger: {patchConsole: false}});
const app = await stack.createApp();
assert.equal(typeof app.listen, "function");
assert.equal(snapshot(), before, "createApp() changed process.report settings");

// Security primitives from the installed dependencies (native @node-rs/argon2 prebuild, otplib, qrcode)
const {userService, mfaService} = stack.dependencies;
const hash = await userService.hashPassword("artifact-password-1");
assert.match(hash, /^\\$argon2id\\$v=19\\$m=19456,t=2,p=1\\$/, "Argon2id hash");
assert.equal(await userService.verifyPassword({id: 1, password: hash}, "artifact-password-1"), true);
assert.equal(await userService.verifyPassword({id: 1, password: hash}, "wrong-password-1"), false);

const {createHmac} = await import("node:crypto");
const totp = (secret) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bits = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
    const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const mac = createHmac("sha1", key).update(counter).digest();
    const offset = mac[19] & 15;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};
const mfa = await mfaService.generate("artifact-user");
assert.match(mfa.uri, /^otpauth:\\/\\/totp\\//);
assert.match(mfa.qrCode, /^data:image\\/png;base64,/);
const step = mfaService.verify(totp(mfa.secret), mfa.secret);
assert.equal(typeof step, "number", "TOTP verify");
assert.equal(mfaService.verify(totp(mfa.secret), mfa.secret, step), null, "TOTP replay rejected");

console.log(\`smoke-esm ok: toto-stack@\${pkg.version} on \${process.version}\`);
// No process.exit(): the process must end by itself.
`;

const SMOKE_CJS = `const assert = require("node:assert/strict");
const server = require("toto-stack");
const client = require("toto-stack/client");
const shared = require("toto-stack/shared");
const pkg = require("toto-stack/package.json");

assert.equal(typeof server.createServer, "function");
assert.equal(typeof client.apiFetch, "function");
assert.equal(server.Role, shared.Role);
assert.equal(client.Role, shared.Role);
console.log(\`smoke-cjs ok: toto-stack@\${pkg.version} on \${process.version}\`);
`;

const CONSUMER_TS = `// Compiled by the artifact tests against the installed tarball.
import type {SessionData} from "express-session";
import {BaseRoute, createServer, Role} from "toto-stack";
import type {Dependencies, Request, Response, StackConfig} from "toto-stack";
import {apiFetch, NavLinkRole, UserProvider, type UserContextType} from "toto-stack/client";
import {hasAnyRole, Role as SharedRole, type SessionUserType} from "toto-stack/shared";

class Greeter {
    greet(name: string): string {
        return \`hi \${name}\`;
    }
}

declare module "toto-stack" {
    interface CustomServices {
        greeter: Greeter;
    }
}

export class HelloRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/hello", dependencies, {roles: [Role.ADMIN, "editor"]});
    }

    protected registerRoutes(): void {
        this.get("/", (req: Request, res: Response) => {
            const user: SessionUserType | undefined = req.user;
            const id: number | undefined = req.user?.id;
            // @ts-expect-error req.user may be undefined (it is typed, not any)
            const unchecked: number = req.user.id;
            // @ts-expect-error unknown properties are errors
            void req.user?.notAField;
            res.json({message: this.dependencies.greeter.greet("x"), id, user, unchecked});
        });
    }
}

// @ts-expect-error unknown dependencies are still errors
export const missing = (dependencies: Dependencies) => dependencies.notAService;

declare const prisma: StackConfig["prisma"];
createServer({prisma, routes: [HelloRoute], services: () => ({greeter: new Greeter()})});
// @ts-expect-error the services factory must return the augmented CustomServices
createServer({prisma, services: () => ({})});

export const token: SessionData["csrfToken"] = "token";
export const sameRole: typeof Role = SharedRole;
export const allowed: boolean = hasAnyRole([Role.OWNER], [SharedRole.ADMIN]);
export const client = {apiFetch, NavLinkRole, UserProvider};
export type Context = UserContextType;
`;

const BROWSER_ENTRY = `import * as client from "toto-stack/client";
import * as shared from "toto-stack/shared";
// Namespace imports keep every export, so nothing is tree-shaken away.
globalThis.__toto = {client, shared};
`;

const BUILD_BROWSER = `import fs from "node:fs";
import path from "node:path";
import {build} from "vite";

const modules = new Set();
const externals = new Set();
await build({
    configFile: false,
    logLevel: "error",
    build: {outDir: "dist-browser", emptyOutDir: true, minify: false},
    plugins: [{
        name: "collect-modules",
        generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== "chunk") continue;
                for (const id of chunk.moduleIds) modules.add(id);
                for (const imported of chunk.imports) if (!bundle[imported]) externals.add(imported);
            }
        },
    }],
});

const text = fs.readdirSync("dist-browser/assets").filter((file) => file.endsWith(".js"))
    .map((file) => fs.readFileSync(path.join("dist-browser/assets", file), "utf8")).join("\\n");
const textHits = ["from \\"node:", "require(\\"node:", "require(\\"express", "process.report", "nodemailer"].filter((needle) => text.includes(needle));
console.log("@@report " + JSON.stringify({modules: [...modules], externals: [...externals], textHits}));
`;

process.exit(await main());
