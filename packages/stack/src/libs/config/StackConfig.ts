import crypto from "node:crypto";
import path from "node:path";
import type {Express} from "express";
import type {Server as HttpServer} from "node:http";
import type {Dependencies, CustomServices} from "@server/libs/Dependencies";
import type {StackPrismaClient} from "@server/libs/prisma/StackPrismaClient";
import type {RouteClass} from "@server/routes";
import type {BackgroundService} from "@server/libs/background/BackgroundService";
import type {CronJob} from "@server/libs/background/CronService";
import type {NotificationHandler} from "@server/libs/notifications/types";
import {BUILTIN_ROLES, Role} from "@shared/roles";
import {defaultLogLevel, isDevelopmentEnv, isLogLevel, LOG_LEVELS, logFormat, type LogFormat, type LogLevel} from "@server/libs/config/logging";
import type {RateLimitStore} from "@server/libs/security/RateLimitStore";
import {DEFAULT_ARGON2, DEFAULT_HASH_CONCURRENCY, DEFAULT_HASH_QUEUE_LIMIT} from "@server/libs/security/PasswordHasher";
import {parseEncryptionKey} from "@server/libs/security/secretBox";
import {keyBytesWeakness, SECRET_GENERATION_HINT, secretWeakness} from "@server/libs/security/secretStrength";

/** Value for Express' `trust proxy` setting (hop count, boolean, or address list). */
export type TrustProxy = boolean | number | string | readonly string[];

/** Content-Security-Policy directives (helmet format). `null` removes a default directive. */
export type CspDirectives = Record<string, readonly string[] | null>;

export type StackHooks = {
    /**
     * Called while the Express app is built: AFTER request ids, helmet, the
     * Origin check and the global rate limiter (so routes mounted here are
     * still rate limited), BEFORE the body parsers, session and CSRF
     * middleware. Mount raw-body endpoints (e.g. signed webhooks) or extra
     * middleware here. Routes mounted here have no session and no CSRF
     * protection.
     */
    configureApp?: (app: Express, dependencies: Dependencies) => void | Promise<void>;
    /**
     * Called right after the HTTP server is created, before listening.
     * Attach websocket servers (socket.io, ws) here.
     */
    onHttpServerCreated?: (httpServer: HttpServer, dependencies: Dependencies) => void | Promise<void>;
    /** Called once the server is listening and background services run. */
    onReady?: (dependencies: Dependencies) => void | Promise<void>;
    /**
     * First step of stop() (only if onReady ran), while requests are still
     * served: close websocket servers and other long-lived connections here,
     * otherwise they hold the HTTP drain open until `shutdown.timeoutMs`.
     */
    beforeShutdown?: (dependencies: Dependencies) => void | Promise<void>;
    /**
     * Last step of stop() (only if onReady ran): in-flight requests have
     * finished, the HTTP server is closed, and cron jobs and background
     * services are stopped. Release app resources here, e.g.
     * `onShutdown: () => prisma.$disconnect()`.
     */
    onShutdown?: (dependencies: Dependencies) => void | Promise<void>;
};

export type HttpConfig = {
    /** Port to listen on. Default: `PORT` env, else 3001. 0 picks a free port. */
    port?: number;
    /** Interface to listen on. Default: `HOST` env, else all interfaces. */
    host?: string;
    /**
     * Express `trust proxy` setting. Default: `TRUST_PROXY` env, else `false`.
     * Set it to the number of reverse proxies in front of the app (behind one
     * proxy such as Traefik: `1`) so req.ip, req.secure and rate limiting use
     * the real client values. Never trust a proxy you don't run.
     */
    trustProxy?: TrustProxy;
    /** Max JSON / urlencoded body size. Default: "10kb". */
    bodyLimit?: string | number;
};

