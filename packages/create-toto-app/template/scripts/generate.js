// postinstall: generate the Prisma client (prisma/client) when the Prisma CLI
// is installed. It's a devDependency, so production-only installs
// (`npm ci --omit=dev`, NODE_ENV=production) skip this instead of failing:
// the production bundle already contains the generated client.
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

let cli;
try {
    const pkgPath = require.resolve("prisma/package.json");
    const {bin} = JSON.parse(readFileSync(pkgPath, "utf8"));
    cli = path.join(path.dirname(pkgPath), typeof bin === "string" ? bin : bin.prisma);
} catch {
    console.log("Prisma CLI not installed (production install?): skipping `prisma generate`.");
    process.exit(0);
}

const result = spawnSync(process.execPath, [cli, "generate"], {stdio: "inherit"});
process.exit(result.status ?? 1);
