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
 * projects, for a run of some of them. Lists the tests of the projects first,
 * to count a file that no report lists. Exits non-zero when a file listed in
 * `src/utils/rust-judged.ts` did not pass whole or no report names it, and
 * when there is no report at all.
 * `conformance/TARGET-INTERFACE.md` says how the score is counted.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUST_JUDGED } from "../src/utils/rust-judged.js";
import {
  CONTRACT_PROJECTS,
  type ContractProject,
  collectionNotes,
  contractFiles,
  countCollected,
  filesNamedIn,
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

/**
 * What `vitest list` finds in the contract projects, by file. When a file
 * fails to load Vitest prints no list at all. Then only the files it names
 * get a count, from reading them without running them (a test
 * written for several inputs counts once, so a read count can differ from a
 * run count), and every other file keeps the count its report lists. The
 * summary says so.
 */
function collect(projects: readonly ContractProject[]): {
  counts: Map<string, number>;
  notes: string[];
} {
  const run = (...extra: string[]) =>
    spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "list",
        "--json",
        ...extra,
        ...projects.flatMap((project) => ["--project", project]),
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
  const listed = (output: ReturnType<typeof run>) => {
    if (output.status !== 0) return undefined;
    try {
      return countCollected(JSON.parse(output.stdout) as { file: string }[]);
    } catch {
      return undefined;
    }
  };
  const ran = run("--staticParse=false");
  const counts = listed(ran);
  if (counts !== undefined) {
    return { counts, notes: collectionNotes(counts, []) };
  }
  console.error(`Listing the tests failed.\n${ran.stderr.slice(0, 2000)}`);
  const unrun = filesNamedIn(`${ran.stderr}${ran.stdout}`);
  const read = listed(run()) ?? new Map<string, number>();
  const used = new Map(unrun.map((file) => [file, read.get(file) ?? 0]));
  return { counts: used, notes: collectionNotes(used, unrun) };
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
const collected = collect(args.projects);
const score = scoreRun(
  reports,
  contractFiles(ROOT).filter(inProjects),
  RUST_JUDGED.filter(inProjects),
  { collected: collected.counts, platform: args.platform },
);
const markdown = renderScore(score, collected.notes);
console.log(markdown);
if (args.markdown !== undefined) appendFileSync(args.markdown, markdown);
if (score.failures.length > 0) {
  console.error(
    `${String(score.failures.length)} Rust-judged file(s) did not pass.`,
  );
  process.exitCode = 1;
}
