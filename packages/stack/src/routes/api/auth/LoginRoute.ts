import {BaseRoute} from "@server/routes/BaseRoute";
import {sendError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";
import {respond} from "@server/libs/utils/helpers";
import {Dependencies} from "@server/libs/Dependencies";
import {authCredentialsSchema, otpTokenSchema} from "@server/libs/security/validation";
import {rateLimitClientKey} from "@server/libs/security/clientIp";
import {checkRateLimit, rejectBearer} from "@server/libs/security/routeGuards";
import {LoginDeviceTrust} from "@server/libs/security/LoginDeviceTrust";
import {UserAuthState, UserStatusType} from "@shared/types/user";

export class LoginRoute extends BaseRoute {

    constructor(dependencies: Dependencies) {
        super("/auth/login", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        const devices = new LoginDeviceTrust(this.dependencies.config);

        // A new login always replaces a pending MFA login or setup of the session (no dead-ends).
        this.post("/", authCredentialsSchema, async (req, res, {username, password}) => {
            rejectBearer(req);
            // IPv6 per /56: an attacker can't multiply the per-IP budget by rotating /64s
            const ip = rateLimitClientKey(req, 56);
            const trustedDevice = devices.trustedDevice(req, username);
            const limit = await this.dependencies.authRateLimiter.consumeLogin(ip, username, trustedDevice);

            if (!checkRateLimit(res, limit, "login attempts")) {
                return;
            }

            const result = await this.authService.login(req, username, password);

            if (result.authState !== UserAuthState.LOGIN) {
                await this.dependencies.authRateLimiter.loginSucceeded(ip, username, trustedDevice);
            }

            if (result.user) {
                devices.remember(req, res, result.user.username);
            }

            return respond<UserStatusType>(res, 200, "success", "Login processed", result);
        });

        this.post("/verify", otpTokenSchema, async (req, res, {token}) => {
            rejectBearer(req);

            const pending = this.authService.pendingMfa(req);
            if (!pending) {
                return sendError(res, 401, "No MFA verification pending", {code: ErrorCode.MFA_NOT_PENDING});
            }

            const ip = rateLimitClientKey(req);
            if (!checkRateLimit(res, await this.dependencies.authRateLimiter.consumeOtp(ip, pending.userId), "MFA attempts")) {
                return;
            }

            const result = await this.authService.verifyMfa(req, token);
            if (result.user) {
                await this.dependencies.authRateLimiter.otpSucceeded(ip, result.user.id);
                devices.remember(req, res, result.user.username);
            }

            return respond<UserStatusType>(res, 200, "success", "MFA verification processed", result);
        });
    }
}
