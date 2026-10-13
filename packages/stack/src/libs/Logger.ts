import chalk from "chalk";
import pino from "pino";
import {formatWithOptions, inspect} from "node:util";
import {getRequestId} from "@server/libs/RequestContext";
import {loggerSettingsFromEnv, type LogFormat, type LogLevel} from "@server/libs/config/logging";

export type {LogFormat, LogLevel};

/** Structured fields attached to a log line. An `err` field is serialized as an error. */
export type LogFields = Record<string, unknown>;

type EmittingLevel = Exclude<LogLevel, "silent">;

const LEVEL_RANK: Record<LogLevel, number> = {debug: 20, info: 30, warn: 40, error: 50, silent: Infinity};

const LEVEL_STYLE: Record<EmittingLevel, chalk.Chalk> = {
    debug: chalk.green,
    info: chalk.hex("#749BC7"),
    warn: chalk.yellow,
    error: chalk.red,
};

type Settings = {level: LogLevel; format: LogFormat};

let settings: Settings | undefined;
let jsonRoot: pino.Logger | undefined;

/**
 * Until createServer() configures the logger, the settings come from the
 * environment at the FIRST log call (not at import, so values loaded by
 * dotenv before the first log line are honoured), with the config layer's rules.
 */
function currentSettings(): Settings {
    settings ??= loggerSettingsFromEnv(process.env);
    return settings;
}

/**
 * Sets the process-wide log level and format. createServer() calls this with
 * the resolved `logger.level` and the server mode; until then the values come
 * from LOG_LEVEL / NODE_ENV at the first log call. Pass `undefined` to reset to
 * the environment defaults (used by tests).
 */
export function configureLogger(next: Partial<Settings> | undefined): void {
    settings = next === undefined ? undefined : {...currentSettings(), ...next};
    jsonRoot = undefined;
}

function json(): pino.Logger {
    // Created lazily (first JSON log line), writes synchronously to stdout.
    jsonRoot ??= pino({
        level: "debug",
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {level: label => ({level: label})},
    });
    return jsonRoot;
}

/** Normalises the optional second argument of a log call into fields. */
function toFields(details: unknown): LogFields | undefined {
    if (details === undefined) return undefined;
    if (details instanceof Error) return {err: details};
    if (typeof details === "object" && details !== null && !Array.isArray(details)) return details as LogFields;
    return {detail: details};
}

function prettyLine(level: EmittingLevel, service: string, message: string, fields: LogFields | undefined): string {
    const requestId = getRequestId();
    const prefix = chalk.gray(`[${new Date().toISOString()}]`)
        + `[${LEVEL_STYLE[level](level.toUpperCase())}][${chalk.cyan(service)}]`
        + (requestId ? chalk.gray(`[${requestId.slice(0, 8)}]`) : "");

    let line = `${prefix} ${message}`;
    if (fields) {
        const {err, ...rest} = fields;
        if (Object.keys(rest).length > 0) {
            line += ` ${inspect(rest, {colors: chalk.level > 0, depth: 4, breakLength: Infinity, compact: true})}`;
        }
        if (err !== undefined) {
            line += `\n${inspect(err, {colors: chalk.level > 0, depth: 4})}`;
        }
    }

    return `${line}\n`;
}

/**
 * Logger tagged with an explicit service name.
 *
 *     const log = new Logger("Billing");
 *     log.info("Invoice sent", {invoiceId});
 *     log.error("Charge failed", err);  // Error serialized under `err`
 *
 * Development (NODE_ENV=development|test): coloured lines; debug/info go to
 * stdout, warn/error to stderr. Production: one JSON object per line on stdout
 * (`{level, time, service, requestId?, msg, ...fields}`).
 *
 * The level comes from `logger.level` / LOG_LEVEL (default: debug in
 * development, info in production).
 */
export class Logger {
    constructor(public readonly service: string = "Global") {}

    debug(message: string, details?: unknown): void {
        this.write("debug", message, details);
    }

    info(message: string, details?: unknown): void {
        this.write("info", message, details);
    }

    warn(message: string, details?: unknown): void {
        this.write("warn", message, details);
    }

    /** `details` may be an Error (logged under `err`) or an object of fields. */
    error(message: string, details?: unknown): void {
        this.write("error", message, details);
    }

    private write(level: EmittingLevel, message: string, details: unknown): void {
        const {level: threshold, format} = currentSettings();
        if (LEVEL_RANK[level] < LEVEL_RANK[threshold]) return;

        const fields = toFields(details);

        if (format === "json") {
            const requestId = getRequestId();
            json()[level]({...fields, service: this.service, ...(requestId ? {requestId} : {})}, message);
            return;
        }

        // Written to the streams directly (never through console.*), so a
        // patched console can't add a second prefix.
        const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
        stream.write(prettyLine(level, this.service, message, fields));
    }
}

type ConsoleMethodName = "log" | "info" | "debug" | "warn" | "error";

const CONSOLE_LEVELS: Record<ConsoleMethodName, EmittingLevel> = {
    log: "info",
    info: "info",
    debug: "debug",
    warn: "warn",
    error: "error",
};

const consoleLogger = new Logger("console");
let consolePatched = false;

function logConsoleCall(level: EmittingLevel, args: unknown[]): void {
    if (currentSettings().format === "json") {
        // Keep the first Error structured (under `err`); format the rest as the message.
        const errorIndex = args.findIndex(arg => arg instanceof Error);
        const rest = errorIndex === -1 ? args : args.filter((_, index) => index !== errorIndex);
        const message = formatWithOptions({colors: false, depth: 8, breakLength: Infinity}, ...rest);
        consoleLogger[level](message, errorIndex === -1 ? undefined : {err: args[errorIndex]});
        return;
    }

    consoleLogger[level](formatWithOptions({colors: chalk.level > 0, depth: 8, breakLength: 120}, ...args));
}

/**
 * Routes console.log/info/debug/warn/error through the Logger (service
 * "console"), so third-party output gets the same format and level filter.
 * No stack trace is captured per call. Returns a function that restores the
 * previous console methods (a no-op if the patch was already installed).
 */
export function installConsoleLogger(): () => void {
    if (consolePatched) {
        return () => undefined;
    }

    const previous = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
    for (const name of Object.keys(CONSOLE_LEVELS) as ConsoleMethodName[]) {
        const level = CONSOLE_LEVELS[name];
        console[name] = (...args: unknown[]) => logConsoleCall(level, args);
    }

    consolePatched = true;

    return () => {
        Object.assign(console, previous);
        consolePatched = false;
    };
}
