#!/usr/bin/env node
// End-to-end test of what a new user gets: packs both packages, scaffolds an
// app with the packed create-toto-app CLI, and builds it against the packed
// toto-stack (C2, C5, H2, H13, H14).
//
//   node scripts/scaffold-e2e.mjs [--no-build] [--keep] [--db-url mysql://...] [--docker [--docker-db <container>]]
//
// Always:
//   - `create-toto-app e2e-app` from the CLI tarball (npm exec), toto-stack
//     dependency stamped with the CLI's version, no local files copied
//   - toto-stack pointed at its tarball; `npm install`
//   - `npm audit --omit=dev --audit-level=high` reports nothing (needs network)
//   - `prisma generate` with no MYSQL_* in the environment and the app's
//     .env moved aside (C5: generating the client needs no database config)
//   - `npm run typecheck`, `npm run build`
// With --db-url or TOTO_TEST_DATABASE_URL (database name must contain "test";
// it is dropped and recreated):
//   - `prisma migrate deploy`, then `NODE_ENV=production node dist/server.js`
//   - /api/health, / and /dashboard answer 200 (the SPA is served)
//   - the template's routes (server/routes) are mounted: /api/status 200,
//     /api/users and /api/notifications/handlers 401
//   - setup refuses a missing or wrong setup token and accepts the right one
//   - SIGTERM ends the process cleanly (exit 0) within 10 s
// With --docker (and a working `docker`): `docker build` of the app's
// `runtime` and `migrate` targets. With --docker-db <MariaDB container> (and
// --db-url credentials for it) the images also run: migrate, then the
// runtime container until its HEALTHCHECK reports healthy, then `docker
// stop` must end it with exit code 0.
//
// Explicitly requested parts never pass as SKIP: --docker/--docker-db FAIL
// when Docker is missing or broken or no DB URL is given, and
// TOTO_TEST_DB_REQUIRED=1 makes a missing DB URL a failure (as in the
// integration suite).
//
// toto-stack is unpublished, so the app depends on `file:vendor/toto-stack.tgz`;
// the Docker build uses Dockerfile.e2e, the app's Dockerfile plus a
// `COPY vendor ./vendor` before each install.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {createRequire} from "node:module";
import {Checks, buildStack, makeTempDir, packPackages, parseArgs, run, start} from "./lib.mjs";

const APP = "e2e-app";
const options = parseArgs(process.argv.slice(2), {flags: ["no-build", "keep", "docker"]});
const VENDORED = "vendor/toto-stack.tgz";
const dockerRequested = Boolean(options.docker || options.dockerDb);
const dbRequired = process.env.TOTO_TEST_DB_REQUIRED === "1";
const dbUrl = options.dbUrl ?? process.env.TOTO_TEST_DATABASE_URL;
const checks = new Checks("Scaffold end-to-end");

