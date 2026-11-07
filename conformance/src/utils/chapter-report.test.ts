import { describe, expect, it } from "vitest";
import {
  chapterReport,
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
  testResults: [
    {
      name: "/checkout/conformance/src/suites/compliance/a.test.ts",
      status: "failed",
      startTime: 1_000,
      endTime: 2_000,
      assertionResults: [
        { ancestorTitles: ["the door"], title: "answers", status: "passed" },
        { ancestorTitles: [], title: "refuses", status: "failed" },
      ],
    },
    {
      name: "/checkout/conformance/src/suites/compliance/c.test.ts",
      status: "failed",
      message: "Error: could not boot a server into /tmp/x",
      startTime: 3_000,
      endTime: 4_000,
      assertionResults: [
        { ancestorTitles: [], title: "never ran", status: "skipped" },
      ],
    },
  ],
};

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
        tests: { passed: 1, failed: 1, notRun: 1 },
      },
    ]);
    expect(uncitedTests).toEqual({ passed: 0, failed: 1, notRun: 0 });
    expect(totals.citedNotInRun).toBe(1);
  });

  it("sorts a failed file by the unrouted requests in its window and by what its failure says", () => {
    const log = requestRecords(
      [
        JSON.stringify({ level: "info", message: "listening" }),
        JSON.stringify({
          timestamp: new Date(1_500).toISOString(),
          method: "GET",
          path: "/nowhere",
          status: 404,
        }),
        JSON.stringify({
          timestamp: new Date(1_600).toISOString(),
          method: "GET",
          path: "/items",
          route: "/items",
          status: 200,
        }),
      ].join("\n"),
    );
    expect(sortFailedFiles(run, [{ records: log }])).toEqual([
      {
        file: "compliance/a.test.ts",
        missingDoor: true,
        reasons: ["a request no route answered"],
        unrouted: ["GET /nowhere (1)"],
      },
      {
        file: "compliance/c.test.ts",
        missingDoor: true,
        reasons: ["its own server's boot failed"],
        unrouted: [],
      },
    ]);
    expect(
      sortFailedFiles(run, [{ records: log, at: 9_000 }])[0]?.missingDoor,
    ).toBe(false);
  });
});
