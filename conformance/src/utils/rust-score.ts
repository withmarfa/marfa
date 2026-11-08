import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The projects whose files are the contract the Rust server is held to. */
export const CONTRACT_PROJECTS = [
  "correctness",
  "compliance",
  "sync",
  "device",
  "cli",
] as const;

/** The part of Vitest's JSON report the score reads. */
export interface VitestReport {
  testResults: {
    name: string;
    status: string;
    assertionResults: { status: string }[];
  }[];
}

export interface FileScore {
  /** By path from `conformance/`, as `RUST_JUDGED` lists it. */
  file: string;
  project: string;
  /** Tests that passed. A skipped, todo or failed test is not one. */
  passed: number;
  /** The larger of the tests collected from the file and those reported. */
  total: number;
  /** Whether a report names the file. */
  reported: boolean;
  /** Whether the file failed to load or a hook failed around its tests. */
  broken: boolean;
  judged: boolean;
}

export interface ProjectScore {
  project: string;
  files: number;
  filesPassing: number;
  passed: number;
  total: number;
}

export interface Score {
  files: FileScore[];
  projects: ProjectScore[];
  passed: number;
  total: number;
  filesPassing: number;
  /** The Rust-judged files that did not pass whole, with the reason. */
  failures: string[];
}

/** A fixture's path from `conformance/`, from the absolute path Vitest reports. */
export function fixturePath(name: string): string {
  const at = name.lastIndexOf("/src/suites/");
  return at < 0 ? name : name.slice(at + 1);
}

/** Every contract test file under `root`, by path from `root`. */
export function contractFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (
        entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".decision.test.ts")
      ) {
        found.push(path);
      }
    }
  };
  for (const project of CONTRACT_PROJECTS) walk(`src/suites/${project}`);
  return found.sort();
}

