// Logging rules of the config layer. A dependency-free leaf module, so the
// Logger can use them without importing StackConfig (which imports modules
// that import the Logger).

/** Log levels, lowest to highest. `silent` disables logging. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** Log output format: human-readable lines (development) or one JSON object per line (production). */
export type LogFormat = "pretty" | "json";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error", "silent"];

/** Whether `value` is a valid LOG_LEVEL / `logger.level` value. */
export function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Development mode is opt-in: only NODE_ENV=development or NODE_ENV=test. */
export function isDevelopmentEnv(nodeEnv: string | undefined): boolean {
    return nodeEnv === "development" || nodeEnv === "test";
}

export const defaultLogLevel = (isDev: boolean): LogLevel => (isDev ? "debug" : "info");
export const logFormat = (isDev: boolean): LogFormat => (isDev ? "pretty" : "json");

/**
 * Logger settings from the environment alone, with the same rules as
 * resolveConfig() (an invalid LOG_LEVEL falls back to the default here).
 * Only used for log lines emitted before createServer() configures the logger.
 */
export function loggerSettingsFromEnv(env: Record<string, string | undefined> = process.env): {level: LogLevel; format: LogFormat} {
    const isDev = isDevelopmentEnv(env.NODE_ENV?.trim());
    const level = env.LOG_LEVEL?.trim().toLowerCase();
    return {level: isLogLevel(level) ? level : defaultLogLevel(isDev), format: logFormat(isDev)};
}
