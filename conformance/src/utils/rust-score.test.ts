import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONTRACT_PROJECTS,
  contractFiles,
  excuse,
  fixturePath,
  renderScore,
  scoreRun,
  type ReportedTest,
  type VitestReport,
} from "./rust-score.js";

const A = "src/suites/compliance/a.test.ts";
const B = "src/suites/compliance/b.test.ts";
const C = "src/suites/sync/c.test.ts";
const LINUX = { platform: "linux" };

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
      LINUX,
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
    expect(score.failures).toEqual([`${B}: 2 of 3 tests passed`]);
  });

  it("does not count a skipped or todo test as passing", () => {
    const score = scoreRun(
      [
        {
          testResults: [result(A, "passed", ["passed", "skipped", "todo"])],
        },
      ],
      [A],
      LINUX,
    );
    expect([score.passed, score.total, score.filesPassing]).toEqual([1, 3, 0]);
  });

  describe("for a file the run owes", () => {
    const failures = (testResults: VitestReport["testResults"], owed = [A]) =>
      scoreRun([{ testResults }], owed, LINUX).failures;

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

    it("fails a file that did not load, with no test listed, and a file no shard reported", () => {
      const score = scoreRun(
        [
          {
            testResults: [
              result(A, "failed", []),
              result(B, "passed", ["passed", "passed"]),
            ],
          },
        ],
        [A, B, C],
        LINUX,
      );
      expect(score.failures).toEqual([
        `${A}: the file failed around its tests`,
        `${C}: no report names it`,
      ]);
      expect(renderScore(score)).toContain(`| ${C} | not reported | yes |`);
    });

    it("passes a complete set, and fails the missing file and the failed test of an incomplete one", () => {
      const complete = [
        result(A, "passed", ["passed", "passed"]),
        result(B, "passed", ["passed"]),
        result(C, "passed", ["passed"]),
      ];
      const owed = [A, B, C];
      expect(failures(complete, owed)).toEqual([]);
      expect(
        failures(
          complete.filter((file) => !file.name.endsWith(B)),
          owed,
        ),
      ).toEqual([`${B}: no report names it`]);
      expect(
        failures(
          [result(A, "failed", ["passed", "failed"]), ...complete.slice(1)],
          owed,
        ),
      ).toEqual([`${A}: 1 of 2 tests passed`]);
    });
  });

  it("counts a file no report names as not passing, and a reported file the run does not owe cannot fail it", () => {
    const missing = scoreRun([{ testResults: [] }], [A, B], LINUX);
    expect([missing.passed, missing.filesPassing]).toEqual([0, 0]);
    expect(renderScore(missing)).toContain(`| ${A} | not reported | yes |`);
    const unowed = scoreRun(
      [{ testResults: [result(B, "failed", ["failed"])] }],
      [A],
      LINUX,
    );
    expect(unowed.failures).toEqual([`${A}: no report names it`]);
    expect(renderScore(unowed)).toContain(`| ${B} | 0 of 1 | no |`);
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
      LINUX,
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
        LINUX,
      ),
    ).toThrow(`two reports name ${A}`);
  });

  it("reads a fixture's path from the absolute path Vitest reports", () => {
    expect(fixturePath(`/home/runner/work/marfa/marfa/conformance/${A}`)).toBe(
      A,
    );
  });
});