/** Test counts by file, from the JSON of `vitest list --json`. */
export function countCollected(
  tests: readonly { file: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const test of tests) {
    const file = fixturePath(test.file);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/** The contract test files a Vitest error names. */
export function filesNamedIn(output: string): string[] {
  const found = output.match(/src\/suites\/[\w./-]+\.test\.ts/g) ?? [];
  return [...new Set(found)].sort();
}

/**
 * The summary lines about how tests were counted. `unrun` are the files whose
 * count came from reading them without running them, because Vitest could not
 * list the contract's tests while they failed to load.
 */
export function collectionNotes(
  counts: ReadonlyMap<string, number>,
  unrun: readonly string[],
): string[] {
  if (unrun.length === 0 && counts.size > 0) {
    return [
      "Every file was run to list its tests. A file's total is the larger of that count and its report's.",
    ];
  }
  return [
    "Vitest could not list the contract's tests, so only the files it named were counted, by reading them without running them (a test written once for several inputs counts as one). Every other file keeps the count its report lists.",
    ...(unrun.length === 0
      ? ["Vitest named no file, so no file was counted."]
      : unrun.map(
          (file) =>
            `${file}: ${String(counts.get(file) ?? 0)} tests counted, or the reported count if larger.`,
        )),
  ];
}

const projectOf = (file: string): string => file.split("/")[2] ?? "";

const whole = (file: FileScore): boolean =>
  file.reported && !file.broken && file.total > 0 && file.passed === file.total;

/**
 * The score of a run of the contract: tests passing out of all the contract's
 * tests, by test file. A test Vitest skipped, left todo or failed does not
 * pass. A file's total is the larger of the tests `collected` from it and
 * those a report lists, so a file that did not load, or that no report names,
 * counts every test it holds as not passing. A report of a file outside the
 * five projects is ignored. A Rust-judged file fails the score unless
 * a report names it and every test in it passed.
 */
export function scoreRun(
  reports: readonly VitestReport[],
  files: readonly string[],
  judged: readonly string[],
  collected: ReadonlyMap<string, number> = new Map(),
): Score {
  const byFile = new Map<string, FileScore>();
  const judgedSet = new Set(judged);
  const blank = (file: string): FileScore => ({
    file,
    project: projectOf(file),
    passed: 0,
    total: 0,
    reported: false,
    broken: false,
    judged: judgedSet.has(file),
  });
  for (const file of [...files, ...judged]) {
    if (!byFile.has(file)) byFile.set(file, blank(file));
  }
  for (const report of reports) {
    for (const result of report.testResults) {
      const file = fixturePath(result.name);
      if (!CONTRACT_PROJECTS.some((p) => file.startsWith(`src/suites/${p}/`))) {
        continue;
      }
      const score = byFile.get(file) ?? blank(file);
      if (score.reported) {
        throw new Error(`two reports name ${file}`);
      }
      score.reported = true;
      const listed = result.assertionResults.length;
      score.total = listed;
      score.passed = result.assertionResults.filter(
        (test) => test.status === "passed",
      ).length;
      score.broken = result.status === "failed" && score.passed === listed;
      byFile.set(file, score);
    }
  }
  for (const score of byFile.values()) {
    score.total = Math.max(score.total, collected.get(score.file) ?? 0);
  }
  const scores = [...byFile.values()].sort(
    (a, b) =>
      CONTRACT_PROJECTS.indexOf(a.project as never) -
        CONTRACT_PROJECTS.indexOf(b.project as never) ||
      (a.file < b.file ? -1 : 1),
  );
  const projects = CONTRACT_PROJECTS.map((project): ProjectScore => {
    const own = scores.filter((score) => score.project === project);
    return {
      project,
      files: own.length,
      filesPassing: own.filter(whole).length,
      passed: own.reduce((sum, score) => sum + score.passed, 0),
      total: own.reduce((sum, score) => sum + score.total, 0),
    };
  });
  const failures = scores
    .filter((score) => score.judged && !whole(score))
    .map((score) =>
      !score.reported
        ? `${score.file}: no report names it`
        : score.broken
          ? `${score.file}: the file failed around its tests`
          : score.total === 0
            ? `${score.file}: it lists no tests`
            : `${score.file}: ${String(score.passed)} of ${String(score.total)} tests passed`,
    );
  return {
    files: scores,
    projects,
    passed: scores.reduce((sum, score) => sum + score.passed, 0),
    total: scores.reduce((sum, score) => sum + score.total, 0),
    filesPassing: scores.filter(whole).length,
    failures,
  };
}

const share = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${((100 * part) / whole).toFixed(1)}%`;

/** The score as Markdown for the job summary. */
export function renderScore(
  score: Score,
  notes: readonly string[] = [],
): string {
  const lines = [
    "## Rust contract score",
    "",
    `**${String(score.passed)} of ${String(score.total)} tests pass (${share(score.passed, score.total)}).** ${String(score.filesPassing)} of ${String(score.files.length)} test files pass whole.`,
    "",
  ];
  if (score.failures.length === 0) {
    lines.push("Every Rust-judged file passes.", "");
  } else {
    lines.push(
      "Rust-judged files that do not pass:",
      "",
      ...score.failures.map((failure) => `- ${failure}`),
      "",
    );
  }
  if (notes.length > 0) {
    lines.push(...notes.map((note) => `- ${note}`), "");
  }
  lines.push(
    "| Project | Files passing | Tests passing |",
    "|---|---|---|",
    ...score.projects.map(
      (p) =>
        `| ${p.project} | ${String(p.filesPassing)} of ${String(p.files)} | ${String(p.passed)} of ${String(p.total)} |`,
    ),
    "",
    "| File | Passing | Judged by |",
    "|---|---|---|",
    ...score.files.map(
      (f) =>
        `| ${f.file} | ${f.reported ? `${String(f.passed)} of ${String(f.total)}${f.broken ? " (file failed)" : ""}` : `not reported${f.total > 0 ? `, ${String(f.total)} tests` : ""}`} | ${f.judged ? "Rust" : "TypeScript"} |`,
    ),
    "",
  );
  return lines.join("\n");
}
