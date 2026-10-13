import {defineConfig} from "prisma/config";

// Load .env if present (Node's built-in loader; variables already set in the
// environment win). Docker/CI pass real env vars and need no file.
try {
    process.loadEnvFile();
} catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const DB_ENV = ["MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE"] as const;
// Prisma commands that talk to the database. Everything else (generate,
// validate, format, ...) works without DB credentials.
const DB_COMMANDS = new Set(["migrate", "db", "studio", "introspect"]);

function databaseUrl(): string | undefined {
    const missing = DB_ENV.filter((key) => !process.env[key]?.trim());
    if (missing.length > 0) {
        const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
        if (command && DB_COMMANDS.has(command)) {
            throw new Error(`prisma ${command} needs a database connection. Missing environment variable(s): ${missing.join(", ")} (see sample.env).`);
        }
        return undefined;
    }

    const env = process.env as Record<(typeof DB_ENV)[number], string>;
    // Credentials are URL-encoded so passwords containing @ : / # ? % work.
    const user = encodeURIComponent(env.MYSQL_USER);
    const password = encodeURIComponent(env.MYSQL_PASSWORD);
    const database = encodeURIComponent(env.MYSQL_DATABASE);
    return `mysql://${user}:${password}@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${database}`;
}

const url = databaseUrl();

export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: {
        path: "prisma/migrations",
    },
    ...(url && {
        datasource: {
            url,
            // Optional: `prisma migrate dev` needs a throwaway shadow database.
            // The dev compose setup lets MYSQL_USER create one; otherwise point
            // this at a database/user that can (never needed in production).
            ...(process.env.SHADOW_DATABASE_URL && {shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL}),
        },
    }),
});
