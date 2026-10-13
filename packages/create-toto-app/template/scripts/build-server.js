// Bundles the server into dist/server.js (ESM) and copies the built client
// (server/public, produced by `npm run build:client`) to dist/public.
//
// npm packages stay external (resolved from node_modules at runtime), except
// the Prisma client runtime: it is bundled together with the generated client
// so @prisma/client can be a devDependency. Otherwise npm keeps its optional
// peers (the prisma CLI, typescript) in production installs (--omit=dev).
import {build} from "esbuild";
import {cpSync, existsSync, rmSync} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "dist");
const publicDir = path.join(root, "server", "public");

// Bare imports that get bundled instead of resolved from node_modules.
const BUNDLED = /^(@prismaClient\/|@prisma\/client(-runtime-utils)?(\/|$))/;

const externalizePackages = {
    name: "externalize-packages",
    setup(pluginBuild) {
        pluginBuild.onResolve({filter: /^[^./]/}, (args) =>
            BUNDLED.test(args.path) ? undefined : {path: args.path, external: true});
    },
};

rmSync(outDir, {recursive: true, force: true});

await build({
    absWorkingDir: root,
    entryPoints: {server: "server/index.ts"},
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.12",
    plugins: [externalizePackages],
    // Bundled CommonJS code (inside the Prisma runtime) calls require().
    banner: {js: 'import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);'},
    tsconfig: path.join(root, "tsconfig.json"),
    logLevel: "info",
});

if (existsSync(publicDir)) {
    cpSync(publicDir, path.join(outDir, "public"), {recursive: true});
    console.log("Copied server/public -> dist/public");
} else {
    console.warn("server/public not found: run `npm run build:client` first, or the server will have no frontend to serve.");
}
