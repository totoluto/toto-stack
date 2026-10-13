import {describe, expect, it} from "vitest";
import {ConfigError, resolveConfig, StackConfig} from "@server/libs/config/StackConfig";
import fakePrisma from "../fakePrisma";
import {PROD_SECRET} from "./support";

const base: StackConfig = {prisma: fakePrisma};
const OTHER_SECRET = "4lfiuxBQXB2zM6IN3LMEogidOU6fzyZNrMshU7p5";
const prodEnv = {NODE_ENV: "production", SESSION_SECRET: PROD_SECRET, ALLOWED_ORIGINS: "https://app.example.com"};

function issues(config: StackConfig, env: Record<string, string | undefined>): readonly string[] {
    try {
        resolveConfig(config, env);
    } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as ConfigError).issues;
    }
    return [];
}

describe("config resolution: development vs production (H12)", () => {
    it.each([
        ["development", true],
        ["test", true],
        ["production", false],
        ["staging", false],
        ["Development", false],
    ])("NODE_ENV=%s -> isDev=%s", (nodeEnv, isDev) => {
        const env = {...prodEnv, NODE_ENV: nodeEnv};
        expect(resolveConfig(base, env).config.isDev).toBe(isDev);
    });

    it("treats an unset NODE_ENV as production and explains why settings are required", () => {
        const problems = issues(base, {});

        expect(problems.some(issue => issue.startsWith("SESSION_SECRET is required in production"))).toBe(true);
        expect(problems.some(issue => issue.startsWith("ALLOWED_ORIGINS is required in production"))).toBe(true);
        expect(problems.some(issue => issue.includes("NODE_ENV is not set"))).toBe(true);
    });

    it("warns (but starts) when NODE_ENV is unset and production settings are complete", () => {
        const {config, warnings} = resolveConfig(base, {...prodEnv, NODE_ENV: undefined});

        expect(config.isDev).toBe(false);
        expect(warnings.some(warning => warning.includes("NODE_ENV is not set"))).toBe(true);
    });

    it("includes a generation hint in the secret error", () => {
        const [problem] = issues(base, {...prodEnv, SESSION_SECRET: undefined});
        expect(problem).toMatch(/openssl rand -base64 48/);
    });

    it.each(["change-me", "CHANGEME", "not secure", "secret", "change-me-to-a-long-random-value-please-0123"])(
        "rejects the placeholder secret %j in production",
        secret => {
            const problems = issues(base, {...prodEnv, SESSION_SECRET: secret});
            expect(problems).toEqual([expect.stringMatching(/SESSION_SECRET looks like a placeholder/)]);
        },
    );

    it("rejects secrets shorter than 32 characters in production", () => {
        const problems = issues(base, {...prodEnv, SESSION_SECRET: PROD_SECRET.slice(0, 31)});
        expect(problems).toEqual([expect.stringMatching(/at least 32 characters \(got 31\)/)]);
        expect(issues(base, {...prodEnv, SESSION_SECRET: PROD_SECRET.slice(0, 32)})).toEqual([]);
    });

    it("prefers config values over the environment", () => {
        const {config} = resolveConfig(
            {...base, security: {sessionSecret: OTHER_SECRET, allowedOrigins: ["https://other.example.com"]}, http: {port: 4000}},
            {...prodEnv, PORT: "5000"},
        );

        expect(config.security.sessionSecret).toBe(OTHER_SECRET);
        expect(config.security.allowedOrigins).toEqual(["https://other.example.com"]);
        expect(config.http.port).toBe(4000);
    });

    it("collects every problem into one ConfigError", () => {
        const problems = issues(
            {...base, frontend: {dir: "relative/public"}, roles: [" "]},
            {NODE_ENV: "production", SESSION_SECRET: "short", ALLOWED_ORIGINS: "http://app.example.com", PORT: "99999", SETUP_TOKEN: "abc"},
        );

        expect(problems).toHaveLength(6);
        expect(problems.join("\n")).toMatch(/SESSION_SECRET.*32/);
        expect(problems.join("\n")).toMatch(/ALLOWED_ORIGINS must contain comma-separated https origins/);
        expect(problems.join("\n")).toMatch(/PORT must be an integer/);
        expect(problems.join("\n")).toMatch(/SETUP_TOKEN must be at least 16/);
        expect(problems.join("\n")).toMatch(/frontend.dir must be an absolute path/);
        expect(problems.join("\n")).toMatch(/roles: " " is not a valid role name/);
    });

    it("rejects origins with paths", () => {
        expect(issues(base, {...prodEnv, ALLOWED_ORIGINS: "https://app.example.com/app"})).toHaveLength(1);
    });
});

