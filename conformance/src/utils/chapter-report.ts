import type { FileWindows } from "./file-windows.js";
import type { SpecIndex } from "./spec-references.js";
import { citationsIn, statementText } from "./spec-statements.js";

/**
 * Passes by contract chapter, from a Vitest JSON report: the statements in a
 * chapter whose cited tests all passed, and the cited tests by outcome. The
 * whole run's figures are Vitest's own, and a report that disagrees with them
 * is refused. A failed test file is sorted by whether it reached an operation
 * the published document declares and the target has no route for.
 */

/**
 * `failed` and `passed` are Vitest's. A test Vitest skipped is `blocked` when
 * its file failed around it, in a hook or at import, and `skipped` otherwise.
 */
export type Outcome = "passed" | "failed" | "blocked" | "skipped";

/** The part of Vitest's JSON report this reads. */
export interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: {
      ancestorTitles: string[];
      title: string;
      status: string;
      failureMessages?: string[] | null;
    }[];
  }[];
}

export interface RunTest {
  /** By path under `src/suites/`, as the chapters cite it. */
  file: string;
  /** The describe titles, outermost first, then the test's own. */
  titles: string[];
  outcome: Outcome;
}

export interface RunFile {
  /** The absolute path, as the file windows name it. */
  path: string;
  file: string;
  failed: boolean;
  /** The file's own error and every failed test's, in order. */
  messages: string[];
}

export interface Run {
  files: RunFile[];
  tests: RunTest[];
}

/** A fixture's path under `src/suites/`, from the absolute path Vitest reports. */
function suitePath(name: string): string {
  const at = name.lastIndexOf("/src/suites/");
  return at < 0 ? name : name.slice(at + "/src/suites/".length);
}

function outcomeOf(status: string, fileFailed: boolean): Outcome {
  if (status === "passed" || status === "failed") return status;
  return fileFailed ? "blocked" : "skipped";
}

export function readRun(report: VitestJson): Run {
  const files: RunFile[] = [];
  const tests: RunTest[] = [];
  for (const result of report.testResults) {
    const file = suitePath(result.name);
    const fileFailed = result.status === "failed";
    files.push({
      path: result.name,
      file,
      failed: fileFailed,
      messages: [
        ...(result.message ? [result.message] : []),
        ...result.assertionResults.flatMap((a) => a.failureMessages ?? []),
      ],
    });
    for (const a of result.assertionResults) {
      tests.push({
        file,
        titles: [...a.ancestorTitles, a.title],
        outcome: outcomeOf(a.status, fileFailed),
      });
    }
  }
  const counted = count(tests.map((test) => test.outcome));
  const skipped = counted.blocked + counted.skipped;
  if (
    counted.passed !== report.numPassedTests ||
    counted.failed !== report.numFailedTests ||
    skipped !== report.numPendingTests + report.numTodoTests ||
    tests.length !== report.numTotalTests
  ) {
    throw new Error(
      `the run reads as ${String(counted.passed)} passed, ${String(counted.failed)} failed and ${String(skipped)} skipped, and Vitest counted ${String(report.numPassedTests)}, ${String(report.numFailedTests)} and ${String(report.numPendingTests + report.numTodoTests)}`,
    );
  }
  return { files, tests };
}

export interface Counts {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface ChapterRow {
  chapter: string;
  statements: number;
  /** Statements whose Tests paragraph cites no fixture. */
  uncited: number;
  /** Statements with at least one citation, every cited test of which passed. */
  passed: number;
  tests: Counts;
  /** Citations that name a test or file the run does not hold. */
  citedNotInRun: number;
}

export interface ChapterReport {
  chapters: ChapterRow[];
  /** Tests in the run that no statement cites. */
  uncitedTests: Counts;
  totals: {
    statements: number;
    uncited: number;
    passed: number;
    /** Every test in the run, once. */
    tests: Counts;
    /** Citations that name a test or file the run does not hold. */
    citedNotInRun: number;
  };
}

function count(outcomes: Iterable<Outcome>): Counts {
  const counts: Counts = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const outcome of outcomes) counts[outcome] += 1;
  return counts;
}

const keyOf = (test: RunTest) => [test.file, ...test.titles].join(" › ");

/**
 * A citation names a file, or a file and a test or describe title in it,
 * as `spec-citations.test.ts` holds them; a describe title cites every test
 * under it.
 */
