/**
 * Structural types for the subset of a generated Prisma client that
 * toto-stack calls. Any client generated from a schema containing the
 * stack's base models (User, UserRole, Role, Session, SetupLock) satisfies it -
 * including `$extends(...)` clients and the in-memory fake used in tests.
 * Apps may add columns/models; they are preserved at runtime.
 *
 * Each method lists exactly the argument shape the stack passes, so
 * TypeScript checks the app's generated client against the real queries.
 */

/** A Role row. */
export type StackRoleRow = {
    id: number;
    name: string;
};

/** A User row (base columns). */
export type StackUserRow = {
    id: number;
    username: string;
    password: string;
    apiKey: string | null;
    otpSecret: string | null;
    otpEnabled: boolean;
    otpLastUsedStep: number | null;
    createdAt: Date;
    updatedAt: Date;
};

/** A UserRole row with its role. */
export type StackUserRoleRow = {
    id: number;
    userId: number;
    roleId: number;
    role: StackRoleRow;
};

/** A User row including `roles: {include: {role: true}}`. */
export type StackUserWithRoles = StackUserRow & {roles: StackUserRoleRow[]};

/** A Session row. */
export type StackSessionRow = {
    id: string;
    userId: number | null;
    data: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
};

/**
 * The user columns loaded to authenticate a request: no password, API key or
 * TOTP fields. Used for the user joined to a session and for Bearer lookups.
 */
export const SESSION_USER_SELECT = {
    id: true,
    username: true,
    roles: {select: {role: {select: {name: true}}}},
} as const;

/** A user loaded with SESSION_USER_SELECT. */
export type StackSessionUser = {
    id: number;
    username: string;
    roles: {role: {name: string}}[];
};

/** A JSON object as stored in the Session.data column. */
export type StackJsonObject = {[key: string]: StackJsonValue};
export type StackJsonValue = string | number | boolean | null | StackJsonObject | StackJsonValue[];

type IncludeRoles = {roles: {include: {role: true}}};
type SessionUserSelect = typeof SESSION_USER_SELECT;
type UserUniqueWhere = {id: number} | {username: string} | {apiKey: string};

type UserCreateData = {
    username: string;
    password: string;
    otpEnabled?: boolean;
    otpSecret?: string | null;
    otpLastUsedStep?: number | null;
    roles?: {create: {role: {connect: {name: string}}}[]};
};

type SetupLockDelegate = {
    create(args: {data: {id: number; userId: number}}): Promise<unknown>;
};

type SessionWrite = {
    data: StackJsonObject;
    expiresAt: Date;
    lastSeenAt: Date;
    userId: number | null;
    ipAddress: string | null;
    userAgent: string | null;
};

type SessionWhere = {
    id?: string | {not: string} | {in: string[]};
    userId?: number;
    expiresAt?: {lt: Date};
};

/** The columns the session store reads per request, with the session's user (one query). */
type SessionLoadSelect = {
    data: true;
    createdAt: true;
    lastSeenAt: true;
    expiresAt: true;
    user: {select: SessionUserSelect};
};

/** A Session row loaded by the session store. `data` is the session as a JSON object. */
export type StackSessionLoadRow = Pick<StackSessionRow, "data" | "createdAt" | "lastSeenAt" | "expiresAt"> & {
    user: StackSessionUser | null;
};

export interface StackPrismaClient {
    user: {
        create(args: {
            data: UserCreateData;
            include: IncludeRoles;
        }): Promise<StackUserWithRoles>;
        delete(args: {where: {id: number}; include?: {roles: true}}): Promise<unknown>;
        /** The full user (credentials included), for login and credential checks. */
        findFirst(args: {where?: {id?: number; username?: string}; include: IncludeRoles}): Promise<StackUserWithRoles | null>;
        /** Unique-index lookups of the credential-free columns (authentication). */
        findUnique(args: {where: UserUniqueWhere; select: SessionUserSelect}): Promise<StackSessionUser | null>;
        findMany(args: {
            select: {id: true; username: true; otpEnabled: true; createdAt: true; roles: IncludeRoles["roles"]};
        }): Promise<(Pick<StackUserRow, "id" | "username" | "otpEnabled" | "createdAt"> & {roles: StackUserRoleRow[]})[]>;
        update(args: {
            where: {id: number};
            data: {password?: string; apiKey?: string | null; otpSecret?: string | null; otpEnabled?: boolean; otpLastUsedStep?: number | null};
        }): Promise<unknown>;
        updateMany(args: {
            where: {
                id: number;
                otpEnabled?: boolean;
                OR?: ({otpLastUsedStep: null} | {otpLastUsedStep: {lt: number}})[];
            };
            data: {otpEnabled?: boolean; otpSecret?: string; otpLastUsedStep: number};
        }): Promise<{count: number}>;
        count(): Promise<number>;
    };
    setupLock: SetupLockDelegate;
    role: {
        findMany(args: {select: {name: true}}): Promise<{name: string}[]>;
        upsert(args: {where: {name: string}; create: {name: string}; update: Record<string, never>}): Promise<unknown>;
    };
    session: {
        findUnique(args: {where: {id: string}; select: SessionLoadSelect}): Promise<StackSessionLoadRow | null>;
        findMany(args: {where: {expiresAt: {lt: Date}}; select: {id: true}; take: number}): Promise<{id: string}[]>;
        create(args: {data: SessionWrite & {id: string; createdAt: Date}}): Promise<unknown>;
        updateMany(args: {where: {id: string}; data: Partial<SessionWrite>}): Promise<{count: number}>;
        deleteMany(args: {where: SessionWhere}): Promise<{count: number}>;
    };
    $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
    /** Interactive transaction (first-owner setup). */
    $transaction<R>(fn: (tx: StackTransactionClient) => Promise<R>): Promise<R>;
}

/** The delegates the stack uses inside $transaction. */
export type StackTransactionClient = {
    user: Pick<StackPrismaClient["user"], "count" | "create">;
    setupLock: SetupLockDelegate;
};
