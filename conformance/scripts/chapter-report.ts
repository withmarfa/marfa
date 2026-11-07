/**
 * Passes by contract chapter, from a Vitest JSON report of a run of the
 * server's half.
 *
 *   MARFA_FILE_WINDOWS=<windows.json> vitest run --project compliance \\
 *     --reporter=default --reporter=json --outputFile=<vitest.json> \\
 *     --reporter=./src/utils/file-windows.ts
 *   tsx scripts/chapter-report.ts --report <vitest.json>
 *     [--state <dir> --windows <windows.json>] [--json <file>] [--markdown <file>]
 *
 * Prints the Markdown, and writes it to `--markdown` and the JSON to `--json`
 * when they are given. With `--state`, the state directory of the run's
 * server, and `--windows`, it reads `server.log` and the logs
 * `fresh-server-logs/` keeps of the servers fixtures booted, and sorts each
 * failed test file against `openapi.json`. Run it before `marfa:down`, which
 * removes both.
 *
 * The run's server's records are placed in a file by their timestamps, which
 * holds because the files run one at a time. A fixture's own server is placed
 * by when its log was kept, during that file's teardown.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chapterReport,
  operationsOf,
  readRun,
  renderMarkdown,
  requestRecords,
  sortFailedFiles,
  type RequestLog,
  type VitestJson,
} from "../src/utils/chapter-report.js";
import type { FileWindows } from "../src/utils/file-windows.js";
import { FRESH_SERVER_LOGS } from "../src/utils/fresh-server.js";
import { readIndex } from "../src/utils/spec-references.js";

const document = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../openapi.json",
);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = /^--(report|state|windows|json|markdown)$/.exec(
      argv[i] ?? "",
    )?.[1];
    const value = argv[++i];
    if (name === undefined || value === undefined) {
      throw new Error(
        "usage: chapter-report.ts --report <vitest.json> [--state <dir> --windows <file>] [--json <file>] [--markdown <file>]",
      );
    }
    out[name] = resolve(value);
  }
  if (out.report === undefined) throw new Error("--report is required");
  if ((out.state === undefined) !== (out.windows === undefined)) {
    throw new Error("--state and --windows go together");
  }
  return out;
}

function readLogs(state: string): RequestLog[] {
  const shared = join(state, "server.log");
  if (!existsSync(shared)) {
    throw new Error(`no server log at ${shared}; run this before marfa:down`);
  }
  const logs: RequestLog[] = [
    { records: requestRecords(readFileSync(shared, "utf8")) },
  ];
  const kept = join(state, FRESH_SERVER_LOGS);
  if (existsSync(kept)) {
    for (const name of readdirSync(kept)) {
      const path = join(kept, name);
      logs.push({
        records: requestRecords(readFileSync(path, "utf8")),
        at: statSync(path).mtimeMs,
      });
    }
  }
  return logs;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const run = readRun(
    JSON.parse(readFileSync(args.report, "utf8")) as VitestJson,
  );
  const report = chapterReport(readIndex(), run);
  const failed =
    args.state === undefined || args.windows === undefined
      ? undefined
      : sortFailedFiles(
          run,
          readLogs(args.state),
          JSON.parse(readFileSync(args.windows, "utf8")) as FileWindows,
          operationsOf(
            JSON.parse(readFileSync(document, "utf8")) as Parameters<
              typeof operationsOf
            >[0],
          ),
        );
  const markdown = renderMarkdown(report, failed);
  process.stdout.write(markdown);
  if (args.markdown) writeFileSync(args.markdown, markdown);
  if (args.json) {
    writeFileSync(
      args.json,
      `${JSON.stringify({ ...report, ...(failed && { failedFiles: failed }) }, null, 2)}\n`,
    );
  }
} catch (error) {
  console.error(
    `[chapter-report] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