async function main() {
    const work = makeTempDir("toto-scaffold");
    const appDir = path.join(work, APP);
    console.log(`Working in ${work}\n`);

    try {
        if (!options.noBuild) {
            await checks.check("build toto-stack", () => buildStack());
        };

        let packed;
        await checks.check("npm pack toto-stack and create-toto-app", () => {
            packed = packPackages(work);
        });

        if (!packed) {
            throw new Error("Nothing to test without tarballs.");
        }

        let scaffolded = false;
        await checks.check(`create-toto-app ${APP} (packed CLI)`, () => {
            const result = run("npm", ["exec", "--yes", `--package=${packed.cli.path}`, "--", "create-toto-app", APP], {cwd: work, env: {NO_COLOR: "1"}});
            if (!result.ok) return result.output();
            if (!fs.existsSync(path.join(appDir, "package.json"))) return `no ${APP}/package.json:\n${result.output()}`;
            scaffolded = true;
            return {detail: lastLines(result.stdout, 1)};
        });

        if (!scaffolded) {
            return checks.summary();
        }

        await checks.check("scaffolded app: dependency stamped, nothing local copied", () => {
            const pkg = readJson(path.join(appDir, "package.json"));
            const problems = [];
            const expected = `^${packed.cli.version}`;
            if (pkg.dependencies?.["toto-stack"] !== expected) problems.push(`toto-stack dependency is ${pkg.dependencies?.["toto-stack"]}, expected ${expected}`);
            for (const local of ["node_modules", "dist", "server/public", "prisma/client"]) {
                if (fs.existsSync(path.join(appDir, local))) problems.push(`${local} was copied into the app`);
            }
            if (!fs.existsSync(path.join(appDir, ".gitignore"))) problems.push(".gitignore is missing");
            return problems.join("\n") || undefined;
        });

        // From here on the app uses the packed toto-stack, like a published release.
        fs.mkdirSync(path.join(appDir, "vendor"));
        fs.copyFileSync(packed.stack.path, path.join(appDir, VENDORED));
        const pkgPath = path.join(appDir, "package.json");
        const pkg = readJson(pkgPath);
        pkg.dependencies["toto-stack"] = `file:${VENDORED}`;
        fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

        // Steps get the test database (if any); otherwise the app's generated .env applies.
        const dbEnv = dbUrl ? mysqlEnv(dbUrl) : {};
        const inApp = (command, args, extra = {}) => run(command, args, {cwd: appDir, env: {...dbEnv, NO_COLOR: "1", ...extra}, unset: dbUrl ? [] : [/^MYSQL_/]});

        let installed = false;
        await checks.check("npm install", () => {
            const result = inApp("npm", ["install", "--no-fund", "--no-audit"]);
            installed = result.ok;
            return result.ok ? {detail: `${Math.round(result.ms / 1000)} s`} : result.output();
        });

        if (!installed) {
            return checks.summary();
        }

        await checks.check("npm audit --omit=dev --audit-level=high reports nothing (H2)", () => {
            const result = inApp("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"]);
            let report;

            try {
                report = JSON.parse(result.stdout);
            } catch {
                return `npm audit output was not JSON:\n${result.output()}`;
            }

            const counts = report.metadata?.vulnerabilities ?? {};
            const summary = Object.entries(counts).filter(([level, n]) => n && level !== "total").map(([level, n]) => `${level}: ${n}`).join(", ") || "0 vulnerabilities";
            const severe = Object.values(report.vulnerabilities ?? {})
                .filter((entry) => entry.severity === "high" || entry.severity === "critical")
                .map((entry) => `${entry.name}@${entry.range} (${entry.severity})`);

            return result.ok ? {detail: summary} : `npm audit failed (${summary}):\n${severe.join("\n")}`;
        });

        await checks.check("prisma generate without MYSQL_* env and without .env (C5)", () => {
            const envFile = path.join(appDir, ".env");
            const aside = path.join(appDir, ".env.e2e-aside");
            const hadEnv = fs.existsSync(envFile);

            if (hadEnv) {
                fs.renameSync(envFile, aside);
            }

            try {
                const result = run("npm", ["exec", "--", "prisma", "generate"], {cwd: appDir, env: {NO_COLOR: "1"}, unset: [/^MYSQL_/, "DATABASE_URL", "SHADOW_DATABASE_URL"]});
                return result.ok ? {detail: hadEnv ? ".env moved aside" : "no .env present"} : result.output();
            } finally {
                if (hadEnv) fs.renameSync(aside, envFile);
            }
        });

        for (const [name, args] of [["npm run typecheck", ["run", "typecheck"]], ["npm run build", ["run", "build"]]]) {
            await checks.check(name, () => {
                const result = inApp("npm", args);
                return result.ok ? undefined : result.output();
            });
        }

        if (dbUrl) {
            await productionBoot(appDir, inApp);
        } else if (dbRequired) {
            checks.fail("migrate deploy + production boot", "TOTO_TEST_DB_REQUIRED=1 but no --db-url / TOTO_TEST_DATABASE_URL");
        } else {
checks.skip("migrate deploy + production boot", "no --db-url / TOTO_TEST_DATABASE_URL")
        }

        if (dockerRequested) {
            await dockerBuild(appDir);
        } else {
            checks.skip("docker build", "pass --docker")
        };
    } catch (err) {
        checks.fail("scaffold e2e aborted", err instanceof Error ? err.stack ?? err.message : String(err));
    } finally {
        if (options.keep) {
            console.log(`\nKept ${work}`);
        } else {
            fs.rmSync(work, {recursive: true, force: true});
        }
    }

    return checks.summary();
}

