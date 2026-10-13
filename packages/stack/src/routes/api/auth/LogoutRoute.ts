import { BaseRoute } from "@server/routes/BaseRoute";
import {respond} from "@server/libs/utils/helpers";
import {Dependencies} from "@server/libs/Dependencies";
import {noPayloadSchema} from "@server/libs/security/validation";
import {rejectBearer} from "@server/libs/security/routeGuards";
import {UserStatusType} from "@shared/types/user";

export class LogoutRoute extends BaseRoute {

    constructor(dependencies: Dependencies) {
        super("/auth/logout", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        // Ends any session state: a login, a pending MFA login or a setup in progress. Idempotent.
        this.post("/", noPayloadSchema, async (req, res) => {
            rejectBearer(req);

            const result = await this.authService.logout(req, res);
            return respond<UserStatusType>(res, 200, "success", "Logout successful", result);
        });
    }
}