export type SecurityConfig = {
    /**
     * Origins allowed to make credentialed requests, e.g. ["https://app.example.com"].
     * Default: `ALLOWED_ORIGINS` env (comma-separated). Required in production.
     * In development the localhost:3000/3001 origins are always allowed.
     */
    allowedOrigins?: readonly string[];
    /** CSP directives merged over the stack's strict defaults, or `false` to disable CSP. */
    csp?: CspDirectives | false;
    /**
     * Secret used to sign session cookies (min. 32 characters).
     * Default: `SESSION_SECRET` env. Required in production.
     */
    sessionSecret?: string;
    /**
     * Token required to perform the first-run owner setup (min. 16 characters).
     * Default: `SETUP_TOKEN` env. When unset and no user exists, a random
     * one-time token is generated at boot and logged once. Set it explicitly
     * when running several instances.
     */
    setupToken?: string;
    /**
     * Issuer shown next to the account in authenticator apps. Default:
     * `TOTP_ISSUER` env, else the host of the first allowed origin, else "toto-stack".
     */
    totpIssuer?: string;
    /**
     * Key to encrypt TOTP secrets at rest (AES-256-GCM): 32 bytes as 64 hex
     * characters or base64. Default: `OTP_ENCRYPTION_KEY` env; unset stores
     * secrets in plaintext. Existing plaintext secrets keep working and are
     * encrypted on their next use. Losing the key disables every user's MFA login.
     */
    otpEncryptionKey?: string;
    /**
     * Store for the authentication rate limits (login, MFA, setup, password
     * confirmation, CSRF tokens). Default: in memory, per process. Provide a
     * shared store when running several instances.
     */
    rateLimitStore?: RateLimitStore;
    /**
     * Password hashing (Argon2id) parameters and load shedding.
     * - `memoryCost` (KiB, default 19456 = 19 MiB), `timeCost` (default 2),
     *   `parallelism` (default 1): the OWASP Argon2id baseline. Changing them
     *   rehashes each password at its next successful login.
     * - `concurrency`: hashes running at once (default 2; keep it below the
     *   libuv threadpool size, UV_THREADPOOL_SIZE, default 4).
     * - `queueLimit`: hashes allowed to wait (default 32). Further logins and
     *   password confirmations get 503 with code OVERLOADED and Retry-After.
     */
    passwordHashing?: {concurrency?: number; queueLimit?: number; memoryCost?: number; timeCost?: number; parallelism?: number};
};

export type SessionConfig = {
    /**
     * Absolute session lifetime in ms, counted from sign-in (password login,
     * MFA completion or setup). Never extended by activity; also the session
     * cookie's Max-Age. Default: 7 days.
     */
    absoluteTimeout?: number;
    /**
     * Idle timeout in ms: a session without requests for this long ends.
     * Enforced server-side (activity is recorded at most every
     * `touchInterval`, so a session may end up to that much earlier).
     * Default: 24 hours, at most `absoluteTimeout`.
     */
    idleTimeout?: number;
    /**
     * Minimum time in ms between two activity writes (last seen, expiry) of
     * an unchanged session; requests in between cause no session write.
     * Must be shorter than `idleTimeout`. Default: 5 minutes, at most half the idle timeout.
     */
    touchInterval?: number;
    /**
     * Base name of the session cookie. In production the cookie is called
     * `__Host-<cookieName>` (Secure, Path=/, no Domain); in development
     * (plain HTTP) it has no prefix. Default: "connect.sid".
     */
    cookieName?: string;
};

export type FrontendConfig = {
    /**
     * Absolute path of the built SPA (the directory containing index.html).
     * Resolve it from the server file, not the working directory, e.g.
     * `path.join(import.meta.dirname, "public")`.
     */
    dir: string;
};

/** Notification handlers keyed by id (the id is used to target a handler). */
export type NotificationHandlers = Record<string, NotificationHandler>;

export type NotificationsConfig = {
    /** Handlers to register, or a factory receiving the dependencies (e.g. for EmailHandler). */
    handlers?: NotificationHandlers | ((dependencies: Dependencies) => NotificationHandlers);
};

export {isDevelopmentEnv} from "@server/libs/config/logging";
export type {LogFormat, LogLevel} from "@server/libs/config/logging";

export type LoggerConfig = {
    /** Route console.* through the stack Logger while the server runs. Default: true. */
    patchConsole?: boolean;
    /** Minimum level logged. Default: `LOG_LEVEL` env, else "debug" in development and "info" in production. */
    level?: LogLevel;
};

