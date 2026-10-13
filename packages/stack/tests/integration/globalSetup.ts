/**
 * Prepares the MariaDB integration suite (npm run test:integration):
 *
 * 1. Reads TOTO_TEST_DATABASE_URL (mysql://user:pass@host:port/<name containing "test">).
 *    Without it, or when the server is unreachable, the suite is skipped with
 *    a message; TOTO_TEST_DB_REQUIRED=1 turns that into a failure (CI).
 * 2. Drops and recreates that database (it must be disposable).
 * 3. Generates the Prisma 7 client from the template's real schema into
 *    node_modules/.cache/toto-integration, and applies the template's real
 *    migrations with `prisma migrate deploy`.
 */
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import type {TestProject} from "vitest/node";
import type {IntegrationDb} from "./env";

const here = path.dirname(fileURLToPath(import.meta.url));
const stackDir = path.resolve(here, "../..");
const templateDir = path.resolve(stackDir, "../create-toto-app/template");
const workDir = path.join(stackDir, "node_modules/.cache/toto-integration");
const templateRequire = createRequire(path.join(templateDir, "package.json"));

function note(message: string): void {
    process.stderr.write(`\n[integration] ${message}\n\n`);
}

function canConnect(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.connect({host, port});
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}

/** The fixture schema: the template's schema, with the client generated into the cache dir. */
function writeFixture(url: string): string {
    fs.rmSync(workDir, {recursive: true, force: true});
    fs.mkdirSync(workDir, {recursive: true});

    const schema = fs.readFileSync(path.join(templateDir, "prisma/schema.prisma"), "utf8");
    const generator = /generator\s+client\s*\{[^}]*\}/.exec(schema);
    if (!generator || !/output\s*=/.test(generator[0])) {
        throw new Error("The template schema has no `generator client { output = ... }` block.");
    }
    fs.writeFileSync(path.join(workDir, "schema.prisma"), schema.replace(generator[0], generator[0].replace(/output\s*=\s*"[^"]*"/, 'output = "./client"')));
    fs.cpSync(path.join(templateDir, "prisma/migrations"), path.join(workDir, "migrations"), {recursive: true});

    const config = path.join(workDir, "prisma.config.mjs");
    fs.writeFileSync(config, [
        `import {defineConfig} from "prisma/config";`,
        `export default defineConfig({`,
        `    schema: "./schema.prisma",`,
        `    migrations: {path: "./migrations"},`,
        `    datasource: {url: ${JSON.stringify(url)}},`,
        `});`,
        ``,
    ].join("\n"));
    return config;
}

function prisma(args: string[], config: string): void {
    const cli = templateRequire.resolve("prisma/build/index.js");
    execFileSync(process.execPath, [cli, ...args, "--config", config], {cwd: workDir, stdio: ["ignore", "pipe", "inherit"]});
}

async function recreateDatabase(url: URL): Promise<void> {
    // mariadb is the driver behind the template's @prisma/adapter-mariadb.
    const adapterRequire = createRequire(templateRequire.resolve("@prisma/adapter-mariadb"));
    const mariadb = adapterRequire("mariadb") as typeof import("mariadb");
    const name = decodeURIComponent(url.pathname.slice(1));
    const connection = await mariadb.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
    });
    try {
        await connection.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await connection.query(`CREATE DATABASE \`${name}\``);
        const [{version}] = await connection.query("SELECT VERSION() AS version");
        note(`Using MariaDB ${version} at ${url.hostname}:${url.port || 3306}, database \`${name}\` (recreated).`);
    } finally {
        await connection.end();
    }
}

export default async function setup(project: TestProject): Promise<void> {
    const provide = (db: IntegrationDb) => project.provide("integrationDb", db);
    const required = process.env.TOTO_TEST_DB_REQUIRED === "1";
    const skip = (reason: string) => {
        if (required) throw new Error(`[integration] ${reason} (TOTO_TEST_DB_REQUIRED=1)`);
        note(`SKIPPED: ${reason}\nRun MariaDB 11 and set TOTO_TEST_DATABASE_URL, e.g.\n  docker run -d --rm --name toto-mariadb-test -e MARIADB_ROOT_PASSWORD=test -e MARIADB_DATABASE=toto_test -p 127.0.0.1:3307:3306 mariadb:11\n  TOTO_TEST_DATABASE_URL=mysql://root:test@127.0.0.1:3307/toto_test npm run test:integration`);
        provide({available: false, reason});
    };

    const raw = process.env.TOTO_TEST_DATABASE_URL;
    if (!raw) return skip("TOTO_TEST_DATABASE_URL is not set.");

    const url = new URL(raw);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") {
        throw new Error(`[integration] TOTO_TEST_DATABASE_URL must be a mysql:// URL (got ${url.protocol}).`);
    }
    if (!/test/i.test(name)) {
        throw new Error(`[integration] Refusing to use database "${name}": the suite drops and recreates it, so its name must contain "test".`);
    }

    // Retry for a freshly started container.
    const deadline = Date.now() + Number(process.env.TOTO_TEST_DB_WAIT_MS ?? 30_000);
    while (!(await canConnect(url.hostname, Number(url.port || 3306)))) {
        if (Date.now() > deadline) return skip(`MariaDB is not reachable at ${url.hostname}:${url.port || 3306}.`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 15; attempt++) {
        try {
            await recreateDatabase(url);
            lastError = undefined;
            break;
        } catch (err) {
            // The port opens before MariaDB accepts logins.
            lastError = err;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    if (lastError) throw lastError;

    const prismaUrl = new URL(raw);
    prismaUrl.protocol = "mysql:";
    const config = writeFixture(prismaUrl.toString());
    prisma(["generate"], config);
    prisma(["migrate", "deploy"], config);
    note("Generated the Prisma client from the template schema and applied its migrations (prisma migrate deploy).");

    provide({available: true, url: prismaUrl.toString(), clientPath: path.join(workDir, "client/client.ts")});
}
