import crypto from "node:crypto";

/**
 * A 32-byte subkey of the session secret for one purpose (HKDF-SHA256,
 * RFC 5869). Every use of the secret gets its own label, so keys for CSRF
 * tokens, device cookies, etc. are independent of each other and of the
 * session-cookie signature.
 */
export function deriveKey(secret: string, label: string): Buffer {
    return Buffer.from(crypto.hkdfSync("sha256", secret, "toto-stack", label, 32));
}
