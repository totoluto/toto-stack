import {AsyncLocalStorage} from "node:async_hooks";
import crypto from "node:crypto";
import {NextFunction, Request, Response} from "express";

type RequestContext = {
    requestId: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** Returns the id of the request currently being handled, if any. */
export function getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
}

/**
 * Assigns every request a unique id, exposes it via getRequestId() for
 * logging, and echoes it back in the X-Request-Id response header.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    storage.run({requestId}, next);
}
