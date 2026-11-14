/**
 * The score of a run of the contract against the Rust server, from the
 * Vitest JSON reports its shards wrote.
 *
 *   tsx scripts/rust-score.ts --reports <dir> [--markdown <file>]
 *     [--platform <name>] [--projects <a,b>]
 *
 * Reads every `vitest.json` under `--reports`, prints the score as Markdown
 * and appends it to `--markdown` when given (CI passes the job summary).
 * `--platform` names the platform the reports were written on, as
 * `process.platform` does, and is this machine's by default; a test that runs
 * only on another is left out. `--projects` scores only those contract
 * projects, for a run of some of them. Exits non-zero when a fixture file of
 * those projects did not pass whole or no report names it, and when there is
 * no report at all.
 * `conformance/TARGET-INTERFACE.md` says how the score is counted.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_PROJECTS,
  type ContractProject,
  contractFiles,
  renderScore,
  scoreRun,
  type VitestReport,
} from "../src/utils/rust-score.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  reports: string;
  markdown?: string;
  platform: string;
  projects: readonly ContractProject[];
}

const USAGE =
  "usage: rust-score.ts --reports <dir> [--markdown <file>] [--platform <name>] [--projects <a,b>]";

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = /^--(reports|markdown|platform|projects)$/.exec(
      argv[i] ?? "",
    )?.[1];
    const value = argv[i + 1];
    if (name === undefined || value === undefined) throw new Error(USAGE);
    out[name] = value;
  }
  if (out.reports === undefined) throw new Error("--reports is required");
  const projects = (out.projects?.split(",") ?? [...CONTRACT_PROJECTS]).map(
    (name) => {
      const project = CONTRACT_PROJECTS.find((known) => known === name);
      if (project === undefined) {
        throw new Error(`--projects names ${name}, not a contract project`);
      }
      return project;
    },
  );
  return {
    reports: resolve(out.reports),
    markdown: out.markdown === undefined ? undefined : resolve(out.markdown),
    platform: out.platform ?? process.platform,
    projects,
  };
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
const inProjects = (file: string) =>
  args.projects.some((project) => file.startsWith(`src/suites/${project}/`));
const score = scoreRun(reports, contractFiles(ROOT).filter(inProjects), {
  platform: args.platform,
});
const markdown = renderScore(score);
console.log(markdown);
if (args.markdown !== undefined) appendFileSync(args.markdown, markdown);
if (score.failures.length > 0) {
  console.error(
    `${String(score.failures.length)} contract file(s) did not pass.`,
  );
  process.exitCode = 1;
}