export type SmtpConfig = {
    host: string;
    /** Default: 465 when `secure`, else 587. */
    port?: number;
    /** Use implicit TLS (port 465). Default: false (STARTTLS is still used when offered). */
    secure?: boolean;
    /** SMTP credentials; omit both for an unauthenticated relay. */
    user?: string;
    pass?: string;
};

export type ResolvedSmtpConfig = {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | undefined;
    readonly pass: string | undefined;
};

export type EmailConfig = {
    /**
     * SMTP server, or `false` to disable email. Default: the SMTP_HOST,
     * SMTP_PORT, SMTP_SECURE, SMTP_USER and SMTP_PASS env variables (email is
     * disabled when SMTP_HOST is unset).
     */
    smtp?: SmtpConfig | false;
    /** Sender address, required when SMTP is configured. Default: `SMTP_FROM` env. */
    from?: string;
};

export type ShutdownConfig = {
    /**
     * On SIGINT/SIGTERM, run stop() (hooks included), set process.exitCode
     * (0, or 1 if stop() failed) and let the process exit by itself. If it
     * is still running `timeoutMs` + 5 s after the signal (a hung hook or a
     * leaked handle such as an open DB connection), it is force-exited. A
     * second signal during shutdown exits immediately (code 128 + signal).
     * Default: false (the app handles signals and calls stop()).
     */
    handleSignals?: boolean;
    /**
     * How long stop() waits for in-flight requests (then closes the
     * connections) and for running cron jobs. Default: 10000 ms.
     */
    timeoutMs?: number;
};

export type StackConfig = {
    /**
     * The app's generated Prisma client (must include the stack base models).
     * The app owns it: the stack never disconnects it.
     */
    prisma: StackPrismaClient;
    /** Additional API route classes, mounted under /api. */
    routes?: RouteClass[];
    /**
     * Factory for app-specific services. The returned object is merged onto
     * the dependencies and available in every route and hook as
     * `this.dependencies.<name>`. Type it by augmenting `CustomServices`.
     * Custom services are attached after the factory returns.
     */
    services?: (dependencies: Dependencies) => CustomServices;
    /** Additional background services (started after listen, stopped on shutdown). */
    backgroundServices?: (dependencies: Dependencies) => BackgroundService[];
    /** Additional cron jobs for the built-in cron scheduler. */
    cronJobs?: (dependencies: Dependencies) => CronJob[];
    hooks?: StackHooks;
    /**
     * App-defined role names, added to the built-in `owner` and `admin`.
     * Missing roles are created at boot; roles are never deleted.
     */
    roles?: readonly string[];
    http?: HttpConfig;
    security?: SecurityConfig;
    session?: SessionConfig;
    /** Serve a built SPA, or `false` for API-only. Default: false. */
    frontend?: FrontendConfig | false;
    notifications?: NotificationsConfig;
    logger?: LoggerConfig;
    email?: EmailConfig;
    shutdown?: ShutdownConfig;
};

/**
 * The fully resolved configuration: StackConfig values, then environment
 * variables, then defaults. Computed once by createServer(); the stack reads
 * no environment variables afterwards. Available as `dependencies.config`.
 */
