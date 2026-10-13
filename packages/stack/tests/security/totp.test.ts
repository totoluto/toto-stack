import {afterEach, describe, expect, it, vi} from "vitest";
import {generateSync} from "@otplib/totp";
import {crypto as nodeCryptoPlugin} from "@otplib/plugin-crypto-node";
import {base32} from "@otplib/plugin-base32-scure";
import {isSealed, open, parseEncryptionKey, seal} from "@server/libs/security/secretBox";
import MfaService from "@server/libs/security/MfaService";
import {resolveConfig} from "@server/libs/config/StackConfig";
import {totp} from "../helpers";
import fakePrisma from "../fakePrisma";

type Algorithm = "sha1" | "sha256" | "sha512";

// RFC 6238 Appendix B: seeds are the ASCII strings below, 8 digits, 30 s steps.
const SEEDS: Record<Algorithm, Buffer> = {
    sha1: Buffer.from("12345678901234567890"),
    sha256: Buffer.from("12345678901234567890123456789012"),
    sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
};

const RFC6238_VECTORS: [number, Algorithm, string][] = [
    [59, "sha1", "94287082"], [59, "sha256", "46119246"], [59, "sha512", "90693936"],
    [1111111109, "sha1", "07081804"], [1111111109, "sha256", "68084774"], [1111111109, "sha512", "25091201"],
    [1111111111, "sha1", "14050471"], [1111111111, "sha256", "67062674"], [1111111111, "sha512", "99943326"],
    [1234567890, "sha1", "89005924"], [1234567890, "sha256", "91819424"], [1234567890, "sha512", "93441116"],
    [2000000000, "sha1", "69279037"], [2000000000, "sha256", "90698825"], [2000000000, "sha512", "38618901"],
    [20000000000, "sha1", "65353130"], [20000000000, "sha256", "77737706"], [20000000000, "sha512", "47863826"],
];

const SHA1_SECRET = base32.encode(SEEDS.sha1); // "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

afterEach(() => {
    vi.useRealTimers();
});

/** Freezes Date.now() at `seconds` since the epoch. */
function at(seconds: number): void {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(seconds * 1000);
}

describe("TOTP via otplib (C1)", () => {
    it.each(RFC6238_VECTORS)("our otplib setup (node:crypto HMAC, scure base32) matches RFC 6238 at T=%i (%s)", (seconds, algorithm, expected) => {
        expect(generateSync({secret: base32.encode(SEEDS[algorithm]), epoch: seconds, digits: 8, algorithm, crypto: nodeCryptoPlugin, base32})).toBe(expected);
    });

    it("MfaService verifies the RFC 6238 SHA-1 vectors (6-digit form) and returns the time step", () => {
        const mfa = new MfaService({issuer: "x"});
        for (const [seconds, , expected] of RFC6238_VECTORS.filter(([, algorithm]) => algorithm === "sha1")) {
            at(seconds);
            expect(mfa.verify(expected.slice(-6), SHA1_SECRET), `T=${seconds}`).toBe(Math.floor(seconds / 30));
        }
    });

    it("accepts ±1 step of clock drift and rejects ±2 (M15)", () => {
        const mfa = new MfaService({issuer: "x"});
        const now = 1_700_000_010;
        const step = Math.floor(now / 30);
        at(now);

        expect(mfa.verify(totp(SHA1_SECRET, now * 1000), SHA1_SECRET)).toBe(step);
        expect(mfa.verify(totp(SHA1_SECRET, (now - 30) * 1000), SHA1_SECRET)).toBe(step - 1);
        expect(mfa.verify(totp(SHA1_SECRET, (now + 30) * 1000), SHA1_SECRET)).toBe(step + 1);
        expect(mfa.verify(totp(SHA1_SECRET, (now - 60) * 1000), SHA1_SECRET)).toBeNull();
        expect(mfa.verify(totp(SHA1_SECRET, (now + 60) * 1000), SHA1_SECRET)).toBeNull();
    });

    it("rejects the last used step and older ones (replay), and never throws for a future last step", () => {
        const mfa = new MfaService({issuer: "x"});
        const now = 1_700_000_010;
        const step = Math.floor(now / 30);
        at(now);

        expect(mfa.verify(totp(SHA1_SECRET, now * 1000), SHA1_SECRET, step)).toBeNull();
        expect(mfa.verify(totp(SHA1_SECRET, (now - 30) * 1000), SHA1_SECRET, step - 1)).toBeNull();
        expect(mfa.verify(totp(SHA1_SECRET, (now + 30) * 1000), SHA1_SECRET, step)).toBe(step + 1);
        // Last used step ahead of the server clock (e.g. the clock moved back): nothing is accepted, no exception
        expect(mfa.verify(totp(SHA1_SECRET, (now + 30) * 1000), SHA1_SECRET, step + 1)).toBeNull();
        expect(mfa.verify(totp(SHA1_SECRET, now * 1000), SHA1_SECRET, step + 50)).toBeNull();
    });

    it("rejects malformed tokens without throwing", () => {
        const mfa = new MfaService({issuer: "x"});
        for (const token of ["", "12345", "1234567", "12345a", " 123456", "１２３４５６"]) {
            expect(mfa.verify(token, SHA1_SECRET)).toBeNull();
        }
    });
});

