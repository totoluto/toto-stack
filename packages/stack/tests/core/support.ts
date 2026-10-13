import {createServer, StackConfig} from "toto-stack";
import fakePrisma from "../fakePrisma";
import {withTemplateRoutes} from "../templateRoutes";

/** A strong secret for production-mode tests. */
export const PROD_SECRET = "zZxxjFIrIKlTis7CU2NfHosgGWebJF9IhTQiUXO2KAyM2SZ3";

/** createServer() with the in-memory Prisma fake and the template's routes (before `routes`). */
export function makeServer(config: Omit<StackConfig, "prisma"> = {}) {
    return createServer({prisma: fakePrisma, logger: {patchConsole: false}, ...config, routes: withTemplateRoutes(config.routes)});
}

/** Valid production settings (pass with vi.stubEnv("NODE_ENV", "production")). */
export const productionConfig = {
    security: {sessionSecret: PROD_SECRET, allowedOrigins: ["https://app.example.com"]},
} satisfies Omit<StackConfig, "prisma">;
