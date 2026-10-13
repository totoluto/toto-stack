import {BaseRoute, ErrorCode, respond, Role, sendError, sendNotificationSchema, type Dependencies} from "toto-stack";

/**
 * /api/notifications: lets admins and owners send a notification through the
 * handlers configured with createServer({notifications: {handlers}}).
 *
 * Answers honestly: 200 only when at least one handler delivered (with each
 * handler's ok flag), 502 when all failed, 503 when none is configured.
 * Remote error details (which may contain tokens or URLs) are logged by the
 * notification service and never returned to the client.
 */
export class NotificationRoute extends BaseRoute {
    constructor(dependencies: Dependencies) {
        super("/notifications", dependencies, {roles: [Role.ADMIN]});
    }

    protected registerRoutes(): void {
        const {notificationService} = this.dependencies;

        this.post("/send", sendNotificationSchema, async (_req, res, {title, message, handlers, metadata}) => {
            if (handlers && handlers.length > 0) {
                const unknown = handlers.filter(id => !notificationService.hasHandler(id));
                if (unknown.length > 0) {
                    return sendError(res, 400, "Unknown notification handler.", {code: ErrorCode.UNKNOWN_HANDLER, details: {unknown}});
                }
            } else if (notificationService.listHandlers().length === 0) {
                return sendError(res, 503, "No notification handlers are configured.", {code: ErrorCode.NO_HANDLERS});
            }

            const payload = {title, message, metadata, timestamp: new Date()};
            const outcome = handlers && handlers.length > 0
                ? await notificationService.sendToHandlers(handlers, payload)
                : await notificationService.sendToAll(payload);

            // Only the handler id and its ok flag: never the remote error.
            const results = outcome.results.map(result => ({handler: result.handler, ok: result.ok}));

            if (outcome.delivered === 0) {
                return sendError(res, 502, "The notification could not be delivered.", {code: ErrorCode.DELIVERY_FAILED, details: {results}});
            }

            const summary = outcome.failed === 0
                ? "Notification sent."
                : `Notification sent to ${outcome.delivered} of ${results.length} handlers.`;
            return respond(res, 200, "success", summary, {delivered: outcome.delivered, failed: outcome.failed, results});
        });

        this.get("/handlers", (_req, res) => {
            return respond(res, 200, "success", "Handlers retrieved", {handlers: notificationService.listHandlers()});
        });
    }
}
