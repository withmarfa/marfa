import type { SpecIndex } from "./spec-references.js";
import { citationsIn, statementText } from "./spec-statements.js";

/**
 * Passes by contract chapter, from a Vitest JSON report: the statements in a
 * chapter whose cited tests all passed, and the cited tests by outcome. A
 * failed test file is sorted, from the target's request logs, into one that
 * reached a door the target does not have and one that failed inside what it
 * has.
 */

export type Outcome = "passed" | "failed" | "not run";

/** The part of Vitest's JSON report this reads. */
export interface VitestJson {
  testResults: {
    name: string;
    status: string;
    message?: string;
    startTime: number;
    endTime: number;
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
  file: string;
  failed: boolean;
  startTime: number;
  endTime: number;
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

/**
 * A test that did not run because its file failed around it, in a hook or
 * at import, counts as failed: it is red, not left out. A test skipped in a
 * file that otherwise ran is not run.
 */
export function readRun(report: VitestJson): Run {
  const files: RunFile[] = [];
  const tests: RunTest[] = [];
  for (const result of report.testResults) {
    const file = suitePath(result.name);
    const ran = result.assertionResults.some(
      (a) => a.status === "passed" || a.status === "failed",
    );
    const fileFailed = result.status === "failed";
    const messages = [
      ...(result.message ? [result.message] : []),
      ...result.assertionResults.flatMap((a) => a.failureMessages ?? []),
    ];
    files.push({
      file,
      failed: fileFailed,
      startTime: result.startTime,
      endTime: result.endTime,
      messages,
    });
    for (const a of result.assertionResults) {
      const outcome: Outcome =
        a.status === "passed"
          ? "passed"
          : a.status === "failed" || (fileFailed && !ran)
            ? "failed"
            : "not run";
      tests.push({ file, titles: [...a.ancestorTitles, a.title], outcome });
    }
  }
  return { files, tests };
}

export interface Counts {
  passed: number;
  failed: number;
  notRun: number;
}

export interface ChapterRow {
  chapter: string;
  statements: number;
  /** Statements whose Tests paragraph cites no fixture. */
  uncited: number;
  /** Statements with at least one citation, every cited test of which passed. */
  passed: number;
  tests: Counts;
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
  const counts: Counts = { passed: 0, failed: 0, notRun: 0 };
  for (const outcome of outcomes) {
    if (outcome === "passed") counts.passed += 1;
    else if (outcome === "failed") counts.failed += 1;
    else counts.notRun += 1;
  }
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
          chapterTests.set(key, "not run");
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
 * the file running when its log was kept (`at`), because its clock may have
 * been moved and its timestamps with it.
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

/** What a fixture's failure says when it could not reach what it needed. */
const MISSING_DOOR_MESSAGES: [RegExp, string][] = [
  [/could not boot a server into/, "its own server's boot failed"],
  [
    /Failed to create per-test key|working key's mint answered/,
    "a key mint failed",
  ],
  [
    /no owner sign-in|MARFA_OWNER_COOKIE is required|owner could not sign in/,
    "needs the owner's sign-in",
  ],
  [
    /refused the fault|did not (?:move|pause or resume) its clock|did not list its faults/,
    "needs the test hooks",
  ],
];

export interface FailedFile {
  file: string;
  missingDoor: boolean;
  /** Why it was sorted as reaching a missing door. */
  reasons: string[];
  /** Up to five `METHOD path` no route answered, with how many times. */
  unrouted: string[];
}

export function sortFailedFiles(
  run: Run,
  logs: readonly RequestLog[],
): FailedFile[] {
  const failed: FailedFile[] = [];
  for (const file of run.files) {
    if (!file.failed) continue;
    const within = (at: number) => at >= file.startTime && at <= file.endTime;
    const records = logs.flatMap((log) =>
      log.at === undefined
        ? log.records.filter((r) => within(r.at))
        : within(log.at)
          ? log.records
          : [],
    );
    const unrouted = new Map<string, number>();
    for (const record of records) {
      if (record.route !== undefined) continue;
      const key = `${record.method} ${record.path}`;
      unrouted.set(key, (unrouted.get(key) ?? 0) + 1);
    }
    const text = file.messages.join("\n");
    const reasons = MISSING_DOOR_MESSAGES.filter(([pattern]) =>
      pattern.test(text),
    ).map(([, reason]) => reason);
    if (unrouted.size > 0) reasons.push("a request no route answered");
    failed.push({
      file: file.file,
      missingDoor: reasons.length > 0,
      reasons,
      unrouted: [...unrouted]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, n]) => `${key} (${String(n)})`),
    });
  }
  return failed;
}

const row = (cells: (string | number)[]) =>
  `| ${cells.map(String).join(" | ")} |`;

export function renderMarkdown(
  report: ChapterReport,
  failed: readonly FailedFile[] | undefined,
): string {
  const header = [
    row([
      "Chapter",
      "Statements",
      "Uncited",
      "All cited tests passed",
      "Tests passed",
      "Failed",
      "Not run",
    ]),
    row(["---", "---:", "---:", "---:", "---:", "---:", "---:"]),
  ];
  const lines = [
    "# Passes by chapter",
    "",
    ...header,
    ...report.chapters.map((c) =>
      row([
        c.chapter,
        c.statements,
        c.uncited,
        c.passed,
        c.tests.passed,
        c.tests.failed,
        c.tests.notRun,
      ]),
    ),
    row([
      "Tests no statement cites",
      "",
      "",
      "",
      report.uncitedTests.passed,
      report.uncitedTests.failed,
      report.uncitedTests.notRun,
    ]),
    row([
      "**Whole run**",
      report.totals.statements,
      report.totals.uncited,
      report.totals.passed,
      report.totals.tests.passed,
      report.totals.tests.failed,
      report.totals.tests.notRun + report.totals.citedNotInRun,
    ]),
    "",
    "A chapter counts each cited test once, so a test two chapters cite counts in both. The whole run counts every test in the report once.",
    `Not run counts a test the report holds as skipped, and a citation of a test or file the report does not hold, such as one in the device or CLI suites (${String(report.totals.citedNotInRun)} in the whole run). A statement with such a citation does not count as passed.`,
  ];
  if (failed !== undefined) {
    const list = (missing: boolean) =>
      failed
        .filter((f) => f.missingDoor === missing)
        .map(
          (f) =>
            `- \`${f.file}\`${f.reasons.length > 0 ? `: ${f.reasons.join("; ")}` : ""}${f.unrouted.length > 0 ? `. Unrouted: ${f.unrouted.join(", ")}` : ""}`,
        );
    const missingDoor = list(true);
    const inside = list(false);
    lines.push(
      "",
      `## Failed files that reach a door the target does not have (${String(missingDoor.length)})`,
      "",
      ...(missingDoor.length > 0 ? missingDoor : ["None."]),
      "",
      `## Failed files that fail inside what the target has (${String(inside.length)})`,
      "",
      ...(inside.length > 0 ? inside : ["None."]),
    );
  }
  return `${lines.join("\n")}\n`;
}
