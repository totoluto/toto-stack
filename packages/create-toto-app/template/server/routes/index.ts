import type {RouteClass} from "toto-stack";
import {StatusRoute} from "./StatusRoute";
import {UsersRoute} from "./UsersRoute";
import {NotificationRoute} from "./NotificationRoute";

/**
 * The app's API routes, mounted under /api by createServer({routes}) in
 * server/index.ts. They are yours: edit, remove or add routes here.
 *
 * The stack itself only provides what the sign-in flow and the account's
 * security need (/api/auth/*, /api/account/*) and /api/health. It mounts
 * those first, so don't reuse their paths.
 */
export const routes: RouteClass[] = [
    StatusRoute,
    UsersRoute,
    NotificationRoute,
];