export function chapterReport(index: SpecIndex, run: Run): ChapterReport {
  const byFile = new Map<string, RunTest[]>();
  for (const test of run.tests) {
    const list = byFile.get(test.file) ?? [];
    list.push(test);
    byFile.set(test.file, list);
  }
  const cited = new Set<string>();
  const missing = new Set<string>();
  const chapters: ChapterRow[] = [];
  for (const [chapter, { statements }] of [...index.chapters].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const chapterTests = new Map<string, Outcome>();
    const chapterMissing = new Set<string>();
    let uncited = 0;
    let passed = 0;
    for (const statement of statements) {
      const citations = citationsIn(statementText(statement));
      if (citations.length === 0) {
        uncited += 1;
        continue;
      }
      let allPassed = true;
      for (const citation of citations) {
        const title = citation.title?.replace(/\\`/g, "`");
        const matched = (byFile.get(citation.file) ?? []).filter(
          (test) => title === undefined || test.titles.includes(title),
        );
        if (matched.length === 0) {
          const key = [citation.file, ...(title ? [title] : [])].join(" › ");
          missing.add(key);
          chapterMissing.add(key);
          allPassed = false;
        }
        for (const test of matched) {
          cited.add(keyOf(test));
          chapterTests.set(keyOf(test), test.outcome);
          if (test.outcome !== "passed") allPassed = false;
        }
      }
      if (allPassed) passed += 1;
    }
    chapters.push({
      chapter,
      statements: statements.length,
      uncited,
      passed,
      tests: count(chapterTests.values()),
      citedNotInRun: chapterMissing.size,
    });
  }
  const sum = (pick: (row: ChapterRow) => number) =>
    chapters.reduce((total, row) => total + pick(row), 0);
  return {
    chapters,
    uncitedTests: count(
      run.tests.filter((t) => !cited.has(keyOf(t))).map((t) => t.outcome),
    ),
    totals: {
      statements: sum((r) => r.statements),
      uncited: sum((r) => r.uncited),
      passed: sum((r) => r.passed),
      tests: count(run.tests.map((t) => t.outcome)),
      citedNotInRun: missing.size,
    },
  };
}

/** One request a target logged. */
export interface RequestRecord {
  at: number;
  method: string;
  path: string;
  /** Absent when no route answered. */
  route?: string;
}

/**
 * A target's request log. The run's own server's records are placed by
 * their timestamps. A server a fixture booted for itself belongs wholly to
 * the file running when its log was kept (`at`).
 */
export interface RequestLog {
  records: RequestRecord[];
  at?: number;
}

/** The request records of a log's text; log records and stray lines are left out. */
export function requestRecords(text: string): RequestRecord[] {
  const out: RequestRecord[] = [];
  for (const line of text.split("\n")) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    if (typeof record.level === "string" && typeof record.message === "string")
      continue;
    if (typeof record.method !== "string" || typeof record.path !== "string")
      continue;
    out.push({
      at: Date.parse(String(record.timestamp)),
      method: record.method,
      path: record.path,
      ...(typeof record.route === "string" && { route: record.route }),
    });
  }
  return out;
}

/** An operation the published document declares. */
export interface Operation {
  name: string;
  method: string;
  matches: RegExp;
}

/** The operations of a document's `paths`, each with what its path matches. */
export function operationsOf(document: {
  paths: Record<string, Record<string, unknown>>;
}): Operation[] {
  const verbs = ["get", "put", "post", "delete", "patch"];
  return Object.entries(document.paths).flatMap(([path, item]) => {
    const pattern = path
      .split("/")
      .map((part) =>
        /^\{.+\}$/.test(part)
          ? "[^/]+"
          : part.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"),
      )
      .join("/");
    return verbs
      .filter((verb) => item[verb] !== undefined)
      .map((verb) => ({
        name: `${verb.toUpperCase()} ${path}`,
        method: verb.toUpperCase(),
        matches: new RegExp(`^${pattern}$`),
      }));
  });
}

/**
 * Where the harness reaches the target outside the published document. A
 * refusal here is often the test's point, as a test hook refused on the HTTP
 * listener is, so a door counts as lacking only if the run never reached it.
 */
const CONTROL_DOORS = "/_control/";

export interface FailedFile {
  file: string;
  failedTests: number;
  blockedTests: number;
  /** Operations it asked for and the target has no route for, by how often. */
  lacking: string[];
  /** The first thing its failure says. */
  firstMessage: string;
}

