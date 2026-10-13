#!/usr/bin/env node
// Summarises CodeQL SARIF results on the workflow run (job summary + warning
// annotations) while code scanning is disabled and results can't be uploaded.
//   node .github/scripts/sarif-summary.mjs <dir-with-sarif-files>
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const results = fs.readdirSync(dir)
    .filter((file) => file.endsWith(".sarif"))
    .flatMap((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).runs.flatMap((run) => run.results ?? []));

const escape = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const lines = [
    `### CodeQL: ${results.length} result(s)`,
    "",
    "Code scanning is not enabled for this repository, so results are not uploaded. Download the `codeql-sarif` artifact for details.",
    "",
];
for (const result of results) {
    const location = result.locations?.[0]?.physicalLocation;
    const file = location?.artifactLocation?.uri ?? "unknown";
    const line = location?.region?.startLine ?? 1;
    const message = result.message?.text ?? "";
    lines.push(`- \`${result.ruleId}\` ${file}:${line}: ${message}`);
    console.log(`::warning file=${file},line=${line},title=CodeQL ${result.ruleId}::${escape(message)}`);
}

if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
else console.log(lines.join("\n"));