export type ResolvedStackConfig = {
    /** Raw NODE_ENV (undefined when unset). */
    readonly nodeEnv: string | undefined;
    /** True only when NODE_ENV is "development" or "test". Everything else is production. */
    readonly isDev: boolean;
    /** Built-in roles followed by the app roles, de-duplicated. */
    readonly roles: readonly Role[];
    readonly http: {
        readonly port: number;
        readonly host: string | undefined;
        readonly trustProxy: TrustProxy;
        readonly bodyLimit: string | number;
    };
    readonly security: {
        readonly allowedOrigins: readonly string[];
        readonly csp: CspDirectives | false;
        readonly sessionSecret: string;
        readonly setupToken: string | undefined;
        readonly totpIssuer: string;
        readonly otpEncryptionKey: string | undefined;
        readonly rateLimitStore: RateLimitStore | undefined;
        readonly passwordHashing: {
            readonly concurrency: number;
            readonly queueLimit: number;
            readonly memoryCost: number;
            readonly timeCost: number;
            readonly parallelism: number;
        };
    };
    readonly session: {
        readonly absoluteTimeout: number;
        readonly idleTimeout: number;
        readonly touchInterval: number;
        /** The configured base name (see SessionConfig.cookieName for the effective name). */
        readonly cookieName: string;
    };
    readonly frontend: FrontendConfig | false;
    readonly logger: {
        readonly patchConsole: boolean;
        readonly level: LogLevel;
        /** "pretty" in development, "json" in production. */
        readonly format: LogFormat;
    };
    readonly email: {
        /** `false` when email is not configured. */
        readonly smtp: ResolvedSmtpConfig | false;
        readonly from: string | undefined;
    };
    readonly shutdown: {
        readonly handleSignals: boolean;
        readonly timeoutMs: number;
    };
};

/** Thrown by createServer() when the configuration is invalid. Lists every problem at once. */
export class ConfigError extends Error {
    constructor(public readonly issues: readonly string[]) {
        super(`Invalid toto-stack configuration:\n${issues.map(issue => `- ${issue}`).join("\n")}`);
        this.name = "ConfigError";
    }
}

export const DEFAULT_SESSION_ABSOLUTE_TIMEOUT = 1000 * 60 * 60 * 24 * 7;
export const DEFAULT_SESSION_IDLE_TIMEOUT = 1000 * 60 * 60 * 24;
export const DEFAULT_SESSION_TOUCH_INTERVAL = 1000 * 60 * 5;
const DEFAULT_PORT = 3001;
const MIN_SECRET_LENGTH = 32;
const MIN_SETUP_TOKEN_LENGTH = 16;
const GENERATE_SECRET_HINT = `${SECRET_GENERATION_HINT} (or: node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")`;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type Env = Record<string, string | undefined>;

/**
 * Resolves StackConfig + environment into a ResolvedStackConfig.
 * Throws a ConfigError listing every problem; returns non-fatal warnings.
 */