/* ------------------------------------------------------- production boot */

async function productionBoot(appDir, inApp) {
    let migrated = false;
    await checks.check("recreate the test database and prisma migrate deploy", async () => {
        await recreateDatabase(appDir, dbUrl);
        const result = inApp("npm", ["exec", "--", "prisma", "migrate", "deploy"]);
        migrated = result.ok;
        return result.ok ? {detail: lastLines(result.stdout, 1)} : result.output();
    });
    if (!migrated) return;

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const origin = "https://e2e.example.test";
    const setupToken = crypto.randomBytes(24).toString("base64url");
    const server = start(process.execPath, ["dist/server.js"], {
        cwd: appDir,
        env: {
            ...mysqlEnv(dbUrl),
            NODE_ENV: "production",
            PORT: String(port),
            HOST: "127.0.0.1",
            SESSION_SECRET: crypto.randomBytes(48).toString("base64"),
            ALLOWED_ORIGINS: origin,
            SETUP_TOKEN: setupToken,
            NO_COLOR: "1",
        },
    });

    try {
        let up = false;
        await checks.check("NODE_ENV=production node dist/server.js: /api/health answers 200", async () => {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const exited = await Promise.race([server.exited, sleep(250).then(() => null)]);
                if (exited) return `the server exited (${JSON.stringify(exited)}):\n${lastLines(server.output(), 40)}`;
                const res = await fetch(`${base}/api/health`).catch(() => null);
                if (res?.status === 200) {
                    up = true;
                    return {detail: JSON.stringify(await res.json())};
                }
            }
            return `no 200 from /api/health within 30 s:\n${lastLines(server.output(), 40)}`;
        });
        if (!up) return;

        await checks.check("the SPA is served at / and /dashboard; unknown /api paths are JSON 404s", async () => {
            const problems = [];
            for (const route of ["/", "/dashboard"]) {
                const res = await fetch(`${base}${route}`);
                const type = res.headers.get("content-type") ?? "";
                if (res.status !== 200 || !type.includes("text/html")) problems.push(`${route}: ${res.status} ${type}`);
            }
            const missing = await fetch(`${base}/api/does-not-exist`);
            if (missing.status !== 404 || !(missing.headers.get("content-type") ?? "").includes("json")) problems.push(`/api/does-not-exist: ${missing.status}`);
            return problems.join("\n") || undefined;
        });

        await checks.check("the app's own routes (server/routes) are mounted", async () => {
            const problems = [];
            const status = await fetch(`${base}/api/status`);
            if (status.status !== 200) problems.push(`GET /api/status: ${status.status}`);
            // Admin-only: mounted means 401 UNAUTHORIZED, not 404.
            for (const route of ["/api/users", "/api/notifications/handlers"]) {
                const res = await fetch(`${base}${route}`);
                const body = await res.json().catch(() => null);
                if (res.status !== 401 || body?.code !== "UNAUTHORIZED") problems.push(`GET ${route}: ${res.status} ${JSON.stringify(body)}`);
            }
            return problems.join("\n") || undefined;
        });

        await checks.check("setup requires the setup token", async () => {
            const attempt = async (body) => {
                const csrf = await fetch(`${base}/api/auth/csrf`, {headers: {origin}});
                const cookie = (csrf.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
                const {data} = await csrf.json();
                const res = await fetch(`${base}/api/auth/setup/start`, {
                    method: "POST",
                    headers: {origin, cookie, "content-type": "application/json", "x-csrf-token": data.token},
                    body: JSON.stringify(body),
                });
                return {status: res.status, body: await res.json().catch(() => null)};
            };
            const credentials = {username: "owner", password: "e2e-owner-password-1"};
            const missing = await attempt(credentials);
            const wrong = await attempt({...credentials, setupToken: "wrong-token"});
            const right = await attempt({...credentials, setupToken});
            const problems = [];
            if (missing.status !== 400) problems.push(`without a token: ${missing.status} ${JSON.stringify(missing.body)}`);
            if (wrong.status !== 403) problems.push(`with a wrong token: ${wrong.status} ${JSON.stringify(wrong.body)}`);
            if (right.status !== 200 || !right.body?.data?.key) problems.push(`with SETUP_TOKEN: ${right.status} ${JSON.stringify(right.body)}`);
            return problems.join("\n") || undefined;
        });
    } finally {
        await checks.check("SIGTERM stops the server cleanly within 10 s", async () => {
            if (server.child.exitCode !== null || server.child.signalCode !== null) return `already exited (${server.child.exitCode ?? server.child.signalCode})`;
            server.child.kill("SIGTERM");
            const exited = await Promise.race([server.exited, sleep(10_000).then(() => null)]);
            if (!exited) {
                server.child.kill("SIGKILL");
                return `still running 10 s after SIGTERM:\n${lastLines(server.output(), 20)}`;
            }
            return exited.code === 0 ? undefined : `exit ${JSON.stringify(exited)}:\n${lastLines(server.output(), 20)}`;
        });
    }
}

