// @ts-check
// Plain ESM (not .ts) and loaded with `--config-loader native` so the build
// also works on Node versions without built-in type stripping (< 22.18).
import {builtinModules} from "node:module";
import {defineConfig} from "tsdown";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        client: "src/client.ts",
        shared: "src/shared.ts",
    },
    format: "esm",
    // One build for all entries so code and declarations shared between them
    // (e.g. the Role enum) live in a single chunk instead of being duplicated.
    // "neutral" keeps the client/shared entries free of Node assumptions; the
    // server entry is fine with it because every import is left external.
    platform: "neutral",
    target: "es2022",
    deps: {
        neverBundle: [/^node:/, ...builtinModules],
        // Fail the build if anything from node_modules would be inlined.
        // Inlining a CJS devDependency (speakeasy) is what broke the ESM build.
        onlyBundle: [],
    },
    dts: true,
    // Maps embed sourcesContent so stack traces (node --enable-source-maps)
    // and debuggers resolve to the TypeScript sources, which are not shipped.
    sourcemap: true,
    clean: true,
});