export function resolveConfig(config: StackConfig, env: Env = process.env): {config: ResolvedStackConfig; warnings: string[]} {
    const errors: string[] = [];
    const warnings: string[] = [];

    const nodeEnv = clean(env.NODE_ENV);
    const isDev = isDevelopmentEnv(nodeEnv);

    const port = resolvePort(config.http?.port, env.PORT, errors);
    const host = clean(config.http?.host) ?? clean(env.HOST);
    const trustProxy = config.http?.trustProxy ?? parseTrustProxy(env.TRUST_PROXY);
    if (trustProxy === true && !isDev) {
        warnings.push("trust proxy is `true`: every X-Forwarded-For hop is trusted, so clients can spoof their IP. Prefer the number of proxies in front of the app (e.g. TRUST_PROXY=1).");
    }

    const allowedOrigins = resolveOrigins(config.security?.allowedOrigins, env.ALLOWED_ORIGINS, isDev, errors);
    const sessionSecret = resolveSessionSecret(config.security?.sessionSecret ?? env.SESSION_SECRET, isDev, errors, warnings);

    // Setup tokens guard owner creation, so weak ones are rejected in development too.
    const setupToken = clean(config.security?.setupToken ?? env.SETUP_TOKEN);
    const setupTokenProblem = setupToken === undefined ? null : secretWeakness(setupToken, MIN_SETUP_TOKEN_LENGTH);
    if (setupTokenProblem) {
        errors.push(`SETUP_TOKEN ${setupTokenProblem}. Generate one with: openssl rand -base64 24`);
    }

    const totpIssuer = resolveTotpIssuer(config.security?.totpIssuer ?? env.TOTP_ISSUER, allowedOrigins, errors);

    const otpEncryptionKey = clean(config.security?.otpEncryptionKey ?? env.OTP_ENCRYPTION_KEY);
    if (otpEncryptionKey !== undefined) {
        const key = parseEncryptionKey(otpEncryptionKey);
        const problem = key ? (keyBytesWeakness(key) ?? secretWeakness(otpEncryptionKey, 0)) : "must be 32 bytes as 64 hex characters or base64";
        if (problem) {
            errors.push(`OTP_ENCRYPTION_KEY ${problem}. Generate one with: openssl rand -base64 32`);
        }
    }

    const hashing = config.security?.passwordHashing;
    const passwordHashing = {
        concurrency: hashing?.concurrency ?? DEFAULT_HASH_CONCURRENCY,
        queueLimit: hashing?.queueLimit ?? DEFAULT_HASH_QUEUE_LIMIT,
        memoryCost: hashing?.memoryCost ?? DEFAULT_ARGON2.memoryCost,
        timeCost: hashing?.timeCost ?? DEFAULT_ARGON2.timeCost,
        parallelism: hashing?.parallelism ?? DEFAULT_ARGON2.parallelism,
    };
    for (const [name, value, min] of [
        ["concurrency", passwordHashing.concurrency, 1],
        ["queueLimit", passwordHashing.queueLimit, 0],
        // Argon2 lower limits: 8 KiB per lane, at least 1 pass and lane
        ["memoryCost", passwordHashing.memoryCost, 8 * passwordHashing.parallelism],
        ["timeCost", passwordHashing.timeCost, 1],
        ["parallelism", passwordHashing.parallelism, 1],
    ] as const) {
        if (!Number.isInteger(value) || value < min) {
            errors.push(`security.passwordHashing.${name} must be an integer >= ${min} (got ${String(value)}).`);
        }
    }
    if (passwordHashing.memoryCost < DEFAULT_ARGON2.memoryCost && !isDev) {
        warnings.push(`security.passwordHashing.memoryCost ${passwordHashing.memoryCost} KiB is below the OWASP Argon2id baseline (${DEFAULT_ARGON2.memoryCost} KiB).`);
    }

    const session = resolveSession(config.session, errors);

    const frontend = config.frontend ?? false;
    if (frontend && (typeof frontend.dir !== "string" || !path.isAbsolute(frontend.dir))) {
        errors.push(`frontend.dir must be an absolute path (got "${String(frontend.dir)}"). Resolve it from the server file, e.g. path.join(import.meta.dirname, "public").`);
    }

    const roles = resolveRoles(config.roles, errors);

    const timeoutMs = config.shutdown?.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
        errors.push(`shutdown.timeoutMs must be a non-negative integer (got ${String(timeoutMs)}).`);
    }

    const logLevel = resolveLogLevel(config.logger?.level, env.LOG_LEVEL, isDev, errors);
    const email = resolveEmail(config.email, env, errors);

    if (!isDev && nodeEnv === undefined) {
        const hint = "NODE_ENV is not set, so production mode is assumed. For local development set NODE_ENV=development.";
        if (errors.length > 0) {
            errors.push(hint);
        } else {
            warnings.push(hint);
        }
    }

    if (errors.length > 0) {
        throw new ConfigError(errors);
    }

    return {
        warnings,
        config: {
            nodeEnv,
            isDev,
            roles,
            http: {port, host, trustProxy, bodyLimit: config.http?.bodyLimit ?? "10kb"},
            security: {
                allowedOrigins,
                csp: config.security?.csp ?? {},
                sessionSecret,
                setupToken,
                totpIssuer,
                otpEncryptionKey,
                rateLimitStore: config.security?.rateLimitStore,
                passwordHashing,
            },
            session,
            frontend,
            logger: {patchConsole: config.logger?.patchConsole ?? true, level: logLevel, format: logFormat(isDev)},
            email,
            shutdown: {handleSignals: config.shutdown?.handleSignals ?? false, timeoutMs},
        },
    };
}

function clean(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function resolvePort(configured: number | undefined, envPort: string | undefined, errors: string[]): number {
    const raw = configured ?? clean(envPort);
    if (raw === undefined) return DEFAULT_PORT;

    const port = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        errors.push(`PORT must be an integer between 0 and 65535 (got "${String(raw)}").`);
        return DEFAULT_PORT;
    }

    return port;
}

