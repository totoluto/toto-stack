import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** Source aliases, shared with vitest.integration.config.ts. */
export const alias = [
    {find: "toto-stack/shared", replacement: fromRoot("./src/shared.ts")},
    {find: "toto-stack/client", replacement: fromRoot("./src/client.ts")},
    {find: "toto-stack", replacement: fromRoot("./src/index.ts")},
    {find: /^@server\//, replacement: fromRoot("./src/")},
    {find: /^@shared\//, replacement: fromRoot("./src/shared/")},
    // The scaffolded app's client code, tested in tests/template.
    {find: /^@client\//, replacement: fromRoot("../create-toto-app/template/client/src/")},
];

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // The MariaDB suite has its own config (npm run test:integration).
        exclude: ["tests/integration/**", "**/node_modules/**"],
        setupFiles: ["tests/setup.ts"],
        // Every file gets fresh module state (including the shared fake database);
        // env and global stubs are undone before each test.
        isolate: true,
        unstubEnvs: true,
        unstubGlobals: true,
        testTimeout: 30000,
        hookTimeout: 30000,
        // npm run test:coverage. Thresholds sit a little below the measured
        // coverage (see the testing PR notes); raise them as coverage grows.
        coverage: {
            provider: "v8",
            include: ["src/**/*.{ts,tsx}"],
            exclude: ["src/**/*.d.ts"],
            reporter: ["text-summary", "text", "html", "json-summary", "lcov"],
            reportsDirectory: "coverage",
            thresholds: {lines: 92, branches: 85, functions: 90, statements: 91},
        },
    },
    resolve: {alias},
});
