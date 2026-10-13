import crypto from "node:crypto";
import {PrismaUserType, SessionUserType, UserAuthState, UserStatusType} from "@shared/types/user";
import {Request, Response} from "express";
import {UserService} from "@server/libs/services/UserService";
import type {SessionService} from "@server/libs/security/SessionService";
import type {StackSessionUser} from "@server/libs/prisma/StackPrismaClient";
import MfaService from "@server/libs/security/MfaService";
import {bearerToken} from "@server/libs/security/RequestSecurity";
import {deriveKey} from "@server/libs/security/keys";

/** Pending MFA logins, first-run setup and MFA enrollment expire after 10 minutes. */
const PENDING_TTL_MS = 1000 * 60 * 10;

export class AuthService {
    public static readonly OTP_MAX_AGE = PENDING_TTL_MS;

    private readonly credentialKey: Buffer;

    /** @param sessionSecret - used (via HKDF) to fingerprint the credential a pending MFA login started with */
    public constructor(
        private readonly userService: UserService,
        private readonly mfaService: MfaService,
        private readonly sessionService: SessionService,
        sessionSecret: string,
    ) {
        this.credentialKey = deriveKey(sessionSecret, "pending mfa credential v1");
    }

    /**
     * The authenticated user, freshly loaded from the database (roles included).
     * A request with an `Authorization: Bearer` header is authenticated ONLY by
     * that API key; its session is ignored (so the CSRF exemption for Bearer
     * requests can't be borrowed by a cookie session).
     *
     * A session counts only within its absolute lifetime (from sign-in). Its
     * user is normally joined to the session read (no extra query); only
     * credential-free columns are loaded.
     */
    public async authenticate(req: Request): Promise<SessionUserType | null> {
        const apiKey = bearerToken(req);
        if (apiKey !== null) {
            const user = apiKey ? await this.userService.getByApiKey(apiKey) : null;
            return user ? this.toSessionUser(user) : null;
        }

        const userId = req.session.userId;
        if (!userId || !this.sessionService.isWithinLifetime(req.session)) {
            return null;
        }

        const loaded = this.sessionService.loadedUser(req);
        const user = loaded?.id === userId ? loaded : await this.userService.getSessionUser(userId);
        return user ? this.toSessionUser(user) : null;
    }

    /**
     * Password login. A new login replaces any pending MFA or setup state of
     * the session. Unknown usernames cost the same password-hash work as known
     * ones, and every failure looks the same.
     */
    public async login(req: Request, username: string, password: string): Promise<UserStatusType> {
        this.clearPendingState(req);

        const user = await this.userService.getByUsername(username);
        if (!user) {
            await this.userService.verifyDummyPassword(password);
            return this.loginFailed();
        }

        if (!(await this.userService.verifyPassword(user, password))) {
            return this.loginFailed();
        }

        if (user.otpEnabled && user.otpSecret) {
            // Fresh session id for the pending state (no fixation of a half-authenticated session).
            await this.sessionService.regenerate(req);
            // One timestamp for the cookie and the deadline (setting maxAge would read the clock again).
            const expiresAt = Date.now() + PENDING_TTL_MS;
            req.session.cookie.expires = new Date(expiresAt);
            req.session.otp = {userId: user.id, expiresAt, credential: this.credentialFingerprint(user)};

            return {user: null, authState: UserAuthState.OTP};
        }

        const userSession = this.toSessionUser(user);
        await this.sessionService.establish(req, userSession);

        return {user: userSession, authState: UserAuthState.AUTHENTICATED};
    }

    /** The pending MFA login of the session, or undefined (expired state is removed). */
    public pendingMfa(req: Request): {userId: number; credential: string} | undefined {
        const pending = req.session.otp;
        if (pending && !(pending.expiresAt > Date.now())) {
            delete req.session.otp;
            return undefined;
        }

        return pending;
    }

    public async verifyMfa(req: Request, token: string): Promise<UserStatusType> {
        const pending = this.pendingMfa(req);
        if (!pending) {
            return this.loginFailed();
        }

        // The account changed since the password check (deleted, MFA turned off, or a new password): start over.
        const user = await this.userService.getById(pending.userId);
        if (!user || !user.otpEnabled || !user.otpSecret || !this.sameCredential(pending.credential, user)) {
            await this.sessionService.destroy(req);
            return this.loginFailed();
        }

        if (!(await this.verifyUserOtp(user, token))) {
            return {user: null, authState: UserAuthState.OTP};
        }

        const userSession = this.toSessionUser(user);
        await this.sessionService.establish(req, userSession);

        return {user: userSession, authState: UserAuthState.AUTHENTICATED};
    }

    /**
     * Verifies a TOTP code of a user with MFA enabled (±1 step) and records the
     * step atomically. A code (or an older one) can't be used twice, also not
     * by two concurrent requests.
     */
    public async verifyUserOtp(user: PrismaUserType, token: string): Promise<boolean> {
        if (!user.otpEnabled || !user.otpSecret) {
            return false;
        }

        const secret = this.mfaService.openSecret(user.otpSecret);
        const step = this.mfaService.verify(token, secret, user.otpLastUsedStep);
        if (step === null) {
            return false;
        }

        const reseal = this.mfaService.needsReseal(user.otpSecret) ? this.mfaService.sealSecret(secret) : undefined;
        return this.userService.recordOtpStep(user.id, step, reseal);
    }

    /** Ends the session (also a pending MFA login or setup). Never fails for anonymous visitors. */
    public async logout(req: Request, res: Response): Promise<UserStatusType> {
        const hasState = req.session.userId !== undefined || req.session.otp !== undefined
            || req.session.setup !== undefined || req.session.mfaSetup !== undefined;

        if (hasState) {
            await this.sessionService.destroy(req, res);
        }

        return {user: null, authState: UserAuthState.LOGIN};
    }

    /** Removes pending MFA-login and setup state from the session. */
    public clearPendingState(req: Request): void {
        delete req.session.otp;
        delete req.session.setup;
    }

    /** HMAC of the user's password hash: changes whenever the password does. */
    private credentialFingerprint(user: Pick<PrismaUserType, "id" | "password">): string {
        return crypto.createHmac("sha256", this.credentialKey).update(`${user.id}:${user.password}`).digest("base64url");
    }

    private sameCredential(fingerprint: string | undefined, user: Pick<PrismaUserType, "id" | "password">): boolean {
        const expected = Buffer.from(this.credentialFingerprint(user));
        const actual = Buffer.from(fingerprint ?? "");
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    private loginFailed(): UserStatusType {
        return {user: null, authState: UserAuthState.LOGIN};
    }

    private toSessionUser(user: StackSessionUser): SessionUserType {
        return {
            id: user.id,
            username: user.username,
            roles: user.roles.map(userRole => userRole.role.name),
        };
    }
}
