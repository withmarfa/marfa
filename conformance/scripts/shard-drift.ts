/**
 * Compares the file times one shard measured with `shard-weights.ts`, warns
 * about each file that has drifted and writes the table to the job summary.
 * It never fails: a stale weight costs balance, never a file. Usage:
 * `tsx scripts/shard-drift.ts <times.json>`, the file the shard's run wrote
 * through `src/utils/shard-times-reporter.ts`.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { compareTimes, summaryTable } from "../src/utils/shard-drift.js";

const [source] = process.argv.slice(2);
if (source === undefined) {
  console.log("No times file given; nothing to compare.");
  process.exit(0);
}

let measured: Record<string, number>;
try {
  measured = JSON.parse(readFileSync(source, "utf8")) as Record<string, number>;
} catch {
  console.log(`::warning::No shard times at ${source}; weights not checked.`);
  process.exit(0);
}

const rows = compareTimes(measured);
for (const row of rows.filter((r) => r.drifted)) {
  console.log(
    `::warning::${row.path} took ${row.measured.toFixed(0)} s against a weight of ${String(row.weight)} s; update src/utils/shard-weights.ts.`,
  );
}
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== "") {
  appendFileSync(summary, `### Shard weights\n\n${summaryTable(rows)}\n`);
} else {
  console.log(summaryTable(rows));
}
