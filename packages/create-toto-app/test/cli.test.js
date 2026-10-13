import {after, describe, it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
    TEMPLATE_DIR,
    createEnvFile,
    detectPackageManager,
    main,
    shouldCopy,
    toPackageName,
    validateAppName,
} from "../index.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PACKAGE_DIR, "index.js");
const OWN_VERSION = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")).version;
const isWindows = process.platform === "win32";

const scratch = mkdtempSync(path.join(tmpdir(), "create-toto-app-test-"));
after(() => rmSync(scratch, {recursive: true, force: true}));

let counter = 0;
function tempDir() {
    const dir = path.join(scratch, `case-${++counter}`);
    mkdirSync(dir, {recursive: true});
    return dir;
}

function stream({isTTY = false, colors = true} = {}) {
    return {
        isTTY,
        output: "",
        hasColors: () => colors,
        write(chunk) {
            this.output += chunk;
            return true;
        },
    };
}

function run(argv, {cwd = tempDir(), env = {}, templateDir, stdoutOptions} = {}) {
    const stdout = stream(stdoutOptions);
    const stderr = stream();
    const code = main({argv, cwd, env, stdout, stderr, ...(templateDir && {templateDir})});
    return {code, cwd, stdout: stdout.output, stderr: stderr.output};
}

/** A small fake template, including files that must never be scaffolded. */
function fakeTemplate({withPackageJson = true} = {}) {
    const dir = tempDir();
    const files = {
        "sample.env": "SESSION_SECRET=\"REPLACE_ME\"\nMYSQL_USER=app\nMYSQL_PASSWORD=\"x\"\nMYSQL_ROOT_PASSWORD=\"y\"\n",
        "gitignore": "node_modules\n",
        "server/index.ts": "export {};\n",
        "client/src/pages/logs/Logs.tsx": "export {};\n",
        "client/src/dist/keep.ts": "export {};\n",
        "docker/init.sh": "#!/bin/sh\n",
        // must be skipped:
        ".env": "SECRET=1\n",
        ".env.local": "SECRET=1\n",
        ".env.production": "SECRET=1\n",
        ".DS_Store": "",
        "client/.DS_Store": "",
        "tsconfig.tsbuildinfo": "",
        "node_modules/x/index.js": "",
        "client/node_modules/y/index.js": "",
        "dist/server.js": "",
        "logs/access.log": "",
        "coverage/lcov.info": "",
        "server/public/index.html": "",
        "server/data/db.json": "",
        "prisma/client/client.ts": "",
        "prisma/schema.prisma": "",
    };
    if (withPackageJson) {
        files["package.json"] = JSON.stringify({name: "toto-app", dependencies: {"toto-stack": "^0.0.1"}});
    }
    for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
        writeFileSync(path.join(dir, file), content);
    }
    return dir;
}

describe("validateAppName", () => {
    it("accepts valid npm names", () => {
        for (const name of ["my-app", "app", "a1", "my_app", "my.app", "1app", "a".repeat(214)]) {
            assert.equal(validateAppName(name), null, name);
        }
    });

    it("rejects invalid names", () => {
        const invalid = {
            "": /empty/,
            [`${"a".repeat(215)}`]: /214/,
            "MyApp": /lowercase/,
            ".app": /start with/,
            "_app": /start with/,
            "node_modules": /not allowed/,
            "favicon.ico": /not allowed/,
            "apps/my-app": /path separators/,
            "apps\\my-app": /path separators/,
            " app": /spaces/,
            "my app": /may only contain/,
            "app!": /may only contain/,
            "app~": /may only contain/,
            "-app": /must start with a letter or digit/,
            "@scope/app": /path separators/,
        };
        for (const [name, message] of Object.entries(invalid)) {
            assert.match(validateAppName(name) ?? "", message, JSON.stringify(name));
        }
    });
});

describe("toPackageName", () => {
    it("derives a valid name from a directory name", () => {
        assert.equal(toPackageName("My Cool App"), "my-cool-app");
        assert.equal(toPackageName(".hidden_dir"), "hidden_dir");
        assert.equal(toPackageName("App (2)"), "app-2");
    });
});

