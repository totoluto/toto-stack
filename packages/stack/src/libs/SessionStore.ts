import net from "node:net";
import type {Request} from "express";
import {Store, type Session, type SessionData} from "express-session";
import {
    SESSION_USER_SELECT,
    type StackJsonObject,
    type StackPrismaClient,
    type StackSessionUser,
} from "@server/libs/prisma/StackPrismaClient";
import {truncateUserAgent} from "@server/libs/security/userAgent";
import {Logger} from "@server/libs/Logger";

/** Lifetime policy of the store (the resolved `session` config). */
export type SessionStoreOptions = {
    /** Max lifetime from sign-in (or, without sign-in, from creation). */
    readonly absoluteTimeout: number;
    /** Max time without a recorded request. */
    readonly idleTimeout: number;
    /** Min time between two activity writes of an unchanged session. */
    readonly touchInterval: number;
};

/** What the store knows about a session row it loaded or created. */
type RowState = {
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
    /** The session's user, joined to the session read (undefined when not loaded). */
    user?: StackSessionUser | null;
    /** The row was deleted (destroyed, revoked or cleaned up) while this request held the session. */
    gone?: boolean;
};

type Callback<T = void> = (err: unknown, value?: T) => void;

/** Longest textual IP address (IPv6 with an embedded IPv4 part) plus a zone index. */
const IP_ADDRESS_MAX_LENGTH = 64;

const SESSION_LOAD_SELECT = {
    data: true,
    createdAt: true,
    lastSeenAt: true,
    expiresAt: true,
    user: {select: SESSION_USER_SELECT},
} as const;

const COOKIE_FIELDS = {
    originalMaxAge: "number",
    expires: "string",
    secure: "boolean",
    httpOnly: "boolean",
    partitioned: "boolean",
    domain: "string",
    path: "string",
    sameSite: "string|boolean",
    priority: "string",
} as const;

/**
 * express-session store on the app's Prisma client (the `Session` model).
 *
 * Per request with a session cookie it does ONE read (the row joined with its
 * user, see loadedUser()) and usually no write:
 * - get() never writes (except to delete an unreadable row).
 * - set() runs only when the session data changed.
 * - touch() writes the activity (lastSeenAt + expiresAt) at most every
 *   `touchInterval` (or half the remaining lifetime, if shorter).
 *
 * Lifetime: a session ends `absoluteTimeout` after sign-in (`authenticatedAt`;
 * for sessions without sign-in, after the row's creation) and after
 * `idleTimeout` without recorded activity. Pending MFA logins and setups end
 * with their own `expiresAt`. The row's `expiresAt` is never moved past the
 * absolute deadline, and get() re-checks every limit with the current config.
 *
 * Writes never resurrect a session: a session loaded from the database is
 * only updated (`updateMany`), so if it was destroyed or revoked while a
 * request still held it, that request's save or touch is a no-op. Rows are
 * only created for sessions express-session generated in this process.
 * Writes for the same session id are applied in call order (last write wins).
 */
