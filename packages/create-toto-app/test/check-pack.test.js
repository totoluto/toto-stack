import {after, describe, it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {resolveNpm} from "../scripts/check-pack.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(PACKAGE_DIR, "scripts", "check-pack.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "check-pack-test-"));
after(() => rmSync(scratch, {recursive: true, force: true}));

function touch(file) {
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, "");
    return file;
}

describe("resolveNpm", () => {
    it("uses npm_execpath only when it is npm", () => {
        const npmCli = touch(path.join(scratch, "a", "npm", "bin", "npm-cli.js"));
        const execPath = path.join(scratch, "a", "bin", "node");
        assert.deepEqual(resolveNpm({npm_execpath: npmCli}, execPath, "linux"), {command: execPath, args: [npmCli], shell: false});

        const pnpm = touch(path.join(scratch, "a", "pnpm", "bin", "pnpm.cjs"));
        assert.deepEqual(resolveNpm({npm_execpath: pnpm}, execPath, "linux"), {command: "npm", args: [], shell: false});
    });

    it("falls back to the npm bundled with Node (unix and Windows layouts)", () => {
        const unixNode = path.join(scratch, "unix", "bin", "node");
        const unixCli = touch(path.join(scratch, "unix", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
        assert.deepEqual(resolveNpm({npm_execpath: "/x/yarn.js"}, unixNode, "linux").args, [unixCli]);

        const winNode = path.join(scratch, "win", "node.exe");
        const winCli = touch(path.join(scratch, "win", "node_modules", "npm", "bin", "npm-cli.js"));
        assert.deepEqual(resolveNpm({}, winNode, "win32").args, [winCli]);
    });

    it("falls back to npm from PATH", () => {
        assert.deepEqual(resolveNpm({}, path.join(scratch, "none", "node"), "linux"), {command: "npm", args: [], shell: false});
        assert.deepEqual(resolveNpm({}, path.join(scratch, "none", "node.exe"), "win32"), {command: "npm.cmd", args: [], shell: true});
    });
});

describe("check-pack.mjs", () => {
    it("passes for this package even when started by another package manager", () => {
        // A pnpm/yarn-style npm_execpath that would print non-npm output.
        const fakePnpm = path.join(scratch, "pnpm.cjs");
        writeFileSync(fakePnpm, "console.log('not npm'); process.exit(1);\n");
        const result = spawnSync(process.execPath, [SCRIPT], {encoding: "utf8", env: {...process.env, npm_execpath: fakePnpm}});
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /prepack check passed \(\d+ files\)/);
    });
});

describe("package.json files", () => {
    it("excludes nested secrets and artifacts even without the prepack guard (--ignore-scripts)", () => {
        // Copy the package (without local build output) and plant artifacts at any depth.
        const pkg = path.join(scratch, "pkg");
        const localOutput = new Set(["template/dist", "template/server/public", "template/prisma/client"]);
        cpSync(PACKAGE_DIR, pkg, {
            recursive: true,
            filter: (src) => {
                const rel = path.relative(PACKAGE_DIR, src).split(path.sep).join("/");
                return !localOutput.has(rel) && !rel.split("/").includes("node_modules");
            },
        });
        const planted = [
            "template/server/.env", "template/docker/.env.prod", "template/client/.env.local",
            "template/x.tgz", "template/client/y.tgz", "stray.tgz",
            "template/node_modules/a/index.js", "template/client/node_modules/b/index.js",
            "template/dist/server.js", "template/client/dist/a.js",
            "template/coverage/lcov.info", "template/server/coverage/lcov.info",
            "template/client/src/a.tsbuildinfo", "template/client/.DS_Store",
            "template/server/public/index.html", "template/server/data/x.json", "template/prisma/client/client.ts", "template/logs/a.log",
        ];
        for (const file of planted) touch(path.join(pkg, file));

        const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"],
            {cwd: pkg, encoding: "utf8", shell: process.platform === "win32"});
        assert.equal(result.status, 0, result.stderr);
        const files = JSON.parse(result.stdout)[0].files.map((file) => file.path.split(path.sep).join("/"));

        assert.deepEqual(planted.filter((file) => files.includes(file)), []);
        for (const required of ["index.js", "template/package.json", "template/sample.env", "template/gitignore", "template/server/index.ts"]) {
            assert.ok(files.includes(required), required);
        }
    });
});
