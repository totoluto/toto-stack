import {BaseRoute} from "@server/routes/BaseRoute";
import {sendError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";
import {respond} from "@server/libs/utils/helpers";
import {Dependencies} from "@server/libs/Dependencies";
import {AuthService} from "@server/libs/security/AuthService";
import {changePasswordSchema, mfaDisableSchema, otpTokenSchema, passwordConfirmSchema} from "@server/libs/security/validation";
import {rateLimitClientKey} from "@server/libs/security/clientIp";
import {checkRateLimit, rejectBearer} from "@server/libs/security/routeGuards";
import {PrismaUserType} from "@shared/types/user";
import {Request, Response} from "express";

/**
 * The signed-in user's own credentials. Every sensitive change requires the
 * current password (rate-limited per account and IP, since each check costs
 * a full password hash). Password and MFA changes sign out the user's other
 * sessions.
 */
export class AccountRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/account", dependencies);
    }

    protected registerRoutes(): void {
        const {userService, mfaService, authRateLimiter} = this.dependencies;

        // Changing the password also revokes the API key and every other session.
        this.post("/password", changePasswordSchema, async (req, res, {currentPassword, newPassword}) => {
            const user = await this.requirePasswordConfirmed(req, res, currentPassword);
            if (!user) return;

            await userService.updatePassword(user.id, newPassword);
            await userService.revokeOtherSessions(user.id, req.sessionID);

            return respond(res, 200, "success", "Password updated");
        });

        // Issues a new API key (replacing the previous one). The plaintext is only in this response.
        this.post("/api-key", passwordConfirmSchema, async (req, res, {password}) => {
            const user = await this.requirePasswordConfirmed(req, res, password);
            if (!user) return;

            const apiKey = await userService.issueApiKey(user.id);
            return respond(res, 200, "success", "API key issued", {apiKey});
        });

        this.delete("/api-key", async (req, res) => {
            await userService.revokeApiKey(this.currentUser(req).id);
            return respond(res, 200, "success", "API key revoked");
        });

        // Enrollment state lives in the session, so these two need a session (no Bearer).
        this.post("/mfa/start", passwordConfirmSchema, async (req, res, {password}) => {
            rejectBearer(req);
            const user = await this.requirePasswordConfirmed(req, res, password);
            if (!user) return;

            if (user.otpEnabled) {
                return sendError(res, 409, "MFA is already enabled.", {code: ErrorCode.MFA_ALREADY_ENABLED});
            }

            const {secret, qrCode} = await mfaService.generate(user.username);
            req.session.mfaSetup = {secret, expiresAt: Date.now() + AuthService.OTP_MAX_AGE};

            return respond(res, 200, "success", "MFA enrollment started", {qrCode, key: secret});
        });

        this.post("/mfa/verify", otpTokenSchema, async (req, res, {token}) => {
            rejectBearer(req);
            const {id: userId} = this.currentUser(req);
            const pending = req.session.mfaSetup;
            if (!pending || !(pending.expiresAt > Date.now())) {
                delete req.session.mfaSetup;
                return sendError(res, 400, "No MFA enrollment in progress.", {code: ErrorCode.MFA_ENROLLMENT_NOT_STARTED});
            }

            const ip = rateLimitClientKey(req);
            if (!checkRateLimit(res, await authRateLimiter.consumeOtp(ip, userId), "MFA attempts")) {
                return;
            }

            const step = mfaService.verify(token, pending.secret);
            if (step === null) {
                return sendError(res, 400, "Invalid MFA token.", {code: ErrorCode.MFA_INVALID});
            }

            delete req.session.mfaSetup;
            if (!(await userService.enableMfa(userId, mfaService.sealSecret(pending.secret), step))) {
                return sendError(res, 409, "MFA is already enabled.", {code: ErrorCode.MFA_ALREADY_ENABLED});
            }

            await authRateLimiter.otpSucceeded(ip, userId);
            // Sessions established without the second factor end now.
            await userService.revokeOtherSessions(userId, req.sessionID);

            return respond(res, 200, "success", "MFA enabled");
        });

        this.post("/mfa/disable", mfaDisableSchema, async (req, res, {password, token}) => {
            const user = await this.requirePasswordConfirmed(req, res, password);
            if (!user) return;

            if (!user.otpEnabled || !user.otpSecret) {
                return sendError(res, 409, "MFA is not enabled.", {code: ErrorCode.MFA_NOT_ENABLED});
            }

            const ip = rateLimitClientKey(req);
            if (!checkRateLimit(res, await authRateLimiter.consumeOtp(ip, user.id), "MFA attempts")) {
                return;
            }

            if (!(await this.authService.verifyUserOtp(user, token))) {
                return sendError(res, 400, "Invalid MFA token.", {code: ErrorCode.MFA_INVALID});
            }

            await userService.disableMfa(user.id);
            await authRateLimiter.otpSucceeded(ip, user.id);
            await userService.revokeOtherSessions(user.id, req.sessionID);

            return respond(res, 200, "success", "MFA disabled");
        });
    }

    /**
     * Re-authenticates a sensitive operation with the current password
     * (rate-limited: every attempt costs a password hash). Responds 429/403
     * and returns null on failure.
     */
    private async requirePasswordConfirmed(req: Request, res: Response, password: string): Promise<PrismaUserType | null> {
        const {id} = this.currentUser(req);
        const limit = await this.dependencies.authRateLimiter.consumeReauth(rateLimitClientKey(req), id);
        if (!checkRateLimit(res, limit, "password confirmations")) {
            return null;
        }

        const user = await this.dependencies.userService.getById(id);
        if (!user || !(await this.dependencies.userService.verifyPassword(user, password))) {
            sendError(res, 403, "Password confirmation failed.", {code: ErrorCode.PASSWORD_CONFIRMATION_FAILED});
            return null;
        }

        return user;
    }
}
