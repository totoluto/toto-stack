/** What globalSetup.ts hands to the integration tests (vitest provide/inject). */
export type IntegrationDb =
    | {available: true; url: string; clientPath: string}
    | {available: false; reason: string};

declare module "vitest" {
    export interface ProvidedContext {
        integrationDb: IntegrationDb;
    }
}