/** TRUST_PROXY: "true" | "false" | hop count | comma-separated addresses/subnets (Express format). */
export function parseTrustProxy(value: string | undefined): TrustProxy {
    const raw = clean(value);
    if (raw === undefined || raw === "false") return false;
    if (raw === "true") return true;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
}

function resolveOrigins(configured: readonly string[] | undefined, envOrigins: string | undefined, isDev: boolean, errors: string[]): string[] {
    const origins = (configured ?? envOrigins?.split(",") ?? [])
        .map(origin => origin.trim())
        .filter(Boolean);

    if (origins.length === 0) {
        if (!isDev) {
            errors.push("ALLOWED_ORIGINS is required in production: the comma-separated public origin(s) of the app, e.g. ALLOWED_ORIGINS=https://app.example.com");
        }
        return [];
    }

    const invalid = origins.filter(origin => {
        try {
            const url = new URL(origin);
            return url.origin !== origin || (!isDev && url.protocol !== "https:");
        } catch {
            return true;
        }
    });

    if (invalid.length > 0) {
        const requirement = isDev ? "origins" : "https origins";
        errors.push(`ALLOWED_ORIGINS must contain comma-separated ${requirement} without paths or trailing slashes (invalid: ${invalid.join(", ")}).`);
    }

    return origins;
}

function resolveSessionSecret(value: string | undefined, isDev: boolean, errors: string[], warnings: string[]): string {
    const secret = clean(value);

    if (secret === undefined) {
        if (isDev) {
            warnings.push("SESSION_SECRET is not set; using a random secret for this process, so sessions are lost on restart.");
            return crypto.randomBytes(48).toString("base64url");
        }

        errors.push(`SESSION_SECRET is required in production (min. ${MIN_SECRET_LENGTH} characters). ${GENERATE_SECRET_HINT}`);
        return "";
    }

    const problem = weakSecretProblem(secret);
    if (problem) {
        if (isDev) {
            warnings.push(`SESSION_SECRET ${problem}; this is rejected in production.`);
        } else {
            errors.push(`SESSION_SECRET ${problem}. ${GENERATE_SECRET_HINT}`);
        }
    }

    return secret;
}

function weakSecretProblem(secret: string): string | null {
    return secretWeakness(secret, MIN_SECRET_LENGTH);
}

function resolveTotpIssuer(value: string | undefined, allowedOrigins: readonly string[], errors: string[]): string {
    const configured = clean(value);
    if (configured !== undefined) {
        // The otpauth label is "issuer:account", so the issuer can't contain a colon.
        if (configured.includes(":") || configured.length > 64) {
            errors.push(`TOTP_ISSUER must be at most 64 characters without ":" (got "${configured}").`);
        }
        return configured;
    }

    try {
        return allowedOrigins[0] ? new URL(allowedOrigins[0]).hostname : "toto-stack";
    } catch {
        return "toto-stack";
    }
}

function resolveSession(session: SessionConfig | undefined, errors: string[]): ResolvedStackConfig["session"] {
    const isDuration = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;

    const absoluteTimeout = session?.absoluteTimeout ?? DEFAULT_SESSION_ABSOLUTE_TIMEOUT;
    const validAbsolute = isDuration(absoluteTimeout, 1);
    if (!validAbsolute) {
        errors.push(`session.absoluteTimeout must be a positive integer number of milliseconds (got ${String(absoluteTimeout)}).`);
    }

    // Defaults derive from the other values (only when those are valid, so one mistake is reported once).
    const idleTimeout = session?.idleTimeout ?? Math.min(DEFAULT_SESSION_IDLE_TIMEOUT, validAbsolute ? absoluteTimeout : Infinity);
    const validIdle = isDuration(idleTimeout, 1);
    if (!validIdle) {
        errors.push(`session.idleTimeout must be a positive integer number of milliseconds (got ${String(idleTimeout)}).`);
    } else if (validAbsolute && idleTimeout > absoluteTimeout) {
        errors.push(`session.idleTimeout (${idleTimeout} ms) must not exceed session.absoluteTimeout (${absoluteTimeout} ms).`);
    }

    const touchInterval = session?.touchInterval ?? Math.min(DEFAULT_SESSION_TOUCH_INTERVAL, validIdle ? Math.floor(idleTimeout / 2) : Infinity);
    if (!isDuration(touchInterval, 0)) {
        errors.push(`session.touchInterval must be a non-negative integer number of milliseconds (got ${String(touchInterval)}).`);
    } else if (validIdle && touchInterval >= idleTimeout) {
        errors.push(`session.touchInterval (${touchInterval} ms) must be shorter than session.idleTimeout (${idleTimeout} ms).`);
    }

    const cookieName = session?.cookieName ?? "connect.sid";
    if (!COOKIE_NAME_PATTERN.test(cookieName)) {
        errors.push(`session.cookieName "${cookieName}" is not a valid cookie name.`);
    } else if (/^__(host|secure)-/i.test(cookieName)) {
        errors.push(`session.cookieName "${cookieName}" must not carry a cookie prefix; "__Host-" is added automatically in production.`);
    }

    return {absoluteTimeout, idleTimeout, touchInterval, cookieName};
}

