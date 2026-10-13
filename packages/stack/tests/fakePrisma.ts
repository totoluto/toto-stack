/**
 * In-memory stand-in for the app's generated Prisma client, for unit tests.
 * Tests import it directly and pass it to createServer({prisma}); it is not
 * aliased anywhere.
 *
 * Isolation:
 * - createFakePrisma() returns an independent database. Prefer one per test
 *   app (helpers.ts createTestApp() does this).
 * - The default export is one shared instance per test file (vitest imports
 *   modules afresh for every file); resetFakeDb() empties it.
 *
 * It mirrors the template's MariaDB schema (prisma/migrations/0_init) where
 * that is cheap, so tests fail where the real database would:
 * - Results follow Prisma's projection rules: all scalar columns by default,
 *   relations only when included, exactly the selected fields with `select`
 *   (so secrets aren't returned where real Prisma wouldn't return them).
 *   Results are copies, and Json columns are stored serialized.
 * - utf8mb4_unicode_ci: string comparisons and unique indexes ignore case,
 *   accents and trailing spaces (approximation of the collation).
 * - Unique indexes (P2002, NULLs never collide), foreign keys (P2003) with
 *   ON DELETE CASCADE, missing records (P2025), VARCHAR lengths (P2000),
 *   required columns and unknown arguments (validation errors).
 * - Queries are lazy like PrismaPromise: nothing runs until awaited.
 * - Every query is atomic (nested writes included). Interactive and batch
 *   transactions roll back their own writes on failure, but there is no
 *   isolation between concurrent transactions.
 * - Deviation: plain `null` in a required Json column is stored as JSON null
 *   (real Prisma needs Prisma.JsonNull there).
 * - Optional per-call latency (createFakePrisma({latency}) or
 *   $fake.setLatency) makes interleavings reproducible in race tests.
 *
 * Unsupported query arguments throw, so new query shapes in the stack show
 * up here instead of passing silently. $executeRaw is not emulated.
 */
import {AsyncLocalStorage} from "node:async_hooks";

/* ------------------------------------------------------------------ rows */

export type UserRow = {
    id: number;
    username: string;
    password: string;
    createdAt: Date;
    updatedAt: Date;
    apiKey: string | null;
    otpSecret: string | null;
    otpEnabled: boolean;
    otpLastUsedStep: number | null;
};
export type RoleRow = {id: number; name: string};
export type UserRoleRow = {id: number; userId: number; roleId: number};
export type SessionRow = {
    id: string;
    userId: number | null;
    data: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
};
export type SetupLockRow = {id: number; userId: number; createdAt: Date};

/*
 * Result types list every relation for convenience. At runtime only the
 * included/selected ones are present, exactly as with Prisma.
 */
export type UserRoleResult = UserRoleRow & {role: RoleResult; user: UserResult};
export type UserResult = UserRow & {roles: UserRoleResult[]; sessions: SessionRow[]; setupLock: SetupLockRow | null};
export type RoleResult = RoleRow & {users: UserRoleResult[]};
export type SessionResult = SessionRow & {user: UserResult | null};
export type SetupLockResult = SetupLockRow & {user: UserResult};

/** Query arguments: loosely typed here, checked at runtime against what Prisma accepts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FakeArgs = {[key: string]: any};

export type FakeDelegate<R> = {
    findUnique(args: FakeArgs): Promise<R | null>;
    findUniqueOrThrow(args: FakeArgs): Promise<R>;
    findFirst(args?: FakeArgs): Promise<R | null>;
    findFirstOrThrow(args?: FakeArgs): Promise<R>;
    findMany(args?: FakeArgs): Promise<R[]>;
    count(args?: FakeArgs): Promise<number>;
    create(args: FakeArgs): Promise<R>;
    createMany(args: FakeArgs): Promise<{count: number}>;
    update(args: FakeArgs): Promise<R>;
    updateMany(args: FakeArgs): Promise<{count: number}>;
    upsert(args: FakeArgs): Promise<R>;
    delete(args: FakeArgs): Promise<R>;
    deleteMany(args: FakeArgs): Promise<{count: number}>;
};

/** The delegates available inside an interactive transaction. */
export type FakeTransactionClient = {
    user: FakeDelegate<UserResult>;
    role: FakeDelegate<RoleResult>;
    userRole: FakeDelegate<UserRoleResult>;
    session: FakeDelegate<SessionResult>;
    setupLock: FakeDelegate<SetupLockResult>;
};

/* ---------------------------------------------------------------- schema */

type ModelName = "user" | "userRole" | "role" | "session" | "setupLock";