describe("detectPackageManager", () => {
    it("reads npm_config_user_agent", () => {
        assert.equal(detectPackageManager("npm/10.9.2 node/v22.17.1 darwin arm64 workspaces/false"), "npm");
        assert.equal(detectPackageManager("pnpm/10.4.0 npm/? node/v22.17.1 darwin arm64"), "pnpm");
        assert.equal(detectPackageManager("yarn/4.6.0 npm/? node/v22.17.1 darwin arm64"), "yarn");
        assert.equal(detectPackageManager("bun/1.2.0 npm/? node/v22.17.1 darwin arm64"), "bun");
    });

    it("falls back to npm", () => {
        assert.equal(detectPackageManager(undefined), "npm");
        assert.equal(detectPackageManager(""), "npm");
        assert.equal(detectPackageManager("deno/2.0"), "npm");
        assert.equal(detectPackageManager("constructor/1.0"), "npm");
    });
});

describe("shouldCopy", () => {
    it("skips secrets, local state and build output", () => {
        for (const rel of [".env", ".env.local", "server/.env.test", "node_modules", "client/node_modules/x", ".DS_Store",
            "client/.DS_Store", "tsconfig.tsbuildinfo", "dist", "logs", "coverage", path.join("server", "public"),
            "server/data", "prisma/client"]) {
            assert.equal(shouldCopy(rel), false, rel);
        }
    });

    it("keeps everything else, including nested dist/logs directories", () => {
        for (const rel of ["", "sample.env", "package.json", "client/src/dist", "client/src/pages/logs", "server/index.ts",
            "prisma/schema.prisma", "prisma/migrations/0_init/migration.sql", ".dockerignore", "gitignore", "server/publicity.ts"]) {
            assert.equal(shouldCopy(rel), true, rel);
        }
    });
});

