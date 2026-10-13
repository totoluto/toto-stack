import {BaseRoute} from "@server/routes/BaseRoute";
import {sendError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";
import {respond} from "@server/libs/utils/helpers";
import {UserAuthState, UserStatusType} from "@shared/types/user";
import {AuthService} from "@server/libs/security/AuthService";
import {Dependencies} from "@server/libs/Dependencies";
import {otpTokenSchema, setupStartSchema} from "@server/libs/security/validation";
import {rateLimitClientKey} from "@server/libs/security/clientIp";
import {checkRateLimit, rejectBearer} from "@server/libs/security/routeGuards";
import {LoginDeviceTrust} from "@server/libs/security/LoginDeviceTrust";

/**
 * First-run owner setup: POST /start {username, password, setupToken}
 * returns a TOTP enrollment; POST /verify {token} creates the owner
 * (atomically, at most one) and logs it in.
 *
 * The pending setup (username, password hash, TOTP secret, token
 * fingerprint) lives in the session for at most 10 minutes; the session id
 * is regenerated on start and on completion, which deletes it.
 */
export class SetupRoute extends BaseRoute {

    constructor(dependencies: Dependencies) {
        super("/auth/setup", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        const {setupService, authRateLimiter, mfaService, userService, sessionService} = this.dependencies;
        const devices = new LoginDeviceTrust(this.dependencies.config);

        this.post("/start", setupStartSchema, async (req, res, {username, password, setupToken}) => {
            rejectBearer(req);

            if (await setupService.isComplete()) {
                return sendError(res, 403, "Setup already completed.", {code: ErrorCode.SETUP_COMPLETED});
            }

            const ip = rateLimitClientKey(req, 56);
            if (!checkRateLimit(res, await authRateLimiter.consumeSetup(ip), "setup attempts")) {
                return;
            }

            const fingerprint = setupService.tokenFingerprint();
            if (!fingerprint || !setupService.verifyToken(setupToken)) {
                return sendError(res, 403, "Invalid setup token.", {code: ErrorCode.SETUP_TOKEN_INVALID});
            }

            await authRateLimiter.setupTokenAccepted(ip);

            const {qrCode, secret} = await mfaService.generate(username);
            const passwordHash = await userService.hashPassword(password);

            await sessionService.regenerate(req);
            // One timestamp for the cookie and the deadline (setting maxAge would read the clock again).
            const expiresAt = Date.now() + AuthService.OTP_MAX_AGE;
            req.session.cookie.expires = new Date(expiresAt);
            req.session.setup = {
                username,
                passwordHash,
                secret,
                tokenFingerprint: fingerprint,
                expiresAt,
            };

            return respond<{authState: string; qrCode: string; key: string}>(res, 200, "success", "Setup started", {
                authState: UserAuthState.SETUP_VERIFY,
                qrCode,
                key: secret,
            });
        });

        this.post("/verify", otpTokenSchema, async (req, res, {token}) => {
            rejectBearer(req);

            const setup = req.session.setup;
            if (!setup || !(setup.expiresAt > Date.now())) {
                delete req.session.setup;
                return sendError(res, 400, "No setup in progress.", {code: ErrorCode.SETUP_NOT_STARTED});
            }

            if (await setupService.isComplete()) {
                delete req.session.setup;
                return sendError(res, 403, "Setup already completed.", {code: ErrorCode.SETUP_COMPLETED});
            }

            if (!setupService.fingerprintMatches(setup.tokenFingerprint)) {
                delete req.session.setup;
                return sendError(res, 403, "The setup token changed; start the setup again.", {code: ErrorCode.SETUP_TOKEN_CHANGED});
            }

            const ip = rateLimitClientKey(req);
            if (!checkRateLimit(res, await authRateLimiter.consumeSetupOtp(ip), "OTP attempts")) {
                return;
            }

            const step = mfaService.verify(token, setup.secret);
            if (step === null) {
                return respond<UserStatusType>(res, 200, "success", "Setup verification failed", {
                    user: null,
                    authState: UserAuthState.SETUP_VERIFY,
                });
            }

            const owner = await setupService.completeSetup({
                username: setup.username,
                passwordHash: setup.passwordHash,
                otpSecret: mfaService.sealSecret(setup.secret),
                otpLastUsedStep: step,
            });

            if (!owner) {
                delete req.session.setup;
                return sendError(res, 403, "Setup already completed.", {code: ErrorCode.SETUP_COMPLETED});
            }

            const user = {id: owner.id, username: owner.username, roles: owner.roles.map(userRole => userRole.role.name)};
            // Regenerating drops the pending setup (password hash and secret) with the old session.
            await sessionService.establish(req, user);
            devices.remember(req, res, user.username);

            return respond<UserStatusType>(res, 200, "success", "Setup completed", {
                user,
                authState: UserAuthState.AUTHENTICATED,
            });
        });
    }
}