type FieldDef = {
    kind: "int" | "string" | "boolean" | "datetime" | "json";
    optional?: boolean;
    /** VARCHAR(n): maximum length in characters. */
    maxLength?: number;
    default?: () => unknown;
    autoincrement?: boolean;
    updatedAt?: boolean;
};

type RelationDef = {
    model: ModelName;
    list: boolean;
    /** Field on this model ... */
    from: string;
    /** ... matching this field on the related model. */
    to: string;
};

type ModelDef = {
    name: string;
    fields: Record<string, FieldDef>;
    /** Unique indexes, primary key first. Compound ones are addressable in `where` as `a_b`. */
    unique: string[][];
    relations: Record<string, RelationDef>;
};

/** Prisma's default `String` column on MySQL. */
const VARCHAR = 191;
const now = () => new Date();

const MODELS: Record<ModelName, ModelDef> = {
    user: {
        name: "User",
        fields: {
            id: {kind: "int", autoincrement: true},
            username: {kind: "string", maxLength: VARCHAR},
            password: {kind: "string", maxLength: VARCHAR},
            createdAt: {kind: "datetime", default: now},
            updatedAt: {kind: "datetime", updatedAt: true},
            apiKey: {kind: "string", optional: true, maxLength: VARCHAR},
            otpSecret: {kind: "string", optional: true, maxLength: VARCHAR},
            otpEnabled: {kind: "boolean", default: () => false},
            otpLastUsedStep: {kind: "int", optional: true},
        },
        unique: [["id"], ["username"], ["apiKey"]],
        relations: {
            roles: {model: "userRole", list: true, from: "id", to: "userId"},
            sessions: {model: "session", list: true, from: "id", to: "userId"},
            setupLock: {model: "setupLock", list: false, from: "id", to: "userId"},
        },
    },
    userRole: {
        name: "UserRole",
        fields: {
            id: {kind: "int", autoincrement: true},
            userId: {kind: "int"},
            roleId: {kind: "int"},
        },
        unique: [["id"], ["userId", "roleId"]],
        relations: {
            user: {model: "user", list: false, from: "userId", to: "id"},
            role: {model: "role", list: false, from: "roleId", to: "id"},
        },
    },
    role: {
        name: "Role",
        fields: {
            id: {kind: "int", autoincrement: true},
            name: {kind: "string", maxLength: VARCHAR},
        },
        unique: [["id"], ["name"]],
        relations: {
            users: {model: "userRole", list: true, from: "id", to: "roleId"},
        },
    },
    session: {
        name: "Session",
        fields: {
            id: {kind: "string", maxLength: VARCHAR},
            userId: {kind: "int", optional: true},
            data: {kind: "json"},
            ipAddress: {kind: "string", optional: true, maxLength: VARCHAR},
            userAgent: {kind: "string", optional: true, maxLength: 512},
            createdAt: {kind: "datetime", default: now},
            lastSeenAt: {kind: "datetime", default: now},
            expiresAt: {kind: "datetime"},
        },
        unique: [["id"]],
        relations: {
            user: {model: "user", list: false, from: "userId", to: "id"},
        },
    },
    setupLock: {
        name: "SetupLock",
        fields: {
            id: {kind: "int"},
            userId: {kind: "int"},
            createdAt: {kind: "datetime", default: now},
        },
        unique: [["id"], ["userId"]],
        relations: {
            user: {model: "user", list: false, from: "userId", to: "id"},
        },
    },
};

/** Foreign keys (all reference `id`, all ON DELETE CASCADE). */
const FOREIGN_KEYS: {model: ModelName; field: string; references: ModelName; name: string}[] = [
    {model: "userRole", field: "userId", references: "user", name: "UserRole_userId_fkey"},
    {model: "userRole", field: "roleId", references: "role", name: "UserRole_roleId_fkey"},
    {model: "session", field: "userId", references: "user", name: "Session_userId_fkey"},
    {model: "setupLock", field: "userId", references: "user", name: "SetupLock_userId_fkey"},
];

const MODEL_NAMES = Object.keys(MODELS) as ModelName[];

/* ---------------------------------------------------------------- errors */

/** Shaped like PrismaClientKnownRequestError (code, meta). */
export class FakePrismaKnownError extends Error {
    public readonly name = "PrismaClientKnownRequestError";
    public readonly clientVersion = "fake";

    public constructor(public readonly code: string, message: string, public readonly meta: Record<string, unknown> = {}) {
        super(message);
    }
}

/** Shaped like PrismaClientValidationError (invalid query arguments). */
export class FakePrismaValidationError extends Error {
    public readonly name = "PrismaClientValidationError";
}

function unsupported(what: string): Error {
    return new Error(`fakePrisma: ${what} is not emulated. Extend tests/fakePrisma.ts (or use the integration suite).`);
}

