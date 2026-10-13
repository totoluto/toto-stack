import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createServer as createHttpServer, Server as HttpServer} from "node:http";
import type {AddressInfo} from "node:net";
import express, {Express} from "express";
import helmet from "helmet";
import {installConsoleLogger, Logger} from "@server/libs/Logger";
import {registerApiRoutes, registerFrontendRoutes, registerSessionlessApiRoutes} from "@server/routes";
import {Dependencies} from "@server/libs/Dependencies";
import {BackgroundServiceManager} from "@server/libs/background/BackgroundServiceManager";
import {CronService} from "@server/libs/background/CronService";
import {SessionCleanup} from "@server/libs/background/jobs";
import {createErrorHandler, notFoundHandler} from "@server/libs/ErrorHandler";
import {RateLimiter} from "@server/libs/security/RateLimiter";
import {requestContextMiddleware} from "@server/libs/RequestContext";
import {CspDirectives, ResolvedStackConfig, resolveConfig, StackConfig, StackHooks} from "@server/libs/config/StackConfig";

const DEFAULT_CSP_DIRECTIVES: CspDirectives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    imgSrc: ["'self'", "data:"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
};

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
/** With handleSignals: extra time after shutdown.timeoutMs before a stuck process is force-exited. */
const SIGNAL_EXIT_GRACE_MS = 5_000;

/**
 * One toto-stack server. Create it with createServer(). Its state (rate
 * limits, setup state, sessions, timers, services) belongs to the instance,
 * and nothing runs before start(). Two things are process-wide, because
 * loggers and `console` are: the log level/format (set by the most recently
 * created server) and the console patch (installed by the first server
 * started with `logger.patchConsole`, undone when that server stops).
 */
export class Server {
    /** The service container passed to routes, hooks and background services. */
    public readonly dependencies: Dependencies;

    private readonly options: StackConfig;
    private readonly hooks: StackHooks;
    private readonly backgroundServices: BackgroundServiceManager;
    private readonly rateLimiter = new RateLimiter(60 * 1000, 1000);
    private readonly logger = new Logger("Server");

    private appPromise?: Promise<Express>;
    private startPromise?: Promise<void>;
    private stopPromise?: Promise<void>;
    private server?: HttpServer;
    private ready = false;
    private restoreConsole?: () => void;
    private signalShutdown = false;
    private readonly onSignal = (signal: NodeJS.Signals) => this.handleSignal(signal);

    /** Prefer createServer(). Throws a ConfigError when the configuration is invalid. */
    constructor(options: StackConfig) {
        const {config, warnings} = resolveConfig(options);
        this.options = options;
        this.hooks = options.hooks ?? {};
        this.dependencies = new Dependencies(options.prisma, config);

        for (const warning of warnings) {
            this.logger.warn(warning);
        }

        this.attachCustomServices();
        this.registerNotificationHandlers();

        this.backgroundServices = new BackgroundServiceManager([
            new CronService([
                new SessionCleanup(this.dependencies.prisma),
                ...(options.cronJobs?.(this.dependencies) ?? []),
            ], {stopTimeoutMs: config.shutdown.timeoutMs}),
            ...(options.backgroundServices?.(this.dependencies) ?? []),
        ]);
    }

    /** The resolved configuration. */
    public get config(): ResolvedStackConfig {
        return this.dependencies.config;
    }

    /** The Node HTTP server while the server is started (undefined otherwise). */
    public get httpServer(): HttpServer | undefined {
        return this.server;
    }

    /**
     * Initialises the database state (setup flag, roles) and builds the
     * Express app without binding a port. Idempotent: every call returns the
     * same app. Used by start() and by integration tests.
     */
    public createApp(): Promise<Express> {
        this.appPromise ??= this.buildApp().catch(err => {
            this.appPromise = undefined;
            throw err;
        });

        return this.appPromise;
    }

    /**
     * Builds the app, listens, starts background services, then runs onReady.
     * Rejects with the original error (e.g. EADDRINUSE) if any step fails,
     * after best-effort cleanup. Signal handlers are only installed with
     * `shutdown.handleSignals: true`.
     */
    public start(): Promise<void> {
        if (this.stopPromise) {
            return Promise.reject(new Error("This server has been stopped; create a new one to start again."));
        }

        this.startPromise ??= this.doStart();
        return this.startPromise;
    }

    /**
     * Graceful shutdown, in this order:
     * 1. `hooks.beforeShutdown` (only if onReady ran): close websocket servers
     *    and other long-lived connections so they don't hold up the drain.
     * 2. Stop accepting connections and let in-flight requests finish; those
     *    still open after `shutdown.timeoutMs` are closed.
     * 3. Stop cron jobs (aborted, then awaited up to `shutdown.timeoutMs`)
     *    and background services, in reverse start order.
     * 4. Release the stack's own resources (rate-limiter timers, SMTP pool),
     *    undo the console patch.
     * 5. `hooks.onShutdown` (only if onReady ran): nothing uses the database
     *    any more, so disconnect the app's Prisma client here.
     *
     * Every step runs even if an earlier one fails; failures are rethrown
     * together at the end. Idempotent: repeated calls return the same promise.
     * The stack never disconnects the app-owned Prisma client itself.
     */
    public stop(): Promise<void> {
        this.stopPromise ??= (async () => {
            // Let an in-flight start() settle first (a failed start cleans up itself).
            await this.startPromise?.catch(() => undefined);
            await this.shutdown();
        })();

        return this.stopPromise;
    }