describe("a test skipped for the machine alone", () => {
  const macOnly: ReportedTest = {
    status: "skipped",
    fullName: "a chapter a Mac test",
    meta: { onlyOn: "darwin" },
  };
  const clamped: ReportedTest = {
    status: "skipped",
    fullName: "a clamped test",
    meta: { unobservable: "this machine clamps every process" },
  };
  const file = (...tests: ReportedTest[]) => ({
    name: `/checkout/conformance/${A}`,
    status: "passed",
    assertionResults: [{ status: "passed" }, ...tests],
  });
  const score = (platform: string, ...tests: ReportedTest[]) =>
    scoreRun([{ testResults: [file(...tests)] }], [A], { platform });

  it("is left out of the count on another platform and listed, so its file passes whole", () => {
    const linux = score("linux", macOnly);
    expect(linux.failures).toEqual([]);
    expect(linux.files[0]).toMatchObject({ passed: 1, total: 1 });
    expect(renderScore(linux)).toContain(
      `${A} › a chapter a Mac test: runs only on darwin`,
    );
  });

  it("does not pass on the platform it runs on", () => {
    expect(score("darwin", macOnly).failures).toEqual([
      `${A}: 1 of 2 tests passed`,
    ]);
  });

  it("is left out of the count when it says this machine cannot show what it asserts", () => {
    const mac = score("darwin", clamped);
    expect(mac.failures).toEqual([]);
    expect(renderScore(mac)).toContain(
      "a clamped test: this machine clamps every process",
    );
  });

  it.each([
    ["a skip with no reason", { status: "skipped" }],
    ["a skip with empty metadata", { status: "skipped", meta: {} }],
    [
      "a skip naming no machine",
      { status: "skipped", meta: { unobservable: "" } },
    ],
    [
      "a todo on another platform",
      { status: "todo", meta: { onlyOn: "darwin" } },
    ],
    [
      "a failure on another platform",
      { status: "failed", meta: { onlyOn: "darwin" } },
    ],
  ] as [string, ReportedTest][])("still fails the file for %s", (_, test) => {
    expect(score("linux", test).failures).toEqual([
      `${A}: 1 of 2 tests passed`,
    ]);
  });

  it("passes a file every test of which runs only on another platform", () => {
    const only = scoreRun(
      [
        {
          testResults: [
            {
              name: `/checkout/conformance/${A}`,
              status: "passed",
              assertionResults: [macOnly],
            },
          ],
        },
      ],
      [A],
      LINUX,
    );
    expect(only.failures).toEqual([]);
    expect(only.filesPassing).toBe(1);
  });

  it("names the excuse a test reports, and none for a test that ran", () => {
    expect(excuse(macOnly, "linux")).toBe("runs only on darwin");
    expect(excuse(macOnly, "darwin")).toBeUndefined();
    expect(excuse({ ...macOnly, status: "passed" }, "linux")).toBeUndefined();
  });
});

describe("the excuses the contract makes", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  const text = (file: string) => readFileSync(join(ROOT, file), "utf8");

  it("says a machine cannot show a test in one fixture alone, the clamped priority", () => {
    const naming = contractFiles(ROOT).filter((file) =>
      text(file).includes(".meta.unobservable"),
    );
    expect(naming).toEqual(["src/suites/device/folders-autostart.test.ts"]);
    expect(text(naming[0] ?? "").split(".meta.unobservable").length - 1).toBe(
      1,
    );
  });

  it("skips a test for the platform only through ON_MACOS", () => {
    const raw = /runIf\(process\.platform|skip:\s*process\.platform/;
    const files = contractFiles(ROOT);
    // The witness: the files read are the fixtures, and one uses ON_MACOS.
    expect(files.some((file) => text(file).includes("ON_MACOS"))).toBe(true);
    expect(files.filter((file) => raw.test(text(file)))).toEqual([]);
  });
});

describe("the files of the contract", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
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

  it("are, in the checkout, the fixtures of every server project", () => {
    const files = contractFiles(ROOT);
    for (const project of CONTRACT_PROJECTS) {
      expect(
        files.some((file) => file.startsWith(`src/suites/${project}/`)),
        project,
      ).toBe(true);
    }
    expect(files.filter((file) => /\.decision\.test\.ts$/.test(file))).toEqual(
      [],
    );
  });

  it("are the test files of the five server projects, without a decision test, a helper or another project", () => {
    expect(contractFiles(directory)).toEqual([
      A,
      "src/suites/device/nested/d.test.ts",
    ]);
  });
});
