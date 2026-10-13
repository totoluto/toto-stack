import {BaseRoute} from "@server/routes/BaseRoute";
import {respond} from "@server/libs/utils/helpers";
import {Dependencies} from "@server/libs/Dependencies";
import {rateLimitClientKey} from "@server/libs/security/clientIp";
import {checkRateLimit} from "@server/libs/security/routeGuards";

/**
 * GET /api/auth/csrf: a CSRF token for the X-CSRF-Token header. Anonymous
 * visitors get a stateless token (no session row is written); authenticated
 * sessions get their session-bound token. See RequestSecurity.
 */
export class CsrfRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/auth/csrf", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        this.get("/", async (req, res) => {
            if (!checkRateLimit(res, await this.dependencies.authRateLimiter.consumeCsrf(rateLimitClientKey(req)), "CSRF token requests")) {
                return;
            }

            return respond(res, 200, "success", "CSRF token created", {
                token: this.dependencies.requestSecurity.getCsrfToken(req, res),
            });
        });
    }
}
