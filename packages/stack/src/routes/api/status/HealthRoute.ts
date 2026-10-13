import {BaseRoute} from "@server/routes/BaseRoute";
import {Dependencies} from "@server/libs/Dependencies";

/**
 * Unauthenticated health endpoint for load balancers / uptime monitors.
 * Reports process uptime and database connectivity (503 when the DB is down).
 * Deliberately NOT the WebResponse envelope: `{status: "ok" | "degraded",
 * uptimeSeconds, db: "ok" | "down"}` is what health checkers expect.
 */
export class HealthRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/health", dependencies, {auth: false});
    }

    protected registerRoutes(): void {
        this.get("/", async (_req, res) => {
            const health = {
                status: "ok",
                uptimeSeconds: Math.floor(process.uptime()),
                db: "ok",
            };

            try {
                await this.dependencies.prisma.$queryRaw`SELECT 1`;
            } catch {
                health.status = "degraded";
                health.db = "down";
            }

            return res.status(health.db === "ok" ? 200 : 503).json(health);
        });
    }
}
