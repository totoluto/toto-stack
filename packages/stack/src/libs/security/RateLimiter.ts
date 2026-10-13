import {NextFunction, Request, Response} from "express";
import {Logger} from "@server/libs/Logger";
import {sendError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";
import {MemoryRateLimitStore} from "@server/libs/security/RateLimitStore";
import {rateLimitClientKey} from "@server/libs/security/clientIp";

/**
 * Global per-client request limit (a flood guard in front of every route).
 * Clients are keyed by rateLimitClientKey (validated req.ip, honouring
 * `http.trustProxy`). Counters are per process.
 */
export class RateLimiter {
    private readonly store = new MemoryRateLimitStore();
    private readonly logger = new Logger("RateLimiter");

    constructor(
        private readonly windowMs: number = 60 * 1000,
        private readonly maxRequests: number = 100,
    ) {}

    public middleware() {
        return (req: Request, res: Response, next: NextFunction) => {
            const key = rateLimitClientKey(req);
            const {count, resetAt} = this.store.increment(key, this.windowMs);

            res.setHeader("X-RateLimit-Limit", this.maxRequests);
            res.setHeader("X-RateLimit-Remaining", Math.max(0, this.maxRequests - count));
            res.setHeader("X-RateLimit-Reset", new Date(resetAt).toISOString());

            if (count > this.maxRequests) {
                if (count === this.maxRequests + 1) {
                    // Once per client and window, not on every rejected request
                    this.logger.warn(`Rate limit exceeded for ${JSON.stringify(key)} (${this.maxRequests} requests per ${Math.round(this.windowMs / 1000)} s)`);
                }

                res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
                return sendError(res, 429, "Too many requests, please try again later", {code: ErrorCode.RATE_LIMITED});
            }

            next();
        };
    }

    /** Prunes expired counters every minute (unref'd: never keeps the process alive). */
    public startCleanup(): void {
        this.store.start();
    }

    public stopCleanup(): void {
        this.store.stop();
    }
}