describe("MfaService", () => {
    it("generates a 160-bit secret, an issuer-labelled URI and a QR code, and verifies codes", async () => {
        const mfa = new MfaService({issuer: "app.example.com"});
        const {secret, uri, qrCode} = await mfa.generate("owner");

        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(base32.decode(secret)).toHaveLength(20);
        expect(uri).toBe(`otpauth://totp/app.example.com:owner?secret=${secret}&issuer=app.example.com`);
        expect(qrCode).toMatch(/^data:image\/png;base64,/);

        const step = mfa.verify(totp(secret), secret);
        expect(step).toBeTypeOf("number");
        expect(mfa.verify(totp(secret), secret, step)).toBeNull();
    });

    it("encodes issuer and account name in the otpauth URI (L35)", async () => {
        const {uri, secret} = await new MfaService({issuer: "Acme Corp"}).generate("jane doe");
        expect(uri).toBe(`otpauth://totp/Acme%20Corp:jane%20doe?secret=${secret}&issuer=Acme%20Corp`);
    });

    it("defaults the issuer to the first allowed origin's host", () => {
        const resolve = (env: Record<string, string>, security = {}) => resolveConfig({prisma: fakePrisma, security}, {NODE_ENV: "test", ...env}).config.security.totpIssuer;
        expect(resolve({})).toBe("toto-stack");
        expect(resolve({ALLOWED_ORIGINS: "https://app.example.com"})).toBe("app.example.com");
        expect(resolve({TOTP_ISSUER: "Acme"})).toBe("Acme");
        expect(() => resolve({TOTP_ISSUER: "bad:issuer"})).toThrow(/TOTP_ISSUER/);
    });
});

describe("TOTP secret encryption at rest (L37)", () => {
    const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    it("parses 32-byte hex/base64 keys only", () => {
        expect(parseEncryptionKey(key)).toHaveLength(32);
        expect(parseEncryptionKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
        expect(parseEncryptionKey(Buffer.alloc(32, 7).toString("base64url"))).toHaveLength(32);
        expect(parseEncryptionKey("too-short")).toBeNull();
        expect(parseEncryptionKey(Buffer.alloc(16).toString("hex"))).toBeNull();
        expect(() => resolveConfig({prisma: fakePrisma, security: {otpEncryptionKey: "nope"}}, {NODE_ENV: "test"})).toThrow(/OTP_ENCRYPTION_KEY/);
    });

    it("seals with AES-256-GCM and detects tampering or a wrong key", () => {
        const k = parseEncryptionKey(key)!;
        const sealed = seal("JBSWY3DPEHPK3PXP", k);

        expect(isSealed(sealed)).toBe(true);
        expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
        expect(open(sealed, k)).toBe("JBSWY3DPEHPK3PXP");
        expect(seal("JBSWY3DPEHPK3PXP", k)).not.toBe(sealed);

        // Flip one real bit in each decoded part (never rely on base64url padding bits)
        const [iv, tag, ciphertext] = sealed.slice("enc:v1:".length).split(".").map(part => Buffer.from(part, "base64url"));
        const flipped = (part: Buffer, index: number) => {
            const copy = Buffer.from(part);
            copy[index] ^= 0x01;
            return copy;
        };
        const encodeParts = (parts: Buffer[]) => `enc:v1:${parts.map(part => part.toString("base64url")).join(".")}`;

        expect(open(encodeParts([iv, tag, ciphertext]), k)).toBe("JBSWY3DPEHPK3PXP");
        for (const index of [0, ciphertext.length - 1]) {
            expect(() => open(encodeParts([iv, tag, flipped(ciphertext, index)]), k)).toThrow();
        }
        for (const index of [0, tag.length - 1]) {
            expect(() => open(encodeParts([iv, flipped(tag, index), ciphertext]), k)).toThrow();
        }
        for (const index of [0, iv.length - 1]) {
            expect(() => open(encodeParts([flipped(iv, index), tag, ciphertext]), k)).toThrow();
        }
        // A truncated tag is refused too (no GCM tag shortening)
        expect(() => open(encodeParts([iv, tag.subarray(0, 12), ciphertext]), k)).toThrow();
        expect(() => open(sealed, parseEncryptionKey("f".repeat(64))!)).toThrow();
    });

    it("MfaService seals new secrets, reads secrets stored before the key was set, and refuses sealed values without a key", () => {
        const withKey = new MfaService({issuer: "x", encryptionKey: key});
        const withoutKey = new MfaService({issuer: "x"});

        const sealed = withKey.sealSecret("JBSWY3DPEHPK3PXP");
        expect(isSealed(sealed)).toBe(true);
        expect(withKey.openSecret(sealed)).toBe("JBSWY3DPEHPK3PXP");
        expect(withKey.openSecret("JBSWY3DPEHPK3PXP")).toBe("JBSWY3DPEHPK3PXP");
        expect(withKey.needsReseal("JBSWY3DPEHPK3PXP")).toBe(true);
        expect(withKey.needsReseal(sealed)).toBe(false);

        expect(withoutKey.sealSecret("JBSWY3DPEHPK3PXP")).toBe("JBSWY3DPEHPK3PXP");
        expect(withoutKey.needsReseal("JBSWY3DPEHPK3PXP")).toBe(false);
        expect(() => withoutKey.openSecret(sealed)).toThrow(/OTP encryption key/);
    });
});