export class SessionStore extends Store {
    private readonly logger = new Logger("SessionStore");
    /** Rows read by get(), keyed by the returned data object until createSession() picks them up. */
    private readonly loadedRows = new WeakMap<object, RowState>();
    /** Row state per express-session Session object (loaded or created by this store). */
    private readonly rows = new WeakMap<object, RowState>();
    /** Tail of the write queue per session id (only while writes are in flight). */
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly prisma: StackPrismaClient, private readonly options: SessionStoreOptions) {
        super();
    }

    public override get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
        this.settle(this.read(sid), callback);
    }

    public override set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
        this.settle(this.serialize(sid, () => this.save(sid, session)), callback);
    }

    public override touch(sid: string, session: SessionData, callback?: (err?: unknown) => void): void {
        this.settle(this.serialize(sid, () => this.refresh(sid, session)), callback);
    }

    public override destroy(sid: string, callback?: (err?: unknown) => void): void {
        this.settle(this.serialize(sid, () => this.remove(sid)), callback);
    }

    /** Called by express-session with the data returned by get(). */
    public override createSession(req: Request, data: SessionData): Session & SessionData {
        const row = this.loadedRows.get(data);
        const session = super.createSession(req, data);

        if (row) {
            this.loadedRows.delete(data);
            this.rows.set(session, row);

            // The cookie (re-sent when the session changes) must not outlive the session either.
            const remaining = Math.max(0, this.deadline(session, row.createdAt) - Date.now());
            const cookie = session.cookie;
            if (typeof cookie.originalMaxAge === "number" && cookie.originalMaxAge > remaining) {
                cookie.originalMaxAge = remaining;
            }
        }

        return session;
    }

    /**
     * The user joined to the session row when this request loaded it (no
     * credential columns), so authentication needs no second query. Null
     * when the row has no user; undefined when the session wasn't loaded
     * from the database in this request (e.g. it was just created).
     */
    public loadedUser(session: SessionData): StackSessionUser | null | undefined {
        const row = this.rows.get(session);
        return row && !row.gone ? row.user : undefined;
    }

    private async read(sid: string): Promise<SessionData | null> {
        const row = await this.prisma.session.findUnique({where: {id: sid}, select: SESSION_LOAD_SELECT});
        if (!row) {
            return null;
        }

        const now = Date.now();
        const expiresAt = row.expiresAt.getTime();
        if (!(expiresAt > now)) {
            return null; // the cleanup job deletes it
        }

        const data = parseSessionData(row.data);
        if (!data) {
            // Never a 500 on every request of that browser: the session is gone, the visitor starts over.
            this.logger.warn("Destroying a session whose stored data is unreadable.");
            await this.serialize(sid, () => this.remove(sid));
            return null;
        }

        const createdAt = row.createdAt.getTime();
        const lastSeenAt = row.lastSeenAt.getTime();
        // Re-checked with the current limits (they may have been lowered since the row was written).
        if (this.deadline(data, createdAt) <= now || lastSeenAt + this.options.idleTimeout <= now) {
            return null;
        }

        this.loadedRows.set(data, {createdAt, lastSeenAt, expiresAt, user: row.user});
        return data;
    }

    private async save(sid: string, session: SessionData): Promise<void> {
        const now = Date.now();
        const row = this.rows.get(session);
        if (row?.gone) {
            return;
        }

        const columns = {
            data: toJsonObject(session),
            lastSeenAt: new Date(now),
            userId: session.userId ?? null,
            ipAddress: normalizeIpAddress(session.ipAddress),
            userAgent: truncateUserAgent(session.userAgent) ?? null,
        };

        if (row) {
            const expiresAt = this.expiresAt(session, row.createdAt, now);
            const {count} = await this.prisma.session.updateMany({where: {id: sid}, data: {...columns, expiresAt: new Date(expiresAt)}});
            this.recordWrite(row, count, now, expiresAt);
            return;
        }

        // A session generated by express-session in this process: new random id, no row yet.
        const expiresAt = this.expiresAt(session, now, now);
        await this.prisma.session.create({data: {id: sid, ...columns, createdAt: new Date(now), expiresAt: new Date(expiresAt)}});
        this.rows.set(session, {createdAt: now, lastSeenAt: now, expiresAt});
    }

    private async refresh(sid: string, session: SessionData): Promise<void> {
        const row = this.rows.get(session);
        if (!row || row.gone) {
            // Not loaded by this store (express-session only touches sessions it loaded): nothing to extend.
            return;
        }

        const now = Date.now();
        const expiresAt = this.expiresAt(session, row.createdAt, now);
        const interval = Math.min(this.options.touchInterval, (expiresAt - now) / 2);
        if (expiresAt <= row.expiresAt || now - row.lastSeenAt < interval) {
            return; // throttled, or nothing to extend (absolute deadline reached)
        }

        const {count} = await this.prisma.session.updateMany({
            where: {id: sid},
            data: {expiresAt: new Date(expiresAt), lastSeenAt: new Date(now)},
        });
        this.recordWrite(row, count, now, expiresAt);
    }

    private async remove(sid: string): Promise<void> {
        await this.prisma.session.deleteMany({where: {id: sid}});
    }

    private recordWrite(row: RowState, count: number, now: number, expiresAt: number): void {
        if (count === 0) {
            row.gone = true; // destroyed or revoked meanwhile: stays gone
            return;
        }

        row.lastSeenAt = now;
        row.expiresAt = expiresAt;
    }

    /** The absolute end of a session: sign-in (or creation) + absoluteTimeout, or a pending login/setup's own expiry. */
    private deadline(data: SessionData, createdAt: number): number {
        const signedInAt = typeof data.authenticatedAt === "number" ? Math.min(data.authenticatedAt, createdAt) : createdAt;
        let deadline = signedInAt + this.options.absoluteTimeout;

        if (data.userId == null) {
            // A pending MFA login or setup (which holds a password hash) is useless after its expiry; so is its row.
            for (const pending of [data.otp, data.setup]) {
                if (typeof pending?.expiresAt === "number") {
                    deadline = Math.min(deadline, pending.expiresAt);
                }
            }
        }

        return deadline;
    }

    /** The row's expiry after activity at `now`: idle limit, capped by the absolute deadline and the cookie's expiry. */
    private expiresAt(data: SessionData, createdAt: number, now: number): number {
        const cookieExpires = data.cookie?.expires ? new Date(data.cookie.expires).getTime() : NaN;

        return Math.min(
            this.deadline(data, createdAt),
            now + this.options.idleTimeout,
            Number.isFinite(cookieExpires) ? cookieExpires : Infinity,
        );
    }

    /** Writes of one session id run one after another, in call order. */
    private serialize<T>(sid: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(sid);
        const result = previous ? previous.then(task) : task();
        const tail = result.then(noop, noop);

        this.queues.set(sid, tail);
        void tail.then(() => {
            if (this.queues.get(sid) === tail) {
                this.queues.delete(sid);
            }
        });

        return result;
    }

    /** Callback adapter. The callback runs outside the try, so it is never called twice. */
    private settle<T>(work: Promise<T>, callback?: Callback<T>): void {
        work.then(
            value => callback?.(null, value),
            (err: unknown) => {
                if (callback) {
                    callback(err);
                } else {
                    this.logger.error(`Session store operation failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            },
        );
    }
}

function noop(): void {}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored session data (a JSON object), or null when it is unusable.
 * The cookie is reduced to its known, well-typed fields, so a damaged row
 * can't make express-session throw on every request.
 */
export function parseSessionData(value: unknown): SessionData | null {
    if (!isObject(value) || !isObject(value.cookie)) {
        return null;
    }

    const cookie: Record<string, unknown> = {};
    for (const [field, types] of Object.entries(COOKIE_FIELDS)) {
        const fieldValue = value.cookie[field];
        if (fieldValue === undefined || fieldValue === null) continue;
        if (!types.split("|").includes(typeof fieldValue)) return null;
        cookie[field] = fieldValue;
    }

    if (typeof cookie.expires === "string" && Number.isNaN(Date.parse(cookie.expires))) {
        return null;
    }

    if (typeof cookie.originalMaxAge === "number" && !Number.isFinite(cookie.originalMaxAge)) {
        return null;
    }

    return {...value, cookie} as unknown as SessionData;
}

/** Plain JSON for the Json column (Dates become ISO strings, the cookie its JSON form). */
function toJsonObject(session: SessionData): StackJsonObject {
    return JSON.parse(JSON.stringify(session)) as StackJsonObject;
}

/** The address if it is a valid IP (cut to the column-safe length), else null. */
function normalizeIpAddress(value: unknown): string | null {
    if (typeof value !== "string" || !net.isIP(value.split("%")[0])) {
        return null;
    }

    return value.slice(0, IP_ADDRESS_MAX_LENGTH);
}
