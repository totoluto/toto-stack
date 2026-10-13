import {defineConfig} from "vitest/config";
import {alias} from "./vitest.config";

/**
 * MariaDB integration suite: npm run test:integration (see
 * tests/integration/globalSetup.ts for the environment it needs).
 */
export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/integration/**/*.test.ts"],
        globalSetup: ["tests/integration/globalSetup.ts"],
        setupFiles: ["tests/setup.ts"],
        // One shared database: files run one after another, each test starts from empty tables.
        fileParallelism: false,
        isolate: true,
        unstubEnvs: true,
        testTimeout: 60_000,
        hookTimeout: 180_000,
        // The generated Prisma client is TypeScript inside node_modules/.cache; let vite transform it.
        server: {deps: {inline: [/node_modules\/\.cache\/toto-integration\//]}},
    },
    resolve: {alias},
});
