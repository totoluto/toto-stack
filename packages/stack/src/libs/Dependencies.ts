import {SessionStore} from "@server/libs/SessionStore";
import {NotificationService} from "@server/libs/services/NotificationService";
import {EmailService} from "@server/libs/services/EmailService";
import {UserService} from "@server/libs/services/UserService";
import MfaService from "@server/libs/security/MfaService";
import {AuthRateLimiter} from "@server/libs/security/AuthRateLimiter";
import {AuthService} from "@server/libs/security/AuthService";
import {RequestSecurity} from "@server/libs/security/RequestSecurity";
import {SetupService} from "@server/libs/security/SetupService";
import {SessionService} from "@server/libs/security/SessionService";
import {StackPrismaClient} from "@server/libs/prisma/StackPrismaClient";
import type {ResolvedStackConfig} from "@server/libs/config/StackConfig";
import {configureLogger} from "@server/libs/Logger";

/** Mutable runtime state of one server instance. */
export type StackState = {
    /** True once an owner account exists. A cache: initialised at boot, re-checked in the database while false. */
    setupComplete: boolean;
};

/**
 * Apps augment this interface to type the services returned by the
 * `services` factory passed to createServer(). They then appear, typed, on
 * every `Dependencies` object (e.g. `this.dependencies.socketService` in
 * routes). The augmentation must live in a module file (one with an import
 * or export):
 *
 *     declare module "toto-stack" {
 *         interface CustomServices {
 *             socketService: SocketService;
 *         }
 *     }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CustomServices {}

// Declaration merging: every Dependencies instance also carries the custom services.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface Dependencies extends CustomServices {}

/**
 * Per-server service container. Everything a route, hook or background job
 * needs hangs off this object; one instance exists per createServer() call.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Dependencies {
    /** The resolved configuration (read-only). */
    public readonly config: ResolvedStackConfig;
    /** Per-instance runtime state. */
    public readonly state: StackState = {setupComplete: false};
    public readonly prisma: StackPrismaClient;
    public readonly sessionStore: SessionStore;
    /** Session cookie, middleware and sign-in lifecycle. */
    public readonly sessionService: SessionService;
    public readonly notificationService: NotificationService;
    public readonly emailService: EmailService;
    public readonly userService: UserService;
    public readonly mfaService: MfaService;
    public readonly authRateLimiter: AuthRateLimiter;
    public readonly authService: AuthService;
    /** First-run owner setup (setup token, atomic owner creation). */
    public readonly setupService: SetupService;
    /** Origin allowlist + CSRF, shared by the middleware and the CSRF route. */
    public readonly requestSecurity: RequestSecurity;

    constructor(prisma: StackPrismaClient, config: ResolvedStackConfig) {
        this.config = config;
        // Loggers are process-wide: the most recently created server sets level and format.
        configureLogger({level: config.logger.level, format: config.logger.format});
        this.prisma = prisma;
        this.sessionStore = new SessionStore(prisma, config.session);
        this.sessionService = new SessionService(config, this.sessionStore);
        this.notificationService = new NotificationService();
        this.emailService = new EmailService(config.email);
        this.userService = new UserService(prisma, config.security.passwordHashing);
        this.mfaService = new MfaService({issuer: config.security.totpIssuer, encryptionKey: config.security.otpEncryptionKey});
        this.authRateLimiter = new AuthRateLimiter(config.security.rateLimitStore);
        this.authService = new AuthService(this.userService, this.mfaService, this.sessionService, config.security.sessionSecret);
        this.setupService = new SetupService(this.userService, this.state, config.security.setupToken);
        this.requestSecurity = new RequestSecurity(config);
    }
}
