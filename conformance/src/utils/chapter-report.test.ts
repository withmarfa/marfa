import { describe, expect, it } from "vitest";
import {
  chapterReport,
  operationsOf,
  readRun,
  requestRecords,
  sortFailedFiles,
  type VitestJson,
} from "./chapter-report.js";
import { indexOf } from "./spec-references.js";

const chapter = [
  "### \`sample/all-passed\`",
  "",
  "The server MUST answer.",
  "",
  "**Tests:** \`compliance/a.test.ts › the door\`.",
  "",
  "### \`sample/one-failed\`",
  "",
  "The server MUST answer again.",
  "",
  "**Tests:** \`compliance/a.test.ts\`.",
  "",
  "### \`sample/not-run\`",
  "",
  "The server MUST answer a third time.",
  "",
  "**Tests:** \`device/b.test.ts › a device test\`.",
  "",
  "### \`sample/uncited\`",
  "",
  "The server MUST answer a fourth time.",
  "",
  "**Tests:** waiting on #1.",
  "",
].join("\n");

const report: VitestJson = {
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 1,
  numTodoTests: 0,
  testResults: [
    {
      name: "/checkout/conformance/src/suites/compliance/a.test.ts",
      status: "failed",
      assertionResults: [
        { ancestorTitles: ["the door"], title: "answers", status: "passed" },
        { ancestorTitles: [], title: "refuses", status: "failed" },
      ],
    },
    {
      name: "/checkout/conformance/src/suites/compliance/c.test.ts",
      status: "failed",
      message: "Error: could not boot a server into /tmp/x",
      assertionResults: [
        { ancestorTitles: [], title: "never ran", status: "skipped" },
      ],
    },
  ],
};

const A = "/checkout/conformance/src/suites/compliance/a.test.ts";
const C = "/checkout/conformance/src/suites/compliance/c.test.ts";
const windows = {
  [A]: { start: 1_000, end: 2_000 },
  [C]: { start: 3_000, end: 4_000 },
};
const operations = operationsOf({
  paths: {
    "/items": { get: {}, post: {} },
    "/items/{id}": { get: {}, parameters: [] },
  },
});

function log(lines: object[]) {
  return requestRecords(lines.map((line) => JSON.stringify(line)).join("\n"));
}

describe("the chapter report", () => {
  const run = readRun(report);

  it("counts a statement passed only when every test it cites ran and passed", () => {
    const { chapters, uncitedTests, totals } = chapterReport(
      indexOf({ "sample.md": chapter }),
      run,
    );
    expect(chapters).toEqual([
      {
        chapter: "sample",
        statements: 4,
        uncited: 1,
        passed: 1,
        tests: { passed: 1, failed: 1, blocked: 0, skipped: 0 },
        citedNotInRun: 1,
      },
    ]);
    expect(uncitedTests).toEqual({
      passed: 0,
      failed: 0,
      blocked: 1,
      skipped: 0,
    });
    expect(totals.citedNotInRun).toBe(1);
  });

  it("gives the whole run Vitest's own totals, a test blocked by its file's hook included", () => {
    const { totals } = chapterReport(indexOf({ "sample.md": chapter }), run);
    expect(totals.tests).toEqual({
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      blocked: report.numPendingTests,
      skipped: 0,
    });
  });

  it("refuses a run whose figures disagree with Vitest's", () => {
    expect(() => readRun({ ...report, numFailedTests: 2 })).toThrow(
      /Vitest counted/,
    );
  });

  it("sorts a file by the declared operations it reached with no route, hooks included", () => {
    const records = log([
      { level: "info", message: "listening" },
      // Before the first test of a file: a `beforeAll`.
      {
        timestamp: new Date(3_100).toISOString(),
        method: "POST",
        path: "/items",
        status: 404,
      },
      // A path nothing declares is the fixture's own probe, not a lacking door.
      {
        timestamp: new Date(1_500).toISOString(),
        method: "GET",
        path: "/nowhere",
        status: 404,
      },
      {
        timestamp: new Date(1_600).toISOString(),
        method: "GET",
        path: "/items/abc",
        route: "/items/{id}",
        status: 200,
      },
    ]);
    expect(sortFailedFiles(run, [{ records }], windows, operations)).toEqual([
      {
        file: "compliance/a.test.ts",
        failedTests: 1,
        blockedTests: 0,
        lacking: [],
        firstMessage: "",
      },
      {
        file: "compliance/c.test.ts",
        failedTests: 0,
        blockedTests: 1,
        lacking: ["POST /items (1)"],
        firstMessage: "Error: could not boot a server into /tmp/x",
      },
    ]);
  });

  it("counts a control door as lacking only if no request in the run reached it", () => {
    const at = new Date(1_500).toISOString();
    const records = log([
      { timestamp: at, method: "GET", path: "/_control/test/clock" },
      { timestamp: at, method: "GET", path: "/_control/missing" },
      {
        timestamp: new Date(9_000).toISOString(),
        method: "GET",
        path: "/_control/test/clock",
        route: "/_control/test/clock",
      },
    ]);
    const [a] = sortFailedFiles(run, [{ records }], windows, operations);
    expect(a?.lacking).toEqual(["GET /_control/missing (1)"]);
  });

  it("places a fixture's own server by when its log was kept, whatever its clock said", () => {
    const records = log([
      {
        timestamp: new Date(9_000_000).toISOString(),
        method: "GET",
        path: "/items",
        status: 404,
      },
    ]);
    const sorted = sortFailedFiles(
      run,
      [{ records, at: 1_900 }],
      windows,
      operations,
    );
    expect(sorted.map((file) => file.lacking)).toEqual([
      ["GET /items (1)"],
      [],
    ]);
  });
});