describe("createEnvFile", () => {
    const sample = "# comment\nSESSION_SECRET=\"REPLACE_ME\"\n# SETUP_TOKEN=\n#OTP_ENCRYPTION_KEY=\n# TOTP_ISSUER=\"My App\"\nMYSQL_USER=app\nMYSQL_PASSWORD=\"change-me\"\nMYSQL_ROOT_PASSWORD=\"change-me-root\"\nDOMAIN=\n";

    it("fills in random secrets and leaves other lines alone", () => {
        const env = createEnvFile(sample);
        const value = (key) => env.match(new RegExp(`^${key}="(.*)"$`, "m"))?.[1];
        assert.ok(value("SESSION_SECRET").length >= 32);
        assert.match(value("MYSQL_PASSWORD"), /^[0-9a-f]{48}$/);
        assert.match(value("MYSQL_ROOT_PASSWORD"), /^[0-9a-f]{48}$/);
        assert.notEqual(value("MYSQL_PASSWORD"), value("MYSQL_ROOT_PASSWORD"));
        // documented-only (commented) secrets are enabled
        assert.match(value("SETUP_TOKEN"), /^[A-Za-z0-9_-]{32}$/);
        assert.match(value("OTP_ENCRYPTION_KEY"), /^[0-9a-f]{64}$/);
        assert.match(env, /^# TOTP_ISSUER="My App"$/m);
        assert.match(env, /^# comment$/m);
        assert.match(env, /^MYSQL_USER=app$/m);
        assert.match(env, /^DOMAIN=$/m);
        assert.doesNotMatch(env, /REPLACE_ME|change-me/);
    });

    it("generates different secrets each time", () => {
        assert.notEqual(createEnvFile(sample), createEnvFile(sample));
    });
});

describe("main: arguments", () => {
    it("--help prints usage", () => {
        for (const flag of ["--help", "-h"]) {
            const result = run([flag]);
            assert.equal(result.code, 0);
            assert.match(result.stdout, /Usage: npm create toto-app/);
        }
    });

    it("--version prints the package version", () => {
        for (const flag of ["--version", "-v"]) {
            const result = run([flag]);
            assert.equal(result.code, 0);
            assert.equal(result.stdout, `${OWN_VERSION}\n`);
        }
    });

    it("rejects unknown flags", () => {
        const result = run(["my-app", "--frobnicate"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Unknown option '--frobnicate'/);
        assert.equal(existsSync(path.join(result.cwd, "my-app")), false);
    });

    it("requires exactly one directory", () => {
        assert.match(run([]).stderr, /Missing <directory>/);
        const result = run(["one", "two"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Expected one <directory>, got 2/);
    });

    it("rejects invalid names without creating anything", () => {
        const result = run(["My_App"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Invalid app name "My_App"/);
        assert.equal(existsSync(path.join(result.cwd, "My_App")), false);
    });

    it("fails cleanly when the target is a file", () => {
        const cwd = tempDir();
        writeFileSync(path.join(cwd, "taken"), "");
        const result = run(["taken"], {cwd});
        assert.equal(result.code, 1);
        assert.match(result.stderr, /"taken" already exists and is not a directory/);
        assert.doesNotMatch(result.stderr, /at .*index\.js/);
    });

    it("fails cleanly when the target directory is not empty", () => {
        const cwd = tempDir();
        mkdirSync(path.join(cwd, "taken"));
        writeFileSync(path.join(cwd, "taken", "file.txt"), "keep me");
        const result = run(["taken"], {cwd});
        assert.equal(result.code, 1);
        assert.match(result.stderr, /is not empty/);
        assert.equal(readFileSync(path.join(cwd, "taken", "file.txt"), "utf8"), "keep me");
    });
});

describe("main: scaffolding", () => {
    it("copies the template without local state and personalizes it", () => {
        const templateDir = fakeTemplate();
        const result = run(["my-app"], {templateDir});
        assert.equal(result.code, 0, result.stderr);
        const app = path.join(result.cwd, "my-app");

        for (const file of ["server/index.ts", "sample.env", "prisma/schema.prisma", "client/src/pages/logs/Logs.tsx", "client/src/dist/keep.ts"]) {
            assert.ok(existsSync(path.join(app, file)), `${file} should be copied`);
        }
        for (const file of [".env.local", ".env.production", ".DS_Store", "client/.DS_Store", "tsconfig.tsbuildinfo", "node_modules",
            "client/node_modules", "dist", "logs", "coverage", "server/public", "server/data", "prisma/client", "gitignore"]) {
            assert.equal(existsSync(path.join(app, file)), false, `${file} should not be copied`);
        }

        assert.equal(readFileSync(path.join(app, ".gitignore"), "utf8"), "node_modules\n");

        const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
        assert.equal(pkg.name, "my-app");
        assert.equal(pkg.dependencies["toto-stack"], `^${OWN_VERSION}`);

        // .env is generated from sample.env (not copied from the template's .env)
        const env = readFileSync(path.join(app, ".env"), "utf8");
        assert.doesNotMatch(env, /SECRET=1|REPLACE_ME/);
        assert.match(env, /^MYSQL_USER=app$/m);

        if (!isWindows) {
            assert.equal(statSync(path.join(app, ".env")).mode & 0o777, 0o600);
            assert.equal(statSync(path.join(app, "docker/init.sh")).mode & 0o777, 0o755);
        }
    });

    it("scaffolds into the current directory with \".\"", () => {
        const cwd = path.join(tempDir(), "My Project");
        mkdirSync(path.join(cwd, ".git"), {recursive: true});
        const result = run(["."], {cwd, templateDir: fakeTemplate()});
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).name, "my-project");
        assert.doesNotMatch(result.stdout, /cd \./);
    });

    it("removes a directory it created when scaffolding fails", () => {
        const result = run(["broken"], {templateDir: fakeTemplate({withPackageJson: false})});
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Scaffolding failed/);
        assert.equal(existsSync(path.join(result.cwd, "broken")), false);
    });

    it("empties (but keeps) the current directory when scaffolding into \".\" fails", () => {
        const cwd = path.join(tempDir(), "inplace");
        mkdirSync(path.join(cwd, ".git"), {recursive: true});
        const result = run(["."], {cwd, templateDir: fakeTemplate({withPackageJson: false})});
        assert.equal(result.code, 1);
        assert.ok(existsSync(path.join(cwd, ".git")));
        assert.equal(existsSync(path.join(cwd, "server")), false);
    });

    it("prints next steps for the detected package manager", () => {
        const npm = run(["npm-app"], {templateDir: fakeTemplate()});
        assert.match(npm.stdout, /cd npm-app/);
        assert.match(npm.stdout, /npm install/);
        assert.match(npm.stdout, /docker compose up -d --wait db/);
        assert.match(npm.stdout, /npm run db:deploy/);
        assert.match(npm.stdout, /npm run dev/);
        assert.match(npm.stdout, /SETUP_TOKEN/);

        const pnpm = run(["pnpm-app"], {templateDir: fakeTemplate(), env: {npm_config_user_agent: "pnpm/10.4.0 npm/? node/v22.17.1"}});
        assert.match(pnpm.stdout, /pnpm install/);
        assert.match(pnpm.stdout, /pnpm db:deploy/);
        assert.match(pnpm.stdout, /pnpm approve-builds/);
    });

    it("uses colors only on a TTY without NO_COLOR", () => {
        const ESC = "\x1b[";
        assert.ok(!run(["plain"], {templateDir: fakeTemplate()}).stdout.includes(ESC));
        assert.ok(!run(["nocolor"], {templateDir: fakeTemplate(), env: {NO_COLOR: "1"}, stdoutOptions: {isTTY: true}}).stdout.includes(ESC));
        assert.ok(run(["color"], {templateDir: fakeTemplate(), stdoutOptions: {isTTY: true}}).stdout.includes(ESC));
    });

    it("initializes git only with --git", () => {
        const git = spawnSync("git", ["--version"]);
        if (git.status !== 0) return;
        const withGit = run(["with-git", "--git"], {templateDir: fakeTemplate()});
        assert.equal(withGit.code, 0, withGit.stderr);
        assert.ok(existsSync(path.join(withGit.cwd, "with-git", ".git")));

        const withoutGit = run(["without-git", "--no-git"], {templateDir: fakeTemplate()});
        assert.equal(existsSync(path.join(withoutGit.cwd, "without-git", ".git")), false);
    });

    it("scaffolds the real template", () => {
        const result = run(["real-app"]);
        assert.equal(result.code, 0, result.stderr);
        const app = path.join(result.cwd, "real-app");
        for (const file of ["package.json", ".gitignore", ".env", "sample.env", "Dockerfile", "docker-compose.yml", "docker-compose.prod.yml",
            "prisma.config.ts", "prisma/schema.prisma", "server/index.ts", "client/src/index.tsx"]) {
            assert.ok(existsSync(path.join(app, file)), file);
        }
        for (const file of ["dist", "server/public", "prisma/client", "node_modules"]) {
            assert.equal(existsSync(path.join(app, file)), false, file);
        }

        // The generated .env has real secrets (no placeholders the stack rejects)
        // and leaves optional features (SMTP) disabled.
        const env = readFileSync(path.join(app, ".env"), "utf8");
        for (const key of ["SESSION_SECRET", "SETUP_TOKEN", "OTP_ENCRYPTION_KEY", "MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"]) {
            assert.match(env, new RegExp(`^${key}="[^"]{32,}"$`, "m"), key);
        }
        assert.doesNotMatch(env, /change-me|changeme/i);
        assert.doesNotMatch(env, /^SMTP_/m);
        assert.doesNotMatch(env, /^NODE_ENV=/m);
        assert.ok(existsSync(TEMPLATE_DIR));
    });
});

describe("bin", () => {
    it("runs when executed directly", () => {
        const result = spawnSync(process.execPath, [CLI, "--version"], {encoding: "utf8"});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${OWN_VERSION}\n`);
    });

    it("runs through a symlink (like node_modules/.bin)", {skip: isWindows}, () => {
        const link = path.join(tempDir(), "create-toto-app");
        symlinkSync(CLI, link);
        const result = spawnSync(process.execPath, [link, "--version"], {encoding: "utf8"});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${OWN_VERSION}\n`);
    });

    it("does not run when imported", () => {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../index.js", import.meta.url).href)})`], {encoding: "utf8"});
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
    });
});
