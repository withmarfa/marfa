/**
 * Hold the statuses a run observed to the statuses the served document
 * declares. Run after a suite, against the server that suite drove:
 *
 *   tsx scripts/check-statuses.ts [--state <dir>] [--url <origin>] [--complete]
 *
 * The document is fetched from the server that wrote the log, so the two
 * describe one process. The observed table it prints is the record of what
 * the fixtures reach. Exit 1 names every status with no declaration and every
 * served route the document leaves out without a reason. `--complete` is for
 * the run that reaches every door: it also holds the declared statuses no
 * request drew to the list of the ones nothing can draw.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvFile } from "../src/utils/target.js";
import {
  formatObserved,
  formatUndeclared,
  parseRequestLines,
  reportStatuses,
  unreachedDebt,
} from "../src/utils/status-declarations.js";

interface Args {
  state: string;
  url?: string;
  complete: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { state: resolve(".marfa-state"), complete: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--state") args.state = resolve(argv[++i] ?? "");
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "--complete") args.complete = true;
    else throw new Error(`unexpected argument: ${arg ?? ""}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const logPath = resolve(args.state, "server.log");
const envPath = resolve(args.state, "env");

if (!existsSync(logPath)) {
  throw new Error(
    `no server log at ${logPath}; check:statuses reads the log of the server the suite drove, so it runs after a suite and before marfa:down`,
  );
}

const url =
  args.url ??
  process.env.MARFA_API_URL ??
  (existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, "utf8")).MARFA_API_URL
    : undefined);
if (!url) {
  throw new Error(
    "no server URL: pass --url, set MARFA_API_URL, or point --state at a state directory holding an env file",
  );
}

const response = await fetch(`${url}/openapi.json`);
if (!response.ok) {
  throw new Error(
    `GET ${url}/openapi.json answered ${String(response.status)}; the document has to come from the server that wrote the log`,
  );
}
const document = (await response.json()) as Parameters<
  typeof reportStatuses
>[1];

// The fixtures' own servers leave their logs here; see `fresh-server.ts`.
const freshLogs = resolve(args.state, "fresh-server-logs");
const logs = [
  logPath,
  ...(existsSync(freshLogs)
    ? readdirSync(freshLogs)
        .filter((name) => name.endsWith(".log"))
        .map((name) => resolve(freshLogs, name))
    : []),
];
const lines = logs.flatMap((path) =>
  parseRequestLines(readFileSync(path, "utf8")),
);
const report = reportStatuses(lines, document);

// An empty log passes every comparison there is, so say what was read.
if (report.lines === 0) {
  throw new Error(
    `${logPath} holds no request lines, so nothing was checked. Run a suite against this server first.`,
  );
}

console.log(formatObserved(report));
console.log(
  `\n${String(report.lines)} request lines from ${String(logs.length)} server${logs.length === 1 ? "" : "s"}, over ${String(report.observed.size)} published operations` +
    `, plus ${String(report.unpublished.size)} served routes the document does not publish.`,
);

if (report.undeclared.length > 0) {
  console.error(
    `\nThe server answered ${String(report.undeclared.length)} status${report.undeclared.length === 1 ? "" : "es"} its document does not declare:\n`,
  );
  console.error(formatUndeclared(report));
  process.exitCode = 1;
} else {
  console.log(
    "\nEvery status observed is declared on the operation that answered it.",
  );
}

if (report.unexplained.length > 0) {
  console.error(
    "\nServed routes the document does not publish, with no reason in UNPUBLISHED_ROUTES:\n" +
      report.unexplained.join("\n"),
  );
  process.exitCode = 1;
}

if (args.complete) {
  const { unlisted, stale } = unreachedDebt(report);
  console.log(
    `\n${String(report.unanswered.length)} declared statuses no request drew.`,
  );
  if (unlisted.length > 0) {
    console.error(
      "\nDeclared statuses no request drew and UNREACHED does not list; draw each with a fixture or list it with why:\n" +
        unlisted.join("\n"),
    );
    process.exitCode = 1;
  }
  if (stale.length > 0) {
    console.error(
      "\nUNREACHED lists statuses this run drew; remove them:\n" +
        stale.join("\n"),
    );
    process.exitCode = 1;
  }
}
