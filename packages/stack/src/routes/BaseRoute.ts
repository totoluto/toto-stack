import {NextFunction, Request, RequestHandler, Response, Router} from "express";
import type {z} from "zod";
import {hasAnyRole, Role} from "@shared/roles";
import {SessionUserType} from "@shared/types/user";
import {Dependencies} from "@server/libs/Dependencies";
import {AuthService} from "@server/libs/security/AuthService";
import {AppError, sendError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";

export type RouteOptions = {
    /** Require an authenticated user (session or Bearer API key). Default: true. */
    auth?: boolean;
    /**
     * The user needs at least one of these roles (see hasAnyRole: owner
     * satisfies everything, admin everything but owner). Default: [] = any
     * authenticated user. Ignored when `auth` is false.
     */
    roles?: readonly Role[];
};

export type RouteHandler = (req: Request, res: Response) => unknown;
export type BodyRouteHandler<TBody> = (req: Request, res: Response, body: TBody) => unknown;

/**
 * Base class for API routes, mounted under /api/<path>.
 *
 * Endpoints are declared in registerRoutes(), which runs when the router is
 * first requested (after the subclass constructor, so subclass fields are
 * initialised). Every endpoint requires authentication unless the route or
 * the endpoint passes `{auth: false}`; endpoint options override the route's.
 * Errors thrown (or rejected) by handlers reach the stack's error handler.
 */
export abstract class BaseRoute {
    private readonly router = Router();
    private registered = false;

    /**
     * @param path - Mount path below /api, e.g. "/auth/login"
     * @param dependencies - The server's dependencies (passed to the route constructor)
     * @param options - Default auth/role requirements for every endpoint of this route
     */
    protected constructor(
        public readonly path: string,
        protected readonly dependencies: Dependencies,
        private readonly options: RouteOptions = {},
    ) {}

    /** Declare the endpoints with this.get/post/put/patch/delete. */
    protected abstract registerRoutes(): void;

    public getRouter(): Router {
        if (!this.registered) {
            this.registered = true;
            this.registerRoutes();
        }

        return this.router;
    }

    protected get authService(): AuthService {
        return this.dependencies.authService;
    }

    /** The authenticated user of a request on an authenticated endpoint (401 otherwise). */
    protected currentUser(req: Request): SessionUserType {
        if (!req.user) {
            throw new AppError(401, "Unauthorized access.", {code: ErrorCode.UNAUTHORIZED});
        }

        return req.user;
    }

    protected get(path: string, handler: RouteHandler, options?: RouteOptions): void {
        this.router.get(path, ...this.guards(options), wrap(handler));
    }

    protected delete(path: string, handler: RouteHandler, options?: RouteOptions): void {
        this.router.delete(path, ...this.guards(options), wrap(handler));
    }

    /** POST with a zod-validated body (400 with `details` when invalid). */
    protected post<TBody>(path: string, bodySchema: z.ZodType<TBody>, handler: BodyRouteHandler<TBody>, options?: RouteOptions): void {
        this.router.post(path, ...this.guards(options), withBody(bodySchema, handler));
    }

    /** PUT with a zod-validated body. */
    protected put<TBody>(path: string, bodySchema: z.ZodType<TBody>, handler: BodyRouteHandler<TBody>, options?: RouteOptions): void {
        this.router.put(path, ...this.guards(options), withBody(bodySchema, handler));
    }

    /** PATCH with a zod-validated body. */
    protected patch<TBody>(path: string, bodySchema: z.ZodType<TBody>, handler: BodyRouteHandler<TBody>, options?: RouteOptions): void {
        this.router.patch(path, ...this.guards(options), withBody(bodySchema, handler));
    }

    private guards(endpointOptions?: RouteOptions): RequestHandler[] {
        const auth = endpointOptions?.auth ?? this.options.auth ?? true;
        if (!auth) {
            return [];
        }

        const roles = endpointOptions?.roles ?? this.options.roles ?? [];
        const authenticate = async (req: Request, res: Response, next: NextFunction) => {
            const user = await this.authService.authenticate(req);
            if (!user) {
                return sendError(res, 401, "Unauthorized access.", {code: ErrorCode.UNAUTHORIZED});
            }

            req.user = user;

            if (!hasAnyRole(user.roles, roles)) {
                return sendError(res, 403, "Missing permissions", {code: ErrorCode.FORBIDDEN});
            }

            next();
        };

        return [authenticate];
    }
}

function wrap(handler: RouteHandler): RequestHandler {
    return async (req, res) => {
        await handler(req, res);
    };
}

function withBody<TBody>(schema: z.ZodType<TBody>, handler: BodyRouteHandler<TBody>): RequestHandler {
    return async (req, res) => {
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            sendError(res, 400, "Invalid request payload.", {
                code: ErrorCode.VALIDATION_FAILED,
                details: parsed.error.issues.map(issue => ({path: issue.path.map(String).join("."), message: issue.message})),
            });
            return;
        }

        await handler(req, res, parsed.data);
    };
}
