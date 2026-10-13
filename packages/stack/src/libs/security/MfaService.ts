import crypto from "node:crypto";
import {TOTP, verifySync} from "@otplib/totp";
import {crypto as nodeCryptoPlugin} from "@otplib/plugin-crypto-node";
import {base32} from "@otplib/plugin-base32-scure";
import {isSealed, open, parseEncryptionKey, seal} from "@server/libs/security/secretBox";

export type MfaSetup = {
    /** Base32 secret, shown to the user for manual entry. */
    secret: string;
    /** otpauth:// URI encoded in the QR code. */
    uri: string;
    /** QR code of `uri` as a PNG data URL. */
    qrCode: string;
};

export type MfaServiceOptions = {
    /** Issuer shown in authenticator apps. */
    issuer: string;
    /** 32-byte key (hex/base64) to encrypt stored secrets with AES-256-GCM. */
    encryptionKey?: string;
};

/** 160-bit secrets, the size RFC 4226 recommends for HMAC-SHA1. */
const SECRET_BYTES = 20;
const PERIOD_SECONDS = 30;
/** otplib plugins: HMAC from node:crypto, RFC 4648 base32 from @scure/base. */
const PLUGINS = {crypto: nodeCryptoPlugin, base32} as const;

/**
 * TOTP enrollment and verification with otplib (RFC 6238 defaults that
 * authenticator apps implement: SHA-1, 6 digits, 30 s), accepting ±1 step
 * of clock drift.
 *
 * The service is stateless: replay protection is the caller's job - persist
 * the step returned by verify() and pass it back as `lastUsedStep` (UserService
 * records it with a conditional update, so concurrent submissions of one code
 * cannot both succeed).
 */
export default class MfaService {
    private readonly issuer: string;
    private readonly key: Buffer | null;

    constructor(options: MfaServiceOptions) {
        this.issuer = options.issuer;
        this.key = options.encryptionKey ? parseEncryptionKey(options.encryptionKey) : null;

        if (options.encryptionKey && !this.key) {
            throw new Error("MFA encryption key must be 32 bytes (64 hex characters or base64).");
        }
    }

    public async generate(accountName: string): Promise<MfaSetup> {
        const secret = base32.encode(crypto.randomBytes(SECRET_BYTES));
        const uri = new TOTP({secret, issuer: this.issuer, label: accountName, ...PLUGINS}).toURI();
        // qrcode is only needed during enrollment; keep it off the startup path.
        const {toDataURL} = await import("qrcode");

        return {secret, uri, qrCode: await toDataURL(uri)};
    }

    /**
     * Returns the matched time step, or null for a wrong token. Steps at or
     * before `lastUsedStep` are rejected (replay protection).
     */
    public verify(token: string, secret: string, lastUsedStep: number | null = null): number | null {
        if (!/^\d{6}$/.test(token)) {
            return null;
        }

        const epoch = Date.now() / 1000;
        // Nothing can be newer than the last used step (otplib rejects such an afterTimeStep).
        if (lastUsedStep !== null && lastUsedStep >= Math.floor(epoch / PERIOD_SECONDS) + 1) {
            return null;
        }

        const result = verifySync({
            secret,
            token,
            epoch,
            // ±30 s around now: exactly the previous, current and next step
            epochTolerance: PERIOD_SECONDS,
            ...(lastUsedStep !== null ? {afterTimeStep: lastUsedStep} : {}),
            ...PLUGINS,
        });

        return result.valid ? result.timeStep : null;
    }

    /** The value to store for a base32 secret (encrypted when a key is configured). */
    public sealSecret(secret: string): string {
        return this.key ? seal(secret, this.key) : secret;
    }

    /**
     * The base32 secret of a stored value. Values without the sealed prefix
     * are plaintext: written while no encryption key was configured.
     */
    public openSecret(stored: string): string {
        if (!isSealed(stored)) {
            return stored;
        }

        if (!this.key) {
            throw new Error("A stored TOTP secret is encrypted but no OTP encryption key is configured (security.otpEncryptionKey / OTP_ENCRYPTION_KEY).");
        }

        return open(stored, this.key);
    }

    /** True when a stored value is plaintext although a key is configured (re-seal it on the next write). */
    public needsReseal(stored: string): boolean {
        return this.key !== null && !isSealed(stored);
    }
}
