import crypto from "node:crypto";

/**
 * AES-256-GCM sealing for TOTP secrets at rest (optional; enabled by
 * `security.otpEncryptionKey` / OTP_ENCRYPTION_KEY).
 *
 * Sealed format: `enc:v1:<iv>.<tag>.<ciphertext>` (base64url parts, 96-bit
 * random IV, 128-bit tag). Base32 secrets never contain ":", so plaintext
 * values stored before a key was configured stay readable.
 */

const PREFIX = "enc:v1:";
const AAD = Buffer.from("toto-stack/otp-secret/v1");
const KEY_BYTES = 32;

/**
 * Decodes a 32-byte key given as 64 hex characters or base64/base64url.
 * Returns null when the value is not exactly 32 bytes.
 */
export function parseEncryptionKey(value: string): Buffer | null {
    const trimmed = value.trim();

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, "hex");
    }

    if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(trimmed)) {
        const key = Buffer.from(trimmed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url");
        return key.length === KEY_BYTES ? key : null;
    }

    return null;
}

export function isSealed(value: string): boolean {
    return value.startsWith(PREFIX);
}

export function seal(plaintext: string, key: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {authTagLength: 16});
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

/** Throws when the value was tampered with or sealed with another key. */
export function open(sealed: string, key: Buffer): string {
    const parts = sealed.slice(PREFIX.length).split(".");
    if (!isSealed(sealed) || parts.length !== 3) {
        throw new Error("Malformed sealed value");
    }

    const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16) {
        throw new Error("Malformed sealed value");
    }

    // authTagLength pins the full 128-bit tag (GCM would otherwise accept truncated tags).
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {authTagLength: 16});
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