/* ------------------------------------------------------------- collation */

/**
 * Approximates MariaDB's utf8mb4_unicode_ci: case- and accent-insensitive,
 * trailing spaces ignored (PAD SPACE).
 */
export function collationKey(value: string): string {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ +$/u, "");
}

type Row = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sameValue(field: FieldDef, a: unknown, b: unknown): boolean {
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    switch (field.kind) {
        case "string": return collationKey(String(a)) === collationKey(String(b));
        case "datetime": return new Date(a as Date).getTime() === new Date(b as Date).getTime();
        case "json": return JSON.stringify(a) === JSON.stringify(b);
        default: return a === b;
    }
}

function compareValues(field: FieldDef, a: unknown, b: unknown): number {
    if (field.kind === "string") {
        const [x, y] = [collationKey(String(a)), collationKey(String(b))];
        return x < y ? -1 : x > y ? 1 : 0;
    }
    if (field.kind === "datetime") return new Date(a as Date).getTime() - new Date(b as Date).getTime();
    if (field.kind === "boolean") return Number(a) - Number(b);
    return (a as number) - (b as number);
}

function clone(value: unknown): unknown {
    if (value instanceof Date) return new Date(value.getTime());
    if (value !== null && typeof value === "object") return JSON.parse(JSON.stringify(value));
    return value;
}

/* ---------------------------------------------------------------- client */

export type FakeLatency = number | ((call: {model: string; operation: string}) => number);

export type FakeCall = {model: string; operation: string; args: unknown};

export type FakePrismaOptions = {
    /** Delay (ms) before each query executes. */
    latency?: FakeLatency;
};

type Journal = {undo: (() => void)[]; closed: boolean};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A lazy promise: like PrismaPromise, the query runs only once it is awaited (then/catch/finally). */
function prismaPromise<T>(run: () => Promise<T>): Promise<T> {
    let started: Promise<T> | undefined;
    const start = () => (started ??= run());
    const lazy = {
        then: (onFulfilled?: (value: T) => unknown, onRejected?: (reason: unknown) => unknown) => start().then(onFulfilled, onRejected),
        catch: (onRejected?: (reason: unknown) => unknown) => start().catch(onRejected),
        finally: (onFinally?: () => void) => start().finally(onFinally),
        [Symbol.toStringTag]: "PrismaPromise",
    };
    return lazy as unknown as Promise<T>;
}

