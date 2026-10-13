import {BaseRoute, respond, type Dependencies} from "toto-stack";

/**
 * GET /api/status: unauthenticated liveness check. A minimal example of a
 * public route ({auth: false}). For readiness (database included), use the
 * stack's GET /api/health, which the Docker healthcheck calls.
 */
export class StatusRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/status", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        this.get("/", (_req, res) => {
            return respond(res, 200, "success", "Server is up and running");
        });
    }
}
