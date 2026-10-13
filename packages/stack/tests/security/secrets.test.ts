import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {describe, expect, it} from "vitest";
import {ConfigError, resolveConfig} from "@server/libs/config/StackConfig";
import {keyBytesWeakness, secretWeakness} from "@server/libs/security/secretStrength";
import fakePrisma from "../fakePrisma";

const PROD = {NODE_ENV: "production", ALLOWED_ORIGINS: "https://app.example.com"};
const GOOD_SECRET = "zZxxjFIrIKlTis7CU2NfHosgGWebJF9IhTQiUXO2KAyM2SZ3";

function issues(env: Record<string, string>): readonly string[] {
    try {
        resolveConfig({prisma: fakePrisma}, {...PROD, SESSION_SECRET: GOOD_SECRET, ...env});
        return [];
    } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as ConfigError).issues;
    }
}

describe("secret strength checks (H12)", () => {
    it.each([
        "REPLACE_ME_WITH_A_LONG_RANDOM_STRING_0123456789",
        "change-me-0123456789abcdefghijklmnopqrstuvwxyz",
        "ChangeMe0123456789abcdefghijklmnopqrstuvwxyzAB",
        "example-session-key-0123456789abcdefghijklmnop",
        "placeholder0123456789abcdefghijklmnopqrstuvwxyz",
        "my-super-secret-session-key-please-rotate-2024",
        "PleaseReplaceThisValue0123456789abcdefghijklmnop",
        "MY_APP_SECRET_KEY_2024_PLEASE_ROTATE_REGULARLY",
        "your-session-key-goes-here-please-make-it-long",
        "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-1234567890",
        "todo-generate-a-real-random-value-before-deploying",
        "TODO_SET_A_REAL_SESSION_KEY_BEFORE_GOING_LIVE_123",
        "not secure 0123456789abcdefghijklmnopqrstuvwxyzAB",
        "this-is-NotSecure-0123456789abcdefghijklmnopqrstuv",
    ])("rejects the placeholder %j", secret => {
        expect(secretWeakness(secret, 32)).toMatch(/^looks like a placeholder \(contains "/);
        expect(issues({SESSION_SECRET: secret})).toEqual([expect.stringMatching(/^SESSION_SECRET looks like a placeholder.*openssl rand -base64 48/)]);
    });

    it.each([
        ["a".repeat(48), 1],
        ["ab".repeat(24), 2],
        ["012345678".repeat(5), 9],
    ])("rejects low-variety secrets (%j)", (secret, distinct) => {
        expect(secretWeakness(secret, 32)).toBe(`is not random enough (only ${distinct} distinct character${distinct === 1 ? "" : "s"})`);
        expect(issues({SESSION_SECRET: secret})).toEqual([expect.stringMatching(/^SESSION_SECRET is not random enough/)]);
    });

    it("keeps the length rule", () => {
        expect(secretWeakness(GOOD_SECRET.slice(0, 31), 32)).toBe("must be at least 32 characters (got 31)");
        expect(secretWeakness(GOOD_SECRET.slice(0, 32), 32)).toBeNull();
    });

    it("accepts generated secrets in every common format (seeded, deterministic)", () => {
        // Deterministic byte stream: SHA-512 in counter mode
        let counter = 0;
        const seededBytes = (length: number) => {
            const chunks: Buffer[] = [];
            for (let size = 0; size < length; size += 64) chunks.push(crypto.createHash("sha512").update(`toto-secret-seed-${counter++}`).digest());
            return Buffer.concat(chunks).subarray(0, length);
        };
        const formats: [string, () => string, number][] = [
            ["base64(48), openssl rand -base64 48 / create-toto-app", () => seededBytes(48).toString("base64"), 32],
            ["base64url(48), node one-liner", () => seededBytes(48).toString("base64url"), 32],
            ["base64(32)", () => seededBytes(32).toString("base64"), 32],
            ["base64url(32)", () => seededBytes(32).toString("base64url"), 32],
            ["hex(32)", () => seededBytes(32).toString("hex"), 32],
            ["hex(16), openssl rand -hex 16", () => seededBytes(16).toString("hex"), 32],
            ["setup token base64url(24)", () => seededBytes(24).toString("base64url"), 16],
            ["setup token base64(24)", () => seededBytes(24).toString("base64"), 16],
        ];

        for (const [name, generate, minLength] of formats) {
            const rejected: string[] = [];
            for (let i = 0; i < 25_000; i++) {
                const value = generate();
                if (secretWeakness(value, minLength) !== null) rejected.push(value);
            }
            expect(rejected, name).toEqual([]);
        }
    });

    it.each([
        // Regression: "+tOdO+" must not count as the word "todo"
        "u0FD+tOdO++WqFD8iKnIHrKEDzV7Lt/Pxs5CsuQfw9A4zn3ED6EDnvM51LGDbMZi",
        // Random case or glued letters never form a marker
        "q7sEcReTx9vB2kLmN4pQ8rT1wY6zA3cF5hJ0gD2uI9oK7eS1",
        "Zx9mysecretkeyQ4v8LmN2pR7tY1wB6cF3hJ5gD0uI8oK2eS",
        "Ab3_todoX7-k9Lm2pQ8rT1wY6zA3cF5hJ0gD2uI9oK7eS1vB",
        "xXxX9vB2kLmN4pQ8rT1wY6zA3cF5hJ0gD2uI9oK7eS1q7sY3",
        // Regression: random values that tripped stricter word rules
        "oOkZImSRTLkDmGJxBcfjmwDC-xxX_xwy",
        "5naJYZcaSUCq3fyNT4TpIsecret90osOjpGDTDl+sHdmfFQgtT0UaKL3xaAnatq9",
    ])("accepts the random-looking value %j", value => {
        expect(secretWeakness(value, 16)).toBeNull();
    });

    it("accepts the output of openssl rand", () => {
        let output: string;
        try {
            output = execFileSync("openssl", ["rand", "-base64", "48"], {encoding: "utf8"}).trim();
        } catch {
            return; // openssl not installed
        }
        expect(issues({SESSION_SECRET: output})).toEqual([]);
    });

    it("applies the checks to SETUP_TOKEN (min. 16), also in development", () => {
        expect(issues({SETUP_TOKEN: crypto.randomBytes(24).toString("base64url")})).toEqual([]);
        expect(issues({SETUP_TOKEN: crypto.randomBytes(8).toString("hex")})).toEqual([]);
        expect(issues({SETUP_TOKEN: crypto.randomBytes(12).toString("base64")})).toEqual([]);

        expect(issues({SETUP_TOKEN: "short-token"})).toEqual([expect.stringMatching(/^SETUP_TOKEN must be at least 16 characters \(got 11\).*openssl rand/)]);
        expect(issues({SETUP_TOKEN: "replace-this-setup-token"})).toEqual([expect.stringMatching(/^SETUP_TOKEN looks like a placeholder/)]);
        expect(issues({SETUP_TOKEN: "aaaaaaaaaaaaaaaaaaaa"})).toEqual([expect.stringMatching(/^SETUP_TOKEN is not random enough/)]);
        expect(() => resolveConfig({prisma: fakePrisma}, {NODE_ENV: "development", SETUP_TOKEN: "changeme-changeme"})).toThrow(/SETUP_TOKEN looks like a placeholder/);
    });

    it("applies the checks to OTP_ENCRYPTION_KEY", () => {
        expect(issues({OTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex")})).toEqual([]);
        expect(issues({OTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64")})).toEqual([]);
        expect(issues({OTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64url")})).toEqual([]);

        expect(issues({OTP_ENCRYPTION_KEY: "0".repeat(64)})).toEqual([expect.stringMatching(/^OTP_ENCRYPTION_KEY is not random enough \(only 1 distinct bytes\).*openssl rand -base64 32/)]);
        expect(issues({OTP_ENCRYPTION_KEY: "0123456789abcdef".repeat(4)})).toEqual([expect.stringMatching(/^OTP_ENCRYPTION_KEY is not random enough \(only 8 distinct bytes\)/)]);
        // A 43-character base64url placeholder decodes to 32 bytes; the marker check catches it
        expect(issues({OTP_ENCRYPTION_KEY: "replace-with-32-random-bytes-in-base64url00"})).toEqual([expect.stringMatching(/^OTP_ENCRYPTION_KEY looks like a placeholder/)]);
        expect(issues({OTP_ENCRYPTION_KEY: "nope"})).toEqual([expect.stringMatching(/^OTP_ENCRYPTION_KEY must be 32 bytes/)]);
    });

    it("validates security.passwordHashing", () => {
        type Hashing = {concurrency?: number; queueLimit?: number; memoryCost?: number; timeCost?: number; parallelism?: number};
        const resolve = (passwordHashing: Hashing, env: Record<string, string> = {NODE_ENV: "test"}) =>
            resolveConfig({prisma: fakePrisma, security: {passwordHashing}}, env);
        const defaults = {concurrency: 2, queueLimit: 32, memoryCost: 19456, timeCost: 2, parallelism: 1};

        expect(resolve({}).config.security.passwordHashing).toEqual(defaults);
        expect(resolve({concurrency: 3, queueLimit: 0, memoryCost: 65536, timeCost: 3}).config.security.passwordHashing)
            .toEqual({...defaults, concurrency: 3, queueLimit: 0, memoryCost: 65536, timeCost: 3});
        expect(() => resolve({concurrency: 0})).toThrow(/passwordHashing.concurrency/);
        expect(() => resolve({queueLimit: 1.5})).toThrow(/passwordHashing.queueLimit/);
        expect(() => resolve({memoryCost: 4})).toThrow(/passwordHashing.memoryCost/);
        expect(() => resolve({timeCost: 0})).toThrow(/passwordHashing.timeCost/);
        expect(() => resolve({parallelism: 0})).toThrow(/passwordHashing.parallelism/);

        // Below the OWASP baseline: allowed, but production warns
        const weak = resolve({memoryCost: 8192}, {...PROD, SESSION_SECRET: GOOD_SECRET});
        expect(weak.warnings.some(warning => warning.includes("below the OWASP Argon2id baseline"))).toBe(true);
    });

    it("judges decoded key bytes", () => {
        expect(keyBytesWeakness(crypto.randomBytes(32))).toBeNull();
        expect(keyBytesWeakness(Buffer.alloc(32, 7))).toBe("is not random enough (only 1 distinct bytes)");
    });
});
