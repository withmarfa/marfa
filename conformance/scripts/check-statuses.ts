/**
 * Hold the statuses a run observed to the statuses the served document
 * declares. Run after a suite, against the server that suite drove:
 *
 *   tsx scripts/check-statuses.ts [--state <dir>] [--url <origin>]
 *
 * The document is fetched from the server that wrote the log, so the two
 * describe one process. The observed table it prints is the record of what
 * the fixtures reach; exit 1 names every status with no declaration.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnvFile } from "../src/utils/target.js";
import {
  formatObserved,
  formatUndeclared,
  parseRequestLines,
  reportStatuses,
} from "../src/utils/status-declarations.js";

interface Args {
  state: string;
  url?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { state: resolve(".marfa-state") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--state") args.state = resolve(argv[++i] ?? "");
    else if (arg === "--url") args.url = argv[++i];
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

const lines = parseRequestLines(readFileSync(logPath, "utf8"));
const report = reportStatuses(lines, document);

// An empty log passes every comparison there is, so say what was read.
if (report.lines === 0) {
  throw new Error(
    `${logPath} holds no request lines, so nothing was checked. Run a suite against this server first.`,
  );
}

console.log(formatObserved(report));
console.log(
  `\n${String(report.lines)} request lines over ${String(report.observed.size)} published operations` +
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