    private async doStart(): Promise<void> {
        const {config} = this.dependencies;

        try {
            if (config.logger.patchConsole) {
                this.restoreConsole = installConsoleLogger();
            }

            const app = await this.createApp();
            this.server = createHttpServer(app);
            await this.hooks.onHttpServerCreated?.(this.server, this.dependencies);
            await this.listen(this.server);

            this.rateLimiter.startCleanup();
            this.dependencies.authRateLimiter.start();
            await this.backgroundServices.startAll();

            if (config.shutdown.handleSignals) {
                for (const signal of SHUTDOWN_SIGNALS) process.on(signal, this.onSignal);
            }

            await this.hooks.onReady?.(this.dependencies);
            this.ready = true;
        } catch (err) {
            await this.shutdown().catch(cleanupError => {
                this.logger.error(`Cleanup after failed start also failed: ${describe(cleanupError)}`);
            });
            throw err;
        }
    }

    private async shutdown(): Promise<void> {
        const errors: unknown[] = [];
        const attempt = async (step: () => unknown) => {
            try {
                await step();
            } catch (err) {
                errors.push(err);
            }
        };

        // A signal-initiated shutdown keeps its handlers until the end (a second signal forces the exit).
        if (!this.signalShutdown) this.removeSignalHandlers();

        const wasReady = this.ready;
        this.ready = false;

        if (wasReady) {
            await attempt(() => this.hooks.beforeShutdown?.(this.dependencies));
        }

        await attempt(() => this.closeHttpServer());
        await attempt(() => this.backgroundServices.stopAll());
        this.rateLimiter.stopCleanup();
        await attempt(() => this.dependencies.authRateLimiter.stop());
        await attempt(() => this.dependencies.emailService.close());

        this.restoreConsole?.();
        this.restoreConsole = undefined;

        if (wasReady) {
            await attempt(() => this.hooks.onShutdown?.(this.dependencies));
        }

        if (errors.length === 1) {
            throw errors[0];
        }

        if (errors.length > 1) {
            throw new AggregateError(errors, "Server shutdown failed");
        }
    }

    /**
     * SIGINT/SIGTERM with `shutdown.handleSignals`: run stop(), then set
     * process.exitCode (0, or 1 if stop() failed) and let the process exit
     * by itself once nothing keeps it alive. If it is still running
     * `shutdown.timeoutMs` + 5 s after the signal, it is force-exited (a hung
     * hook or a leaked handle). A second signal during shutdown exits
     * immediately with 128 + the signal number.
     */
    private handleSignal(signal: NodeJS.Signals): void {
        if (this.signalShutdown) {
            this.logger.warn(`Received ${signal} again; exiting immediately.`);
            process.exit(128 + (os.constants.signals[signal] ?? 0));
        }

        this.signalShutdown = true;
        this.logger.info(`Received ${signal}, shutting down gracefully (send it again to exit immediately).`);

        const deadlineMs = this.dependencies.config.shutdown.timeoutMs + SIGNAL_EXIT_GRACE_MS;
        const fallback = setTimeout(() => {
            this.logger.error(`Process still running ${deadlineMs} ms after ${signal}: a shutdown step hangs or something keeps the event loop alive (e.g. an open database connection). Forcing exit.`);
            process.exit(process.exitCode ?? 1);
        }, deadlineMs);
        fallback.unref();

        this.stop().then(
            () => {
                process.exitCode ??= 0;
            },
            err => {
                this.logger.error("Shutdown failed", err);
                process.exitCode = 1;
            },
        ).finally(() => this.removeSignalHandlers());
    }

    private removeSignalHandlers(): void {
        for (const signal of SHUTDOWN_SIGNALS) process.off(signal, this.onSignal);
    }

