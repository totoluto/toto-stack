import express, {Router, type Response as ExpressResponse} from "express";
import path from "node:path";
import {BaseRoute} from "@server/routes/BaseRoute";
import {HealthRoute} from "@server/routes/api/status/HealthRoute";
import {LoginRoute} from "@server/routes/api/auth/LoginRoute";
import {MeRoute} from "@server/routes/api/auth/MeRoute";
import {SetupRoute} from "@server/routes/api/auth/SetupRoute";
import {LogoutRoute} from "@server/routes/api/auth/LogoutRoute";
import {Dependencies} from "@server/libs/Dependencies";
import {CsrfRoute} from "@server/routes/api/auth/CsrfRoute";
import {AccountRoute} from "@server/routes/api/account/AccountRoute";
import {notFoundHandler, sendError} from "@server/libs/ErrorHandler";
import {ErrorCode} from "@shared/errorCodes";
import type {FrontendConfig} from "@server/libs/config/StackConfig";

/** A BaseRoute subclass; instantiated once per server with its dependencies. */
export type RouteClass = new (dependencies: Dependencies) => BaseRoute;

/** Built-in API routes that don't use the session (mounted before the session middleware). */
const SESSIONLESS_ROUTES: RouteClass[] = [HealthRoute];

/**
 * The built-in session-based API routes: the sign-in flow (/auth) and the
 * signed-in user's own credentials (/account). Everything else (user
 * management, notifications, status, ...) is app code passed in `routes`;
 * the scaffolded app ships those in server/routes.
 */
const BUILTIN_ROUTES: RouteClass[] = [
    LoginRoute,
    LogoutRoute,
    CsrfRoute,
    MeRoute,
    SetupRoute,
    AccountRoute,
];

/** /api/health: no session lookup, so health checks never touch the session table. Other paths fall through. */
export function registerSessionlessApiRoutes(dependencies: Dependencies): Router {
    const router = Router();

    for (const RouteClass of SESSIONLESS_ROUTES) {
        const route = new RouteClass(dependencies);
        router.use(route.path, route.getRouter());
    }

    return router;
}

export function registerApiRoutes(dependencies: Dependencies, extraRoutes: RouteClass[] = []): Router {
    const router = Router();

    for (const RouteClass of [...BUILTIN_ROUTES, ...extraRoutes]) {
        const route = new RouteClass(dependencies);
        router.use(route.path, route.getRouter());
    }

    router.use((_req, res) => {
        sendError(res, 404, "API endpoint does not exist", {code: ErrorCode.NOT_FOUND});
    });

    return router;
}

/** Vite's output directory for content-hashed files (inside `frontend.dir`). */
const HASHED_ASSETS_DIR = "assets";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Serves the built SPA from `frontend.dir`, falling back to index.html for
 * client-side routes. Mounted before the session middleware, so static
 * requests never touch the session store.
 *
 * Caching:
 * - `/assets/*` (Vite's content-hashed output) is `public, max-age=31536000,
 *   immutable`. Only put content-hashed files there. A missing asset is a
 *   404, not index.html (a stale chunk must fail loudly, not as HTML).
 * - index.html (also as the SPA fallback) is `no-cache`, so a deploy is
 *   picked up on the next navigation.
 * - Other files keep the default (`public, max-age=0` + ETag revalidation).
 *
 * Compression is left to the reverse proxy (e.g. Traefik's compress middleware).
 */
export function registerFrontendRoutes(frontend: FrontendConfig): Router {
    const router = Router();
    const indexFile = path.join(frontend.dir, "index.html");
    const noCacheForIndex = (res: ExpressResponse, file: string) => {
        if (file === indexFile) res.setHeader("Cache-Control", "no-cache");
    };

    // API paths are never served from here (unknown ones get the API's JSON 404).
    router.use((req, _res, next) => {
        next(req.path === "/api" || req.path.startsWith("/api/") ? "router" : undefined);
    });

    router.use(`/${HASHED_ASSETS_DIR}`, express.static(path.join(frontend.dir, HASHED_ASSETS_DIR), {
        immutable: true,
        maxAge: ONE_YEAR_MS,
        index: false,
        redirect: false,
    }), notFoundHandler);

    router.use(express.static(frontend.dir, {setHeaders: noCacheForIndex}));
    router.get("*path", (_req, res, next) => {
        res.sendFile(indexFile, {cacheControl: false, headers: {"Cache-Control": "no-cache"}}, err => {
            if (err) next(err);
        });
    });

    return router;
}