export function createFakePrisma(options: FakePrismaOptions = {}) {
    let latency: FakeLatency = options.latency ?? 0;
    const calls: FakeCall[] = [];
    const transactions = new AsyncLocalStorage<Journal>();

    const tables = {} as Record<ModelName, Map<number, Row>>;
    const autoincrement = {} as Record<ModelName, number>;
    let nextRowKey = 1;

    function reset(): void {
        for (const name of MODEL_NAMES) {
            tables[name] = new Map();
            autoincrement[name] = 1;
        }
        calls.length = 0;
    }
    reset();

    const rows = (model: ModelName) => [...tables[model].entries()];

    /* ---------- where ---------- */

    function matchField(field: FieldDef, actual: unknown, condition: unknown): boolean {
        const equals = (expected: unknown) => (expected === null ? actual === null : actual !== null && sameValue(field, actual, expected));

        if (!isPlainObject(condition)) return equals(condition);

        for (const [op, operand] of Object.entries(condition)) {
            if (operand === undefined) continue;
            switch (op) {
                case "equals":
                    if (!equals(operand)) return false;
                    break;
                case "not":
                    // SQL semantics: `not` never matches NULL columns unless comparing with null.
                    if (isPlainObject(operand)) {
                        if (actual === null || matchField(field, actual, operand)) return false;
                    } else if (operand === null ? actual === null : actual === null || equals(operand)) {
                        return false;
                    }
                    break;
                case "in":
                    if (!(operand as unknown[]).some(equals)) return false;
                    break;
                case "notIn":
                    if (actual === null || (operand as unknown[]).some(equals)) return false;
                    break;
                case "lt": case "lte": case "gt": case "gte": {
                    if (actual === null || operand === null) return false;
                    const order = compareValues(field, actual, operand);
                    if (op === "lt" && !(order < 0)) return false;
                    if (op === "lte" && !(order <= 0)) return false;
                    if (op === "gt" && !(order > 0)) return false;
                    if (op === "gte" && !(order >= 0)) return false;
                    break;
                }
                case "contains": case "startsWith": case "endsWith": {
                    if (typeof actual !== "string") return false;
                    const [text, part] = [collationKey(actual), collationKey(String(operand))];
                    const ok = op === "contains" ? text.includes(part) : op === "startsWith" ? text.startsWith(part) : text.endsWith(part);
                    if (!ok) return false;
                    break;
                }
                default:
                    throw unsupported(`filter operator \`${op}\``);
            }
        }
        return true;
    }

    function related(model: ModelName, row: Row, relationName: string): Row[] {
        const relation = MODELS[model].relations[relationName];
        const targetField = MODELS[relation.model].fields[relation.to];
        const value = row[relation.from];
        if (value === null || value === undefined) return [];
        return [...tables[relation.model].values()].filter(other => sameValue(targetField, other[relation.to], value));
    }

    function matches(model: ModelName, row: Row, where: unknown): boolean {
        if (where === undefined) return true;
        if (!isPlainObject(where)) throw new FakePrismaValidationError(`Invalid \`where\` on ${MODELS[model].name}.`);
        const def = MODELS[model];

        for (const [key, condition] of Object.entries(where)) {
            if (condition === undefined) continue;
            if (key === "AND" || key === "NOT") {
                const list = Array.isArray(condition) ? condition : [condition];
                if (key === "AND" && !list.every(branch => matches(model, row, branch))) return false;
                if (key === "NOT" && list.some(branch => matches(model, row, branch))) return false;
            } else if (key === "OR") {
                if (!(condition as unknown[]).some(branch => matches(model, row, branch))) return false;
            } else if (key in def.fields) {
                if (!matchField(def.fields[key], row[key], condition)) return false;
            } else if (key in def.relations) {
                const relation = def.relations[key];
                const others = related(model, row, key);
                const test = (branch: unknown) => others.some(other => matches(relation.model, other, branch));
                const filter = condition as Record<string, unknown>;
                if (relation.list) {
                    for (const [op, branch] of Object.entries(filter)) {
                        if (op === "some" && !test(branch)) return false;
                        else if (op === "none" && test(branch)) return false;
                        else if (op === "every" && !others.every(other => matches(relation.model, other, branch))) return false;
                        else if (!["some", "none", "every"].includes(op)) throw unsupported(`list relation filter \`${op}\``);
                    }
                } else if ("is" in filter || "isNot" in filter) {
                    if ("is" in filter && (filter.is === null ? others.length > 0 : !test(filter.is))) return false;
                    if ("isNot" in filter && (filter.isNot === null ? others.length === 0 : test(filter.isNot))) return false;
                } else if (!test(filter)) {
                    return false;
                }
            } else {
                const compound = def.unique.find(fields => fields.length > 1 && fields.join("_") === key);
                if (!compound || !isPlainObject(condition)) {
                    throw new FakePrismaValidationError(`Unknown argument \`${key}\` in \`where\` of ${def.name}.`);
                }
                if (!compound.every(name => matchField(def.fields[name], row[name], condition[name]))) return false;
            }
        }
        return true;
    }

    /** findUnique/update/delete/upsert need a unique selector, like Prisma's WhereUniqueInput. */
    function assertUniqueWhere(model: ModelName, where: unknown): void {
        const def = MODELS[model];
        const ok = isPlainObject(where) && def.unique.some(fields =>
            fields.length === 1
                ? where[fields[0]] !== undefined && !isPlainObject(where[fields[0]])
                : isPlainObject(where[fields.join("_")]));
        if (!ok) {
            const names = def.unique.map(fields => `\`${fields.join("_")}\``).join(", ");
            throw new FakePrismaValidationError(`Argument \`where\` of type ${def.name}WhereUniqueInput needs at least one of ${names} arguments.`);
        }
    }

    /* ---------- projection ---------- */

    function project(model: ModelName, row: Row, args: Record<string, unknown> = {}): Row {
        const def = MODELS[model];
        const {select, include} = args;
        if (select && include) {
            throw new FakePrismaValidationError("Please either use `include` or `select`, but not both at the same time.");
        }

        const out: Row = {};
        if (isPlainObject(select)) {
            for (const [key, spec] of Object.entries(select)) {
                if (!spec) continue;
                if (key in def.fields) out[key] = clone(row[key]);
                else if (key in def.relations) out[key] = projectRelation(model, row, key, spec);
                else throw new FakePrismaValidationError(`Unknown field \`${key}\` for select statement on model \`${def.name}\`.`);
            }
            return out;
        }

        for (const key of Object.keys(def.fields)) out[key] = clone(row[key]);
        if (isPlainObject(include)) {
            for (const [key, spec] of Object.entries(include)) {
                if (!spec) continue;
                if (!(key in def.relations)) throw new FakePrismaValidationError(`Unknown field \`${key}\` for include statement on model \`${def.name}\`.`);
                out[key] = projectRelation(model, row, key, spec);
            }
        }
        return out;
    }

    function projectRelation(model: ModelName, row: Row, relationName: string, spec: unknown): unknown {
        const relation = MODELS[model].relations[relationName];
        const nested = isPlainObject(spec) ? spec : {};
        if (!relation.list) {
            const [first] = related(model, row, relationName);
            return first ? project(relation.model, first, nested) : null;
        }
        const list = query(relation.model, related(model, row, relationName).map(other => [0, other] as [number, Row]), nested);
        return list.map(([, other]) => project(relation.model, other, nested));
    }

    /** where + orderBy + skip/take over [rowKey, row] pairs. */
    function query(model: ModelName, source: [number, Row][], args: Record<string, unknown>): [number, Row][] {
        const def = MODELS[model];
        let list = source.filter(([, row]) => matches(model, row, args.where));
        if (args.orderBy) {
            const orders = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Record<string, unknown>[];
            const keys = orders.flatMap(order => Object.entries(order));
            for (const [key, direction] of keys) {
                if (!(key in def.fields) || (direction !== "asc" && direction !== "desc")) throw unsupported(`orderBy ${JSON.stringify({[key]: direction})}`);
            }
            list = [...list].sort(([, a], [, b]) => {
                for (const [key, direction] of keys) {
                    const order = compareValues(def.fields[key], a[key], b[key]);
                    if (order !== 0) return direction === "asc" ? order : -order;
                }
                return 0;
            });
        }
        const skip = (args.skip as number | undefined) ?? 0;
        const take = args.take as number | undefined;
        if (take !== undefined && take < 0) throw unsupported("negative take");
        return list.slice(skip, take === undefined ? undefined : skip + take);
    }

    /* ---------- writes ---------- */

    function coerce(model: ModelName, name: string, value: unknown): unknown {
        const def = MODELS[model];
        const field = def.fields[name];
        const invalid = (expected: string) => new FakePrismaValidationError(`Argument \`${name}\` on ${def.name}: expected ${expected}, got ${JSON.stringify(value)}.`);

        // A required Json column holds JSON null where Prisma would need Prisma.JsonNull.
        if (value === null && field.kind === "json") return null;
        if (value === null) {
            if (!field.optional) throw new FakePrismaValidationError(`Argument \`${name}\` on ${def.name} must not be null.`);
            return null;
        }
        switch (field.kind) {
            case "int":
                if (!Number.isInteger(value)) throw invalid("Int");
                return value;
            case "boolean":
                if (typeof value !== "boolean") throw invalid("Boolean");
                return value;
            case "string":
                if (typeof value !== "string") throw invalid("String");
                if (field.maxLength !== undefined && [...value].length > field.maxLength) {
                    throw new FakePrismaKnownError("P2000", `The provided value for the column is too long for the column's type. Column: ${name}`, {modelName: def.name, column_name: name});
                }
                return value;
            case "datetime": {
                const date = value instanceof Date ? new Date(value.getTime()) : typeof value === "string" ? new Date(value) : null;
                if (!date || Number.isNaN(date.getTime())) throw invalid("DateTime");
                return date;
            }
            case "json":
                if (value === undefined) throw invalid("Json");
                return JSON.parse(JSON.stringify(value));
        }
    }

    function checkConstraints(model: ModelName, rowKey: number, row: Row): void {
        const def = MODELS[model];
        for (const fields of def.unique) {
            if (fields.some(name => row[name] === null || row[name] === undefined)) continue;
            const clash = rows(model).some(([key, other]) => key !== rowKey && fields.every(name => sameValue(def.fields[name], other[name], row[name])));
            if (clash) {
                throw new FakePrismaKnownError("P2002", `Unique constraint failed on the fields: (${fields.map(name => `\`${name}\``).join(",")})`, {modelName: def.name, target: fields});
            }
        }
        for (const fk of FOREIGN_KEYS) {
            if (fk.model !== model || row[fk.field] === null || row[fk.field] === undefined) continue;
            const exists = [...tables[fk.references].values()].some(target => target.id === row[fk.field]);
            if (!exists) {
                throw new FakePrismaKnownError("P2003", `Foreign key constraint violated on the constraint: \`${fk.name}\``, {modelName: def.name, field_name: fk.name});
            }
        }
    }

    function findUniqueRow(model: ModelName, where: unknown): [number, Row] | undefined {
        assertUniqueWhere(model, where);
        return rows(model).find(([, row]) => matches(model, row, where));
    }

    function insert(model: ModelName, data: unknown, journal: Journal): [number, Row] {
        const def = MODELS[model];
        if (!isPlainObject(data)) throw new FakePrismaValidationError(`Argument \`data\` is missing on ${def.name}.`);
        const row: Row = {};
        const children: [RelationDef, unknown][] = [];

        for (const [key, value] of Object.entries(data)) {
            if (value === undefined) continue;
            if (key in def.fields) {
                row[key] = coerce(model, key, value);
                continue;
            }
            const relation = def.relations[key];
            if (!relation || !isPlainObject(value)) throw new FakePrismaValidationError(`Unknown argument \`${key}\` on ${def.name}.`);
            const ownsForeignKey = !relation.list && relation.from !== "id";
            if (ownsForeignKey) {
                if (value.connect !== undefined) {
                    const target = findUniqueRow(relation.model, value.connect);
                    if (!target) {
                        throw new FakePrismaKnownError("P2025", `No '${MODELS[relation.model].name}' record(s) (needed to inline the relation on '${def.name}' record(s)) was found for a nested connect.`, {modelName: def.name, cause: `No '${MODELS[relation.model].name}' record was found for a nested connect.`});
                    }
                    row[relation.from] = target[1][relation.to];
                } else if (value.create !== undefined) {
                    row[relation.from] = insert(relation.model, value.create, journal)[1][relation.to];
                } else {
                    throw unsupported(`nested ${Object.keys(value).join("/")} on ${def.name}.${key}`);
                }
            } else {
                if (Object.keys(value).some(op => op !== "create")) throw unsupported(`nested ${Object.keys(value).join("/")} on ${def.name}.${key}`);
                children.push([relation, value.create]);
            }
        }

        for (const [name, field] of Object.entries(def.fields)) {
            if (row[name] !== undefined) continue;
            if (field.autoincrement) row[name] = autoincrement[model]++;
            else if (field.updatedAt) row[name] = new Date();
            else if (field.default) row[name] = field.default();
            else if (field.optional) row[name] = null;
            else throw new FakePrismaValidationError(`Argument \`${name}\` is missing on ${def.name}.`);
        }
        for (const [name, field] of Object.entries(def.fields)) {
            // An explicit id moves AUTO_INCREMENT past it (rolled-back inserts still consume ids, like InnoDB).
            if (field.autoincrement) autoincrement[model] = Math.max(autoincrement[model], (row[name] as number) + 1);
        }

        const rowKey = nextRowKey++;
        checkConstraints(model, rowKey, row);
        tables[model].set(rowKey, row);
        journal.undo.push(() => tables[model].delete(rowKey));

        for (const [relation, create] of children) {
            for (const child of Array.isArray(create) ? create : [create]) {
                insert(relation.model, {...(child as object), [relation.to]: row[relation.from]}, journal);
            }
        }
        return [rowKey, row];
    }

    function applyUpdate(model: ModelName, rowKey: number, data: unknown, journal: Journal): Row {
        const def = MODELS[model];
        if (!isPlainObject(data)) throw new FakePrismaValidationError(`Argument \`data\` is missing on ${def.name}.`);
        const row = tables[model].get(rowKey)!;
        const next: Row = {...row};

        for (const [key, value] of Object.entries(data)) {
            if (value === undefined) continue;
            if (!(key in def.fields)) {
                if (key in def.relations) throw unsupported(`nested writes in update (${def.name}.${key})`);
                throw new FakePrismaValidationError(`Unknown argument \`${key}\` on ${def.name}.`);
            }
            if (isPlainObject(value) && def.fields[key].kind !== "json") {
                const [[op, operand], ...rest] = Object.entries(value);
                if (rest.length) throw unsupported(`several update operations on ${def.name}.${key}`);
                const current = next[key] as number;
                const result = op === "set" ? operand
                    : op === "increment" ? current + (operand as number)
                    : op === "decrement" ? current - (operand as number)
                    : op === "multiply" ? current * (operand as number)
                    : op === "divide" ? Math.trunc(current / (operand as number))
                    : (() => { throw unsupported(`update operation \`${op}\``); })();
                next[key] = coerce(model, key, result);
            } else {
                next[key] = coerce(model, key, value);
            }
        }
        for (const [name, field] of Object.entries(def.fields)) {
            if (field.updatedAt && data[name] === undefined) next[name] = new Date();
        }

        checkConstraints(model, rowKey, next);
        const before = {...row};
        Object.assign(row, next);
        journal.undo.push(() => {
            if (tables[model].has(rowKey)) Object.assign(row, before);
        });
        return row;
    }

    function remove(model: ModelName, rowKey: number, journal: Journal): void {
        const row = tables[model].get(rowKey);
        if (!row) return;
        tables[model].delete(rowKey);
        journal.undo.push(() => tables[model].set(rowKey, row));
        for (const fk of FOREIGN_KEYS) {
            if (fk.references !== model) continue;
            for (const [childKey, child] of rows(fk.model)) {
                if (child[fk.field] === row.id) remove(fk.model, childKey, journal);
            }
        }
    }

    /* ---------- operations ---------- */

    function checkArgs(model: ModelName, operation: string, args: unknown, allowed: string[]): Record<string, unknown> {
        if (args === undefined) return {};
        if (!isPlainObject(args)) throw new FakePrismaValidationError(`Invalid arguments for ${MODELS[model].name}.${operation}.`);
        for (const key of Object.keys(args)) {
            if (args[key] !== undefined && !allowed.includes(key)) throw unsupported(`argument \`${key}\` of ${operation}()`);
        }
        return args;
    }

    const notFound = (model: ModelName, operation: string) => new FakePrismaKnownError(
        "P2025",
        `An operation failed because it depends on one or more records that were required but not found. No record was found for ${operation === "delete" ? "a delete" : operation === "upsert" ? "an upsert" : "an update"}.`,
        {modelName: MODELS[model].name},
    );

    /** Runs one statement atomically: on error its own writes are undone; inside a transaction they join its journal. */
    function statement<T>(fn: (journal: Journal) => T): T {
        const local: Journal = {undo: [], closed: false};
        const outer = transactions.getStore();
        try {
            const result = fn(local);
            outer?.undo.push(...local.undo);
            return result;
        } catch (err) {
            for (const step of local.undo.reverse()) step();
            throw err;
        }
    }

    const reads = ["where", "select", "include", "orderBy", "skip", "take"];

    const operations = {
        findUnique(model: ModelName, args: unknown): Row | null {
            const a = checkArgs(model, "findUnique", args, ["where", "select", "include"]);
            const found = findUniqueRow(model, a.where);
            return found ? project(model, found[1], a) : null;
        },
        findUniqueOrThrow(model: ModelName, args: unknown): Row {
            const result = operations.findUnique(model, args);
            if (!result) throw new FakePrismaKnownError("P2025", "No record was found for a query.", {modelName: MODELS[model].name});
            return result;
        },
        findFirst(model: ModelName, args: unknown): Row | null {
            const a = checkArgs(model, "findFirst", args, reads);
            const [first] = query(model, rows(model), {...a, take: 1});
            return first ? project(model, first[1], a) : null;
        },
        findFirstOrThrow(model: ModelName, args: unknown): Row {
            const result = operations.findFirst(model, args);
            if (!result) throw new FakePrismaKnownError("P2025", "No record was found for a query.", {modelName: MODELS[model].name});
            return result;
        },
        findMany(model: ModelName, args: unknown) {
            const a = checkArgs(model, "findMany", args, reads);
            return query(model, rows(model), a).map(([, row]) => project(model, row, a));
        },
        count(model: ModelName, args: unknown) {
            const a = checkArgs(model, "count", args, ["where", "orderBy", "skip", "take"]);
            return query(model, rows(model), a).length;
        },
        create(model: ModelName, args: unknown) {
            const a = checkArgs(model, "create", args, ["data", "select", "include"]);
            return statement(journal => project(model, insert(model, a.data, journal)[1], a));
        },
        createMany(model: ModelName, args: unknown) {
            const a = checkArgs(model, "createMany", args, ["data", "skipDuplicates"]);
            const list = Array.isArray(a.data) ? a.data : [a.data];
            return statement(journal => {
                let count = 0;
                for (const data of list) {
                    try {
                        insert(model, data, journal);
                        count++;
                    } catch (err) {
                        if (!(a.skipDuplicates && err instanceof FakePrismaKnownError && err.code === "P2002")) throw err;
                    }
                }
                return {count};
            });
        },
        update(model: ModelName, args: unknown) {
            const a = checkArgs(model, "update", args, ["where", "data", "select", "include"]);
            return statement(journal => {
                const found = findUniqueRow(model, a.where);
                if (!found) throw notFound(model, "update");
                return project(model, applyUpdate(model, found[0], a.data, journal), a);
            });
        },
        updateMany(model: ModelName, args: unknown) {
            const a = checkArgs(model, "updateMany", args, ["where", "data", "limit"]);
            return statement(journal => {
                const targets = query(model, rows(model), {where: a.where, take: a.limit});
                for (const [rowKey] of targets) applyUpdate(model, rowKey, a.data, journal);
                return {count: targets.length};
            });
        },
        upsert(model: ModelName, args: unknown) {
            const a = checkArgs(model, "upsert", args, ["where", "create", "update", "select", "include"]);
            return statement(journal => {
                const found = findUniqueRow(model, a.where);
                const row = found ? applyUpdate(model, found[0], a.update, journal) : insert(model, a.create, journal)[1];
                return project(model, row, a);
            });
        },
        delete(model: ModelName, args: unknown) {
            const a = checkArgs(model, "delete", args, ["where", "select", "include"]);
            return statement(journal => {
                const found = findUniqueRow(model, a.where);
                if (!found) throw notFound(model, "delete");
                const result = project(model, found[1], a);
                remove(model, found[0], journal);
                return result;
            });
        },
        deleteMany(model: ModelName, args: unknown) {
            const a = checkArgs(model, "deleteMany", args, ["where", "limit"]);
            return statement(journal => {
                const targets = query(model, rows(model), {where: a.where, take: a.limit});
                for (const [rowKey] of targets) remove(model, rowKey, journal);
                return {count: targets.length};
            });
        },
    };

    type Operation = keyof typeof operations;

    function execute(model: ModelName, operation: Operation, args: unknown): Promise<unknown> {
        return prismaPromise(async () => {
            const ms = typeof latency === "function" ? latency({model, operation}) : latency;
            if (ms > 0) await sleep(ms);
            if (transactions.getStore()?.closed) throw new FakePrismaKnownError("P2028", "Transaction API error: Transaction already closed.");
            calls.push({model, operation, args: clone(args)});
            return operations[operation](model, args);
        });
    }

    function delegate(model: ModelName) {
        const ops = Object.keys(operations) as Operation[];
        return Object.fromEntries(ops.map(operation => [operation, (args?: unknown) => execute(model, operation, args)]));
    }

    const client = {
        user: delegate("user") as unknown as FakeDelegate<UserResult>,
        role: delegate("role") as unknown as FakeDelegate<RoleResult>,
        userRole: delegate("userRole") as unknown as FakeDelegate<UserRoleResult>,
        session: delegate("session") as unknown as FakeDelegate<SessionResult>,
        setupLock: delegate("setupLock") as unknown as FakeDelegate<SetupLockResult>,
        $transaction,
        async $connect(): Promise<void> {},
        async $disconnect(): Promise<void> {},
        /** Answers the health check's `SELECT 1`. Tests may replace it. */
        $queryRaw: async (..._query: unknown[]): Promise<unknown> => [{1: 1}],
        $executeRaw: async (..._query: unknown[]): Promise<number> => {
            throw unsupported("$executeRaw");
        },
        /** Test controls (not part of Prisma). */
        $fake: {
            /** Empties every table and the call log. */
            reset,
            setLatency(value: FakeLatency) {
                latency = value;
            },
            /** Executed queries, oldest first. */
            calls: calls as readonly FakeCall[],
            /** Copies of the raw rows of a model. */
            rows(model: ModelName): Row[] {
                return [...tables[model].values()].map(row => project(model, row));
            },
        },
    };

    /**
     * Runs a callback whose queries go through client delegates (so wrappers
     * tests install apply), journaling their writes for rollback.
     */
    function transactionClient(journal: Journal): FakeTransactionClient {
        const view = {} as Record<ModelName, Record<string, unknown>>;
        for (const model of MODEL_NAMES) {
            view[model] = new Proxy({}, {
                get: (_target, property) => (args?: unknown) => prismaPromise(() => {
                    const operation = String(property);
                    const target = client[model] as unknown as Record<string, (args?: unknown) => Promise<unknown>>;
                    if (!(operation in target)) throw unsupported(`tx.${model}.${operation}`);
                    return transactions.run(journal, () => target[operation](args).then(value => value));
                }),
            });
        }
        return view as unknown as FakeTransactionClient;
    }

    function $transaction<R>(fn: (tx: FakeTransactionClient) => Promise<R>, options?: unknown): Promise<R>;
    function $transaction(queries: Promise<unknown>[], options?: unknown): Promise<unknown[]>;
    async function $transaction(arg: ((tx: FakeTransactionClient) => Promise<unknown>) | Promise<unknown>[]): Promise<unknown> {
        const journal: Journal = {undo: [], closed: false};
        try {
            if (Array.isArray(arg)) {
                const results: unknown[] = [];
                for (const pending of arg) results.push(await transactions.run(journal, () => pending.then(value => value)));
                return results;
            }
            return await arg(transactionClient(journal));
        } catch (err) {
            for (const step of journal.undo.reverse()) step();
            throw err;
        } finally {
            journal.closed = true;
        }
    }

    return client;
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;

/** One shared fake per test file. Prefer createFakePrisma() for new tests. */
const fakePrisma = createFakePrisma();

/** Empties the shared default fake. */
export function resetFakeDb(): void {
    fakePrisma.$fake.reset();
}

export default fakePrisma;