let mariadbDriver;
async function recreateDatabase(appDir, url) {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.slice(1));
    if (!/test/i.test(name)) throw new Error(`Refusing to recreate database "${name}": its name must contain "test".`);
    // The scaffolded app depends on the MariaDB driver (through @prisma/adapter-mariadb).
    if (appDir) {
        const appRequire = createRequire(path.join(appDir, "package.json"));
        mariadbDriver = createRequire(appRequire.resolve("@prisma/adapter-mariadb"))("mariadb");
    }
    const mariadb = mariadbDriver;
    const connection = await mariadb.createConnection({
        host: parsed.hostname,
        port: Number(parsed.port || 3306),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
    });
    try {
        await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await connection.query(`CREATE DATABASE \`${name}\``);
    } finally {
        await connection.end();
    }
}

function mysqlEnv(url) {
    const parsed = new URL(url);
    return {
        MYSQL_HOST: parsed.hostname,
        MYSQL_PORT: parsed.port || "3306",
        MYSQL_USER: decodeURIComponent(parsed.username),
        MYSQL_PASSWORD: decodeURIComponent(parsed.password),
        MYSQL_DATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    };
}

/* --------------------------------------------------------------- docker */

async function dockerBuild(appDir) {
    // Requested explicitly, so a missing or broken Docker is a failure, never a skip.
    const info = run("docker", ["info", "--format", "{{.ServerVersion}}"], {timeoutMs: 30_000});
    if (!info.ok) return checks.fail("docker available (docker info)", info.output() || String(info.error?.message ?? `exit ${info.status}`));
    if (options.dockerDb && !dbUrl) checks.fail("docker run: migrate + runtime HEALTHCHECK + docker stop", "--docker-db needs --db-url / TOTO_TEST_DATABASE_URL");

    // The real Dockerfile, plus the vendored tarball before each install (unpublished toto-stack).
    const dockerfile = fs.readFileSync(path.join(appDir, "Dockerfile"), "utf8");
    const installCopy = /^COPY package\.json package-lock\.json\* \.\/$/gm;
    if (!installCopy.test(dockerfile)) return checks.fail("docker build", "the Dockerfile has no `COPY package.json package-lock.json* ./` step to hook the vendored tarball into");
    fs.writeFileSync(path.join(appDir, "Dockerfile.e2e"), dockerfile.replace(installCopy, (line) => `${line}\nCOPY vendor ./vendor`));

    const id = crypto.randomBytes(4).toString("hex");
    const images = {runtime: `toto-scaffold-e2e:runtime-${id}`, migrate: `toto-scaffold-e2e:migrate-${id}`};
    const built = {};
    try {
        for (const [target, tag] of Object.entries(images)) {
            await checks.check(`docker build --target ${target}`, () => {
                const result = run("docker", ["build", "-f", "Dockerfile.e2e", "--target", target, "-t", tag, "."], {cwd: appDir, timeoutMs: 20 * 60_000});
                if (!result.ok) return lastLines(result.output(), 40);
                built[target] = true;
                const size = run("docker", ["image", "inspect", tag, "--format", "{{.Size}}"]).stdout.trim();
                return {detail: `${Math.round(result.ms / 1000)} s, ${Math.round(Number(size) / 1e6)} MB`};
            });
        }
        if (built.runtime && built.migrate && options.dockerDb && dbUrl) await dockerRun(images, id);
        else if (!options.dockerDb) checks.skip("docker run: migrate + runtime HEALTHCHECK + docker stop", "pass --docker-db <MariaDB container> and --db-url");
    } finally {
        run("docker", ["rmi", "-f", images.runtime, images.migrate], {timeoutMs: 60_000});
    }
}

