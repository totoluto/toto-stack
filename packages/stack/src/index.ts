// toto-stack public API (server side)

// Type augmentations: Express.Request#user and express-session SessionData
import "./types/augmentations";

// Server + configuration
export {createServer} from "@server/Server";
export type {Server} from "@server/Server";
export {ConfigError} from "@server/libs/config/StackConfig";
export type {
    StackConfig,
    StackHooks,
    ResolvedStackConfig,
    HttpConfig,
    SecurityConfig,
    SessionConfig,
    FrontendConfig,
    NotificationsConfig,
    NotificationHandlers,
    LoggerConfig,
    EmailConfig,
    SmtpConfig,
    ShutdownConfig,
    TrustProxy,
    CspDirectives,
} from "@server/libs/config/StackConfig";

// Dependencies (typed with the app's CustomServices augmentation)
export type {Dependencies, CustomServices, StackState} from "@server/libs/Dependencies";
export type {
    StackPrismaClient,
    StackRoleRow,
    StackUserRow,
    StackUserRoleRow,
    StackUserWithRoles,
    StackSessionRow,
    StackSessionLoadRow,
    StackSessionUser,
    StackJsonObject,
    StackJsonValue,
    StackTransactionClient,
} from "@server/libs/prisma/StackPrismaClient";

// Routes
export {BaseRoute} from "@server/routes/BaseRoute";
export type {RouteOptions, RouteHandler, BodyRouteHandler} from "@server/routes/BaseRoute";
export type {RouteClass} from "@server/routes";
export {AppError, sendError} from "@server/libs/ErrorHandler";
export type {AppErrorOptions} from "@server/libs/ErrorHandler";
export {noPayloadSchema, createUserSchema, sendNotificationSchema} from "@server/libs/security/validation";
export {ErrorCode} from "@shared/errorCodes";
export type {NoPayload, CreateUserPayload, SendNotificationPayload} from "@server/libs/security/validation";
export type {Request, Response, NextFunction, Router} from "express";

// Background work
export type {BackgroundService} from "@server/libs/background/BackgroundService";
export type {CronJob} from "@server/libs/background/CronService";

// Notifications
export type {
    NotificationHandler,
    NotificationPayload,
    NotificationHandlerOptions,
    NotificationResult,
    NotificationSendResult,
} from "@server/libs/notifications";
export {
    GenericWebhookHandler,
    DiscordHandler,
    SlackHandler,
    TelegramHandler,
    EmailHandler,
} from "@server/libs/notifications";

// Built-in services (reachable via dependencies; exported as types only)
export type {AuthService} from "@server/libs/security/AuthService";
export type {UserService} from "@server/libs/services/UserService";
export type {default as MfaService} from "@server/libs/security/MfaService";
export type {AuthRateLimiter} from "@server/libs/security/AuthRateLimiter";
export type {RequestSecurity} from "@server/libs/security/RequestSecurity";
export type {SetupService} from "@server/libs/security/SetupService";
export type {RateLimitStore, RateLimitCounter} from "@server/libs/security/RateLimitStore";
export type {RateLimitResult} from "@server/libs/security/AuthRateLimiter";
export type {EmailService, EmailOptions} from "@server/libs/services/EmailService";
export type {NotificationService} from "@server/libs/services/NotificationService";
export type {SessionStore, SessionStoreOptions} from "@server/libs/SessionStore";
export type {SessionService, SessionCookieOptions} from "@server/libs/security/SessionService";

// Helpers
export {respond} from "@server/libs/utils/helpers";
export {getRequestIP} from "@server/libs/security/clientIp";
export {Logger} from "@server/libs/Logger";
export type {LogLevel, LogFields} from "@server/libs/Logger";
export {getRequestId} from "@server/libs/RequestContext";

// Shared (client-safe) roles and types, re-exported for server use
export * from "@shared/roles";
export * from "@shared/types/user";
export * from "@shared/types/web";