describe("config resolution: development defaults", () => {
    it("generates a random ephemeral secret and warns when none is set", () => {
        const first = resolveConfig(base, {NODE_ENV: "development"});
        const second = resolveConfig(base, {NODE_ENV: "development"});

        expect(first.config.security.sessionSecret.length).toBeGreaterThanOrEqual(32);
        expect(first.config.security.sessionSecret).not.toBe(second.config.security.sessionSecret);
        expect(first.config.security.sessionSecret).not.toBe("not secure");
        expect(first.warnings.some(warning => warning.includes("SESSION_SECRET is not set"))).toBe(true);
    });

    it("only warns about a weak secret in development", () => {
        const {config, warnings} = resolveConfig(base, {NODE_ENV: "development", SESSION_SECRET: "change-me"});

        expect(config.security.sessionSecret).toBe("change-me");
        expect(warnings.some(warning => warning.includes("placeholder"))).toBe(true);
    });

    it("does not require ALLOWED_ORIGINS and accepts http origins in development", () => {
        const {config} = resolveConfig(base, {NODE_ENV: "development", ALLOWED_ORIGINS: "http://localhost:5173"});
        expect(config.security.allowedOrigins).toEqual(["http://localhost:5173"]);
    });

    it("applies the documented defaults", () => {
        const {config} = resolveConfig(base, {NODE_ENV: "test"});

        expect(config.http).toEqual({port: 3001, host: undefined, trustProxy: false, bodyLimit: "10kb"});
        expect(config.session).toEqual({
            absoluteTimeout: 7 * 24 * 60 * 60 * 1000,
            idleTimeout: 24 * 60 * 60 * 1000,
            touchInterval: 5 * 60 * 1000,
            cookieName: "connect.sid",
        });
        expect(config.frontend).toBe(false);
        expect(config.shutdown).toEqual({handleSignals: false, timeoutMs: 10_000});
        expect(config.roles).toEqual(["owner", "admin"]);
    });
});

describe("config resolution: individual settings", () => {
    it.each([
        [undefined, false],
        ["", false],
        ["false", false],
        ["true", true],
        ["1", 1],
        ["2", 2],
        ["loopback, 10.0.0.0/8", "loopback, 10.0.0.0/8"],
    ])("TRUST_PROXY=%j -> %j", (value, expected) => {
        expect(resolveConfig(base, {NODE_ENV: "test", TRUST_PROXY: value}).config.http.trustProxy).toEqual(expected);
    });

    it("reads PORT and HOST from the environment", () => {
        const {config} = resolveConfig(base, {NODE_ENV: "test", PORT: "0", HOST: "127.0.0.1"});
        expect(config.http).toMatchObject({port: 0, host: "127.0.0.1"});
    });

    it("merges app roles after the built-ins without duplicates", () => {
        const {config} = resolveConfig({...base, roles: ["editor", "admin", " viewer ", "editor"]}, {NODE_ENV: "test"});
        expect(config.roles).toEqual(["owner", "admin", "editor", "viewer"]);
    });

    it("rejects invalid session settings", () => {
        expect(issues({...base, session: {absoluteTimeout: 0, cookieName: "bad name"}}, {NODE_ENV: "test"})).toHaveLength(2);
    });
});
