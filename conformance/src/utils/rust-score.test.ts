import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  contractFiles,
  fixturePath,
  renderScore,
  scoreRun,
  type VitestReport,
} from "./rust-score.js";

const A = "src/suites/compliance/a.test.ts";
const B = "src/suites/compliance/b.test.ts";
const C = "src/suites/sync/c.test.ts";

const result = (
  file: string,
  status: string,
  tests: string[],
): VitestReport["testResults"][number] => ({
  name: `/checkout/conformance/${file}`,
  status,
  assertionResults: tests.map((test) => ({ status: test })),
});

describe("the score of a run", () => {
  it("counts the tests that passed out of all of them, by file and by project", () => {
    const score = scoreRun(
      [
        {
          testResults: [
            result(A, "passed", ["passed", "passed"]),
            result(B, "failed", ["passed", "failed", "passed"]),
          ],
        },
        { testResults: [result(C, "passed", ["passed"])] },
      ],
      [A, B, C],
      [],
    );
    expect([score.passed, score.total, score.filesPassing]).toEqual([5, 6, 2]);
    expect(
      score.projects
        .filter((p) => p.files > 0)
        .map((p) => [p.project, p.filesPassing, p.files, p.passed, p.total]),
    ).toEqual([
      ["compliance", 1, 2, 4, 5],
      ["sync", 1, 1, 1, 1],
    ]);
    expect(score.failures).toEqual([]);
  });

  it("does not count a skipped or todo test as passing", () => {
    const score = scoreRun(
      [
        {
          testResults: [result(A, "passed", ["passed", "skipped", "todo"])],
        },
      ],
      [A],
      [],
    );
    expect([score.passed, score.total, score.filesPassing]).toEqual([1, 3, 0]);
  });

  describe("for a file the Rust server judges", () => {
    const failures = (testResults: VitestReport["testResults"], judged = [A]) =>
      scoreRun([{ testResults }], [A, B], judged).failures;

    it("passes when every test in it passed", () => {
      expect(
        failures([
          result(A, "passed", ["passed", "passed"]),
          result(B, "failed", ["failed"]),
        ]),
      ).toEqual([]);
    });

    it.each([
      ["a test failed", result(A, "failed", ["passed", "failed"])],
      ["a test was skipped", result(A, "passed", ["passed", "skipped"])],
      ["a test is todo", result(A, "passed", ["passed", "todo"])],
      ["the file lists no test", result(A, "passed", [])],
      ["a hook failed after the tests passed", result(A, "failed", ["passed"])],
    ])("fails when %s", (_, fileResult) => {
      expect(failures([fileResult])).toHaveLength(1);
    });

    it("fails when no report names it, as when a shard wrote none", () => {
      expect(failures([result(B, "passed", ["passed"])])).toEqual([
        `${A}: no report names it`,
      ]);
    });
  });

  it("counts a file no report names as not passing, and leaves a file the Rust server does not judge unable to fail the run", () => {
    const score = scoreRun([{ testResults: [] }], [A, B], []);
    expect([score.passed, score.filesPassing, score.failures]).toEqual([
      0,
      0,
      [],
    ]);
    expect(renderScore(score)).toContain(
      `| ${A} | not reported | TypeScript |`,
    );
  });

  it("ignores a report of a file outside the five server projects", () => {
    const score = scoreRun(
      [
        {
          testResults: [
            result("src/suites/load/x.test.ts", "passed", ["passed"]),
            result("src/utils/y.test.ts", "passed", ["passed"]),
            result(A, "passed", ["passed"]),
          ],
        },
      ],
      [A],
      [],
    );
    expect([score.passed, score.total, score.files.length]).toEqual([1, 1, 1]);
  });

  it("refuses two reports that name one file", () => {
    expect(() =>
      scoreRun(
        [
          { testResults: [result(A, "passed", ["passed"])] },
          { testResults: [result(A, "passed", ["passed"])] },
        ],
        [A],
        [],
      ),
    ).toThrow(`two reports name ${A}`);
  });

  it("reads a fixture's path from the absolute path Vitest reports", () => {
    expect(fixturePath(`/home/runner/work/marfa/marfa/conformance/${A}`)).toBe(
      A,
    );
  });
});

describe("the files of the contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "marfa-rust-score-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    A,
    "src/suites/device/nested/d.test.ts",
    "src/suites/device/corpus.decision.test.ts",
    "src/suites/device/harness.ts",
    "src/suites/load/e.test.ts",
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), "export {};\n");
  }
  for (const project of ["correctness", "sync", "cli"]) {
    mkdirSync(join(directory, "src/suites", project), { recursive: true });
  }

  it("are the test files of the five server projects, without a decision test, a helper or another project", () => {
    expect(contractFiles(directory)).toEqual([
      A,
      "src/suites/device/nested/d.test.ts",
    ]);
  });
});