    private async buildApp(): Promise<Express> {
        const {config, requestSecurity, sessionService} = this.dependencies;
        await this.initializeData();

        const app = express();
        app.set("trust proxy", config.http.trustProxy);
        app.use(requestContextMiddleware);
        app.use(helmet({
            contentSecurityPolicy: config.security.csp === false ? false : {
                directives: {
                    ...DEFAULT_CSP_DIRECTIVES,
                    upgradeInsecureRequests: config.isDev ? null : [],
                    ...config.security.csp,
                },
            },
            crossOriginEmbedderPolicy: false,
            frameguard: {action: "deny"},
            referrerPolicy: {policy: "same-origin"},
        }));
        app.use(requestSecurity.originMiddleware.bind(requestSecurity));
        app.use(this.rateLimiter.middleware());

        // App middleware that must run before body parsing, session and CSRF (e.g. raw-body webhooks).
        await this.hooks.configureApp?.(app, this.dependencies);

        // Health checks and the SPA need no session: mounted before it, they cost no session lookup.
        app.use("/api", registerSessionlessApiRoutes(this.dependencies));
        if (config.frontend) {
            this.checkFrontendDir(config.frontend.dir);
            app.use(registerFrontendRoutes(config.frontend));
        }

        app.use(express.json({limit: config.http.bodyLimit}));
        app.use(express.urlencoded({extended: true, limit: config.http.bodyLimit}));
        // Sessions only exist for the API (the only place that reads them).
        app.use("/api", sessionService.middleware());
        app.use("/api", requestSecurity.csrfMiddleware.bind(requestSecurity));
        app.use("/api", registerApiRoutes(this.dependencies, this.options.routes ?? []));

        app.use(notFoundHandler);
        app.use(createErrorHandler({isDev: config.isDev}));

        return app;
    }

    private async initializeData(): Promise<void> {
        await this.dependencies.setupService.initialize();
        await this.syncRoles();
    }

    /** Creates configured roles that are missing. Never deletes roles. */
    private async syncRoles(): Promise<void> {
        const {prisma, config} = this.dependencies;
        const existing = new Set((await prisma.role.findMany({select: {name: true}})).map(role => role.name));

        const missing = config.roles.filter(role => !existing.has(role));
        for (const name of missing) {
            // upsert instead of createMany({skipDuplicates}) - portable across databases and boot races
            await prisma.role.upsert({where: {name}, create: {name}, update: {}});
        }

        if (missing.length > 0) {
            this.logger.info(`Created roles: ${missing.join(", ")}`);
        }

        const unknown = [...existing].filter(role => !config.roles.includes(role));
        if (unknown.length > 0) {
            this.logger.debug(`Keeping database roles that are not configured: ${unknown.join(", ")}`);
        }
    }

    private attachCustomServices(): void {
        const custom = this.options.services?.(this.dependencies);
        if (!custom) return;

        for (const key of Object.keys(custom)) {
            if (key in this.dependencies) {
                throw new Error(`services: "${key}" conflicts with a built-in dependency; choose another name.`);
            }
        }

        Object.assign(this.dependencies, custom);
    }

    private registerNotificationHandlers(): void {
        const configured = this.options.notifications?.handlers;
        const handlers = typeof configured === "function" ? configured(this.dependencies) : configured ?? {};

        for (const [id, handler] of Object.entries(handlers)) {
            this.dependencies.notificationService.registerHandler(id, handler);
        }
    }

    private checkFrontendDir(dir: string): void {
        if (fs.existsSync(path.join(dir, "index.html"))) return;

        const message = `frontend.dir has no index.html (${dir}); build the client first. Non-API routes will return 404.`;
        if (this.dependencies.config.isDev) {
            this.logger.debug(message);
        } else {
            this.logger.warn(message);
        }
    }

    private listen(server: HttpServer): Promise<void> {
        const {port, host} = this.dependencies.config.http;

        return new Promise((resolve, reject) => {
            const onError = (err: Error) => {
                server.off("listening", onListening);
                reject(err);
            };
            const onListening = () => {
                server.off("error", onError);
                server.on("error", err => this.logger.error(`HTTP server error: ${describe(err)}`));
                this.logListening(server);
                resolve();
            };

            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(port, host);
        });
    }

    private logListening(server: HttpServer): void {
        const {config} = this.dependencies;
        const address = server.address() as AddressInfo | null;
        const host = config.http.host;
        const displayHost = !host || host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
        const mode = config.isDev ? "development" : "production";

        this.logger.info(`Server listening on http://${displayHost}:${address?.port ?? config.http.port} (${mode} mode)`);
    }

    private async closeHttpServer(): Promise<void> {
        const server = this.server;
        this.server = undefined;

        if (!server?.listening) {
            return;
        }

        const {timeoutMs} = this.dependencies.config.shutdown;
        await new Promise<void>((resolve, reject) => {
            // Keep-alive connections become idle when their in-flight response ends; close
            // them as they do, otherwise they hold server.close() open until the timeout.
            const sweep = setInterval(() => server.closeIdleConnections(), 25);
            sweep.unref();
            const timer = setTimeout(() => {
                clearInterval(sweep);
                this.logger.warn(`Connections still open after ${timeoutMs} ms; closing them.`);
                server.closeAllConnections();
                resolve();
            }, timeoutMs);
            timer.unref();

            server.close(err => {
                clearInterval(sweep);
                clearTimeout(timer);
                if (err) reject(err);
                else resolve();
            });
            server.closeIdleConnections();
        });
    }
}

function describe(err: unknown): string {
    return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * Creates a toto-stack server: `await createServer(config).start()`.
 * The configuration is resolved and validated immediately (throws a
 * ConfigError listing every problem). Nothing is started until start().
 */
export function createServer(config: StackConfig): Server {
    return new Server(config);
}
