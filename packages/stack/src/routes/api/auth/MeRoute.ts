import {BaseRoute} from "@server/routes/BaseRoute";
import {respond} from "@server/libs/utils/helpers";
import {UserAuthState, UserStatusType} from "@shared/types/user";
import {Dependencies} from "@server/libs/Dependencies";
import {usesBearerAuth} from "@server/libs/security/RequestSecurity";

/**
 * GET /api/auth/me: the auth state of the caller. Only reveals what the SPA
 * needs to pick a screen: setup / setup-verify / otp / login, or the user's
 * id, username and roles. Roles come from the database, not the session.
 * Before setup the "setup" state is public (the SPA shows the setup form),
 * but completing setup requires the setup token.
 */
export class MeRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/auth/me", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        this.get("/", async (req, res) => {
            const bearer = usesBearerAuth(req);

            if (!bearer && !(await this.dependencies.setupService.isComplete())) {
                const setup = req.session.setup;
                const state = setup && setup.expiresAt > Date.now() ? UserAuthState.SETUP_VERIFY : UserAuthState.SETUP;
                return respond<UserStatusType>(res, 200, "success", "Setup required", {user: null, authState: state});
            }

            if (!bearer && this.authService.pendingMfa(req)) {
                return respond<UserStatusType>(res, 200, "success", "MFA verification pending", {
                    user: null,
                    authState: UserAuthState.OTP,
                });
            }

            const user = await this.authService.authenticate(req);
            if (!user) {
                return respond<UserStatusType>(res, 200, "success", "Not authenticated", {
                    user: null,
                    authState: UserAuthState.LOGIN,
                });
            }

            return respond<UserStatusType>(res, 200, "success", "Authenticated", {
                user,
                authState: UserAuthState.AUTHENTICATED,
            });
        });
    }
}