function lackingDoors(
  records: readonly RequestRecord[],
  served: ReadonlySet<string>,
  operations: readonly Operation[],
): string[] {
  const lacking = new Map<string, number>();
  for (const record of records) {
    if (record.route !== undefined) continue;
    const asked = `${record.method} ${record.path}`;
    const name = record.path.startsWith(CONTROL_DOORS)
      ? served.has(asked)
        ? undefined
        : asked
      : operations.find(
          (operation) =>
            operation.method === record.method &&
            operation.matches.test(record.path),
        )?.name;
    if (name !== undefined) lacking.set(name, (lacking.get(name) ?? 0) + 1);
  }
  return [...lacking]
    .sort((a, b) => b[1] - a[1])
    .map(([name, times]) => `${name} (${String(times)})`);
}

/**
 * Sorts the failed files. A file that reached an operation the target has no
 * route for is one a door would change; it may also fail for other reasons,
 * which nothing here can tell. A file that reached none failed inside what
 * the target serves.
 */
export function sortFailedFiles(
  run: Run,
  logs: readonly RequestLog[],
  windows: FileWindows,
  operations: readonly Operation[],
): FailedFile[] {
  const served = new Set(
    logs.flatMap((log) =>
      log.records
        .filter((record) => record.route !== undefined)
        .map((record) => `${record.method} ${record.path}`),
    ),
  );
  return run.files
    .filter((file) => file.failed)
    .map((file) => {
      const window = windows[file.path];
      if (window === undefined) {
        throw new Error(`the file windows do not name ${file.file}`);
      }
      const within = (at: number) => at >= window.start && at <= window.end;
      const records = logs.flatMap((log) =>
        log.at === undefined
          ? log.records.filter((record) => within(record.at))
          : within(log.at)
            ? log.records
            : [],
      );
      const outcomes = count(
        run.tests.filter((t) => t.file === file.file).map((t) => t.outcome),
      );
      return {
        file: file.file,
        failedTests: outcomes.failed,
        blockedTests: outcomes.blocked,
        lacking: lackingDoors(records, served, operations),
        firstMessage: (file.messages[0] ?? "").split("\n")[0] ?? "",
      };
    });
}

const row = (cells: (string | number)[]) =>
  `| ${cells.map(String).join(" | ")} |`;

function failedFileLines(
  title: string,
  files: readonly FailedFile[],
): string[] {
  const failed = files.reduce((sum, file) => sum + file.failedTests, 0);
  const blocked = files.reduce((sum, file) => sum + file.blockedTests, 0);
  return [
    "",
    `## ${title}: ${String(files.length)} files, ${String(failed)} failed tests, ${String(blocked)} blocked`,
    "",
    ...(files.length === 0
      ? ["None."]
      : files.map((file) => {
          const doors = file.lacking.slice(0, 5).join(", ");
          const why = doors === "" ? file.firstMessage : doors;
          return `- \`${file.file}\` (${String(file.failedTests)} failed, ${String(file.blockedTests)} blocked): ${why}`;
        })),
  ];
}

export function renderMarkdown(
  report: ChapterReport,
  failed: readonly FailedFile[] | undefined,
): string {
  const figures = (counts: Counts) => [
    counts.passed,
    counts.failed,
    counts.blocked,
    counts.skipped,
  ];
  const lines = [
    "# Passes by chapter",
    "",
    row([
      "Chapter",
      "Statements",
      "Uncited",
      "All cited tests passed",
      "Tests passed",
      "Failed",
      "Blocked",
      "Skipped",
      "Cited, not in run",
    ]),
    row([
      "---",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
    ]),
    ...report.chapters.map((c) =>
      row([
        c.chapter,
        c.statements,
        c.uncited,
        c.passed,
        ...figures(c.tests),
        c.citedNotInRun,
      ]),
    ),
    row([
      "Tests no statement cites",
      "",
      "",
      "",
      ...figures(report.uncitedTests),
      "",
    ]),
    row([
      "**Whole run**",
      report.totals.statements,
      report.totals.uncited,
      report.totals.passed,
      ...figures(report.totals.tests),
      report.totals.citedNotInRun,
    ]),
    "",
    "A chapter counts each cited test once, so a test two chapters cite counts in both. The whole run counts every test in the report once, and its passed and failed are Vitest's own totals.",
    "Blocked is a test Vitest skipped because its file failed around it, in a hook or at import; with Skipped it makes Vitest's skipped total. A statement counts as passed only when every test it cites ran and passed, so a citation of a test the report does not hold, such as one in the device or CLI suites, holds it back.",
  ];
  if (failed !== undefined) {
    lines.push(
      ...failedFileLines(
        "Failed files that reached an operation with no route",
        failed.filter((file) => file.lacking.length > 0),
      ),
      ...failedFileLines(
        "Failed files that reached only what the target serves",
        failed.filter((file) => file.lacking.length === 0),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
