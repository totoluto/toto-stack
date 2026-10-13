#!/usr/bin/env node
// Release invariants (H13), checked in CI and after `changeset version`:
//   - toto-stack and create-toto-app have the same version (the changesets
//     `fixed` group). The CLI stamps `toto-stack: ^<its own version>` into new
//     apps, so a CLI release without the matching toto-stack release would
//     scaffold apps that can't install.
//   - both packages are in one `fixed` group in .changeset/config.json.
//   - the template workspace depends on `^<that version>`, so the monorepo
//     links the local toto-stack instead of installing one from npm.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const stack = readJson("packages/stack/package.json");
const cli = readJson("packages/create-toto-app/package.json");
const template = readJson("packages/create-toto-app/template/package.json");
const config = readJson(".changeset/config.json");

const problems = [];
if (stack.version !== cli.version) {
    problems.push(`toto-stack is ${stack.version} but create-toto-app is ${cli.version}; they are released in lockstep.`);
}

const lockstep = (config.fixed ?? []).some((group) => group.includes(stack.name) && group.includes(cli.name));
if (!lockstep) {
    problems.push(`.changeset/config.json must put "${stack.name}" and "${cli.name}" in one "fixed" group.`);
}

const range = template.dependencies?.[stack.name];
if (range !== `^${stack.version}`) {
    problems.push(`the template depends on ${stack.name}@${range}, expected ^${stack.version}.`);
}

if (template.private !== true) {
    problems.push("the template workspace must stay private (it is never published on its own).");
}

if (problems.length > 0) {
    console.error("Release configuration check failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}

console.log(`Release configuration OK: ${stack.name} and ${cli.name} at ${stack.version}, template depends on ^${stack.version}.`);
