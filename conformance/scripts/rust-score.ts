/**
 * The score of a run of the contract against the Rust server, from the
 * Vitest JSON reports its shards wrote.
 *
 *   tsx scripts/rust-score.ts --reports <dir> [--markdown <file>]
 *
 * Reads every `vitest.json` under `--reports`, prints the score as Markdown
 * and appends it to `--markdown` when given (CI passes the job summary).
 * Exits non-zero when a file listed in `src/utils/rust-judged.ts` did not
 * pass whole or no report names it, and when there is no report at all.
 * `conformance/README.md` says how the score is counted.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUST_JUDGED } from "../src/utils/rust-judged.js";
import {
  contractFiles,
  renderScore,
  scoreRun,
  type VitestReport,
} from "../src/utils/rust-score.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): { reports: string; markdown?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = /^--(reports|markdown)$/.exec(argv[i] ?? "")?.[1];
    const value = argv[i + 1];
    if (name === undefined || value === undefined) {
      throw new Error(
        "usage: rust-score.ts --reports <dir> [--markdown <file>]",
      );
    }
    out[name] = resolve(value);
  }
  if (out.reports === undefined) throw new Error("--reports is required");
  return { reports: out.reports, markdown: out.markdown };
}

function reportsUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? reportsUnder(join(directory, entry.name))
      : entry.name === "vitest.json"
        ? [join(directory, entry.name)]
        : [],
  );
}

const args = parseArgs(process.argv.slice(2));
const paths = reportsUnder(args.reports);
if (paths.length === 0) {
  throw new Error(`no vitest.json under ${args.reports}`);
}
const reports = paths.map(
  (path) => JSON.parse(readFileSync(path, "utf8")) as VitestReport,
);
const score = scoreRun(reports, contractFiles(ROOT), RUST_JUDGED);
const markdown = renderScore(score);
console.log(markdown);
if (args.markdown !== undefined) appendFileSync(args.markdown, markdown);
if (score.failures.length > 0) {
  console.error(
    `${String(score.failures.length)} Rust-judged file(s) did not pass.`,
  );
  process.exitCode = 1;
}
