import "express-session";
import type {SessionUserType} from "../shared/types/user";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** The authenticated user; set on endpoints that require authentication. */
            user?: SessionUserType;
        }
    }
}

declare module "express-session" {
    interface SessionData {
        userId?: SessionUserType['id']
        username?: string;
        roles?: SessionUserType['roles'];
        /** Sign-in time (epoch ms; login, MFA completion or setup). The absolute session lifetime counts from here. */
        authenticatedAt?: number;

        ipAddress?: string;
        userAgent?: string;

        csrfToken?: string;

        /** Password verified, waiting for the TOTP code (epoch-ms expiry). */
        otp?: {
            userId: SessionUserType['id'];
            expiresAt: number;
            /** Fingerprint of the password hash the login was verified against. */
            credential: string;
        };

        /** First-run setup in progress (epoch-ms expiry; bound to the setup token's fingerprint). */
        setup?: {
            username: string;
            passwordHash: string;
            secret: string;
            tokenFingerprint: string;
            expiresAt: number;
        };

        /** MFA enrollment of the signed-in user in progress (epoch-ms expiry). */
        mfaSetup?: {
            secret: string;
            expiresAt: number;
        };
    }
}

export {};
