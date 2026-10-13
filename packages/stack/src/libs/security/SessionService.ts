import type {CookieOptions, Request, RequestHandler, Response} from "express";
import session, {type SessionData} from "express-session";
import type {SessionUserType} from "@shared/types/user";
import type {ResolvedStackConfig} from "@server/libs/config/StackConfig";
import type {SessionStore} from "@server/libs/SessionStore";
import type {StackSessionUser} from "@server/libs/prisma/StackPrismaClient";
import {truncateUserAgent} from "@server/libs/security/userAgent";
import {Logger} from "@server/libs/Logger";

/** The attributes of the session cookie (everything but its value and expiry). */
export type SessionCookieOptions = Readonly<Required<Pick<CookieOptions, "httpOnly" | "sameSite" | "secure" | "path">>>;

/**
 * The session cookie and the session lifecycle: sign-in (`establish`),
 * id regeneration, logout, and the absolute lifetime check.
 *
 * Single source of the cookie name and options. In production (`secure`)
 * the cookie is `__Host-<session.cookieName>`: browsers then only accept it
 * over HTTPS, for Path=/ and without a Domain, so no other (sub)domain or
 * plain-HTTP response can set or overwrite it. In development (plain HTTP
 * on localhost) the prefix would make browsers drop the cookie, so the name
 * has no prefix.
 */
export class SessionService {
    /** The effective cookie name. */
    public readonly cookieName: string;
    public readonly cookieOptions: SessionCookieOptions;

    private handler?: RequestHandler;
    private readonly logger = new Logger("Session");
    private proxyWarningLogged = false;

    constructor(private readonly config: ResolvedStackConfig, private readonly store: SessionStore) {
        const secure = !config.isDev;
        this.cookieName = `${secure ? "__Host-" : ""}${config.session.cookieName}`;
        this.cookieOptions = {httpOnly: true, sameSite: "lax", secure, path: "/"};
    }

    /**
     * The express-session middleware (one instance per server). The stack
     * mounts it on /api; apps can reuse it, e.g. to read the session of a
     * websocket handshake.
     */
    public middleware(): RequestHandler {
        this.handler ??= this.withProxyCheck(session({
            name: this.cookieName,
            secret: this.config.security.sessionSecret,
            store: this.store,
            resave: false,
            saveUninitialized: false,
            // The cookie is re-sent only when the session changes; the store keeps it within the absolute lifetime.
            rolling: false,
            cookie: {...this.cookieOptions, maxAge: this.config.session.absoluteTimeout},
        }));

        return this.handler;
    }

    /**
     * express-session silently drops a Secure cookie when `req.secure` is
     * false. Behind a TLS-terminating proxy that Express doesn't trust, a
     * login then "succeeds" without a cookie. Warn once, clearly.
     */
    private withProxyCheck(sessionMiddleware: RequestHandler): RequestHandler {
        if (!this.cookieOptions.secure) {
            return sessionMiddleware;
        }

        return (req, res, next) => {
            if (!this.proxyWarningLogged && !req.secure && forwardedProto(req) === "https") {
                this.proxyWarningLogged = true;
                this.logger.warn(
                    "A request arrived through an HTTPS proxy (X-Forwarded-Proto: https), but the proxy is not trusted, so "
                    + "req.secure is false and the Secure session cookie is never set: logins appear to succeed but don't stick. "
                    + "Set TRUST_PROXY=1 (or the number of proxy hops in front of the app; config http.trustProxy).",
                );
            }

            sessionMiddleware(req, res, next);
        };
    }

    /** Signs the user in on a fresh session id (login, MFA completion, setup). Starts the absolute lifetime. */
    public async establish(req: Request, user: SessionUserType): Promise<void> {
        await this.regenerate(req);

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.roles = user.roles;
        req.session.authenticatedAt = Date.now();
        req.session.ipAddress = req.ip;
        req.session.userAgent = truncateUserAgent(req.headers["user-agent"]);
    }

    /** Replaces the session with an empty one under a new id (the old row is deleted). */
    public regenerate(req: Request): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            req.session.regenerate(error => (error ? reject(error) : resolve()));
        });
    }

    /** Deletes the session and, when a response is given, clears the cookie (same name and attributes). */
    public destroy(req: Request, res?: Response): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            req.session.destroy(error => {
                if (error) {
                    reject(error);
                    return;
                }

                res?.clearCookie(this.cookieName, this.cookieOptions);
                resolve();
            });
        });
    }

    /**
     * Whether a signed-in session is within its absolute lifetime, counted
     * from its sign-in time (`authenticatedAt`, set at every sign-in).
     */
    public isWithinLifetime(data: SessionData): boolean {
        const {authenticatedAt} = data;
        return typeof authenticatedAt === "number" && authenticatedAt + this.config.session.absoluteTimeout > Date.now();
    }

    /** The user loaded together with this request's session (see SessionStore.loadedUser). */
    public loadedUser(req: Request): StackSessionUser | null | undefined {
        return this.store.loadedUser(req.session);
    }
}

/** The first (client-facing) value of X-Forwarded-Proto, lower-cased. */
function forwardedProto(req: Request): string | undefined {
    const header = req.headers["x-forwarded-proto"];
    const value = Array.isArray(header) ? header[0] : header;
    return value?.split(",")[0].trim().toLowerCase();
}
