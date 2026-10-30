import type {RouteClass} from "toto-stack";
import {StatusRoute} from "./StatusRoute";
import {NotificationRoute} from "./NotificationRoute";

/**
 * The app's API routes, mounted under /api by createServer({routes}) in
 * server/index.ts. They are yours: edit, remove or add routes here.
 *
 * The stack provides auth (/api/auth/*), account security (/api/account/*),
 * user management (/api/users) and /api/health. It mounts those first,
 * so don't reuse their paths.
 */
export const routes: RouteClass[] = [
    StatusRoute,
    NotificationRoute,
];