function resolveLogLevel(configured: LogLevel | undefined, envLevel: string | undefined, isDev: boolean, errors: string[]): LogLevel {
    const raw = configured ?? clean(envLevel)?.toLowerCase();
    if (raw === undefined) return defaultLogLevel(isDev);
    if (isLogLevel(raw)) return raw;

    errors.push(`LOG_LEVEL / logger.level must be one of ${LOG_LEVELS.join(", ")} (got "${String(raw)}").`);
    return "info";
}

function resolveEmail(configured: EmailConfig | undefined, env: Env, errors: string[]): ResolvedStackConfig["email"] {
    const from = clean(configured?.from ?? env.SMTP_FROM);
    if (configured?.smtp === false) return {smtp: false, from};

    const smtp: SmtpConfig | undefined = configured?.smtp ?? envSmtp(env, errors);
    if (!smtp) return {smtp: false, from};

    const host = clean(smtp.host);
    if (!host) {
        errors.push("email.smtp.host (SMTP_HOST) must not be empty.");
    }

    const secure = smtp.secure ?? false;
    const port = smtp.port ?? (secure ? 465 : 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(`SMTP_PORT / email.smtp.port must be an integer between 1 and 65535 (got "${String(port)}").`);
    }

    const user = clean(smtp.user);
    const pass = smtp.pass || undefined;
    if ((user === undefined) !== (pass === undefined)) {
        errors.push("SMTP_USER and SMTP_PASS (email.smtp.user/pass) must be set together.");
    }

    if (!from) {
        errors.push("SMTP_FROM (email.from) is required when SMTP is configured, e.g. SMTP_FROM=\"App <noreply@example.com>\".");
    }

    return {smtp: {host: host ?? "", port, secure, user, pass}, from};
}

/** SMTP settings from SMTP_* env variables; undefined when SMTP_HOST is unset. */
function envSmtp(env: Env, errors: string[]): SmtpConfig | undefined {
    const host = clean(env.SMTP_HOST);
    if (!host) return undefined;

    const rawSecure = clean(env.SMTP_SECURE)?.toLowerCase();
    if (rawSecure !== undefined && rawSecure !== "true" && rawSecure !== "false") {
        errors.push(`SMTP_SECURE must be "true" or "false" (got "${rawSecure}").`);
    }

    const rawPort = clean(env.SMTP_PORT);
    return {
        host,
        port: rawPort === undefined ? undefined : Number(rawPort),
        secure: rawSecure === "true",
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
    };
}

function resolveRoles(appRoles: readonly string[] | undefined, errors: string[]): Role[] {
    const roles: Role[] = [...BUILTIN_ROLES];

    for (const raw of appRoles ?? []) {
        const role = typeof raw === "string" ? raw.trim() : "";
        if (!role || role.length > 64) {
            errors.push(`roles: "${String(raw)}" is not a valid role name (1-64 characters).`);
            continue;
        }

        if (!roles.includes(role)) {
            roles.push(role);
        }
    }

    return roles;
}
