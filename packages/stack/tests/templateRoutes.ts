// The scaffolded app's API routes (create-toto-app/template/server/routes:
// users, notifications, status). The test servers mount them like the
// template's server/index.ts does, so the suite covers the stack together
// with the routes every new app starts with. Their "toto-stack" imports
// resolve to src/ here (vitest.config.ts, tsconfig.json).
import type {RouteClass} from "toto-stack";
import {routes} from "../../create-toto-app/template/server/routes";

export const templateRoutes: readonly RouteClass[] = routes;

/** The template's routes followed by the given ones. */
export const withTemplateRoutes = (routes: readonly RouteClass[] = []): RouteClass[] => [...templateRoutes, ...routes];