/** Runs the migrate and runtime images on a network shared with the MariaDB container. */
async function dockerRun(images, id) {
    const network = `toto-e2e-${id}`;
    const app = `toto-e2e-app-${id}`;
    const env = {
        ...mysqlEnv(dbUrl),
        MYSQL_HOST: options.dockerDb,
        MYSQL_PORT: "3306",
        SESSION_SECRET: crypto.randomBytes(48).toString("base64"),
        ALLOWED_ORIGINS: "https://e2e.example.test",
        SETUP_TOKEN: crypto.randomBytes(24).toString("base64url"),
    };
    const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

    run("docker", ["network", "create", network]);
    run("docker", ["network", "connect", network, options.dockerDb]);
    try {
        await checks.check("docker run migrate image (prisma migrate deploy)", async () => {
            await recreateDatabase(null, dbUrl);
            const result = run("docker", ["run", "--rm", "--network", network, ...envArgs, images.migrate], {timeoutMs: 5 * 60_000});
            return result.ok ? {detail: lastLines(result.stdout, 1)} : result.output();
        });

        let healthy = false;
        await checks.check("runtime container reports healthy (Dockerfile HEALTHCHECK)", async () => {
            const started = run("docker", ["run", "-d", "--name", app, "--network", network, "--health-interval", "2s", "--health-start-period", "5s", ...envArgs, images.runtime]);
            if (!started.ok) return started.output();
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline) {
                const state = run("docker", ["inspect", app, "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}"]).stdout.trim();
                if (state.endsWith("healthy") && !state.endsWith("unhealthy")) {
                    healthy = true;
                    return {detail: state};
                }
                if (!state.startsWith("running")) return `container ${state}:\n${run("docker", ["logs", app]).output()}`;
                await sleep(1000);
            }
            return `not healthy within 90 s:\n${lastLines(run("docker", ["logs", app]).output(), 30)}`;
        });

        if (healthy) {
            await checks.check("docker stop (SIGTERM) ends the runtime container with exit code 0", () => {
                const stopped = run("docker", ["stop", "--time", "15", app], {timeoutMs: 60_000});
                if (!stopped.ok) return stopped.output();
                const exit = run("docker", ["inspect", app, "--format", "{{.State.ExitCode}}"]).stdout.trim();
                return exit === "0" ? undefined : `exit code ${exit}:\n${lastLines(run("docker", ["logs", app]).output(), 20)}`;
            });
        }
    } finally {
        run("docker", ["rm", "-f", app]);
        run("docker", ["network", "disconnect", network, options.dockerDb]);
        run("docker", ["network", "rm", network]);
    }
}

/* -------------------------------------------------------------- helpers */

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function lastLines(text, count) {
    return String(text).trim().split("\n").slice(-count).join("\n");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
            const {port} = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

process.exit(await main());
