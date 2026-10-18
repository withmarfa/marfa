import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOUSEKEEPING_JOBS } from "../packages/server/src/housekeeping/metadata.js";
import {
  TABLE_START,
  TABLE_END,
  withHousekeepingTable,
} from "../conformance/src/utils/housekeeping-table.js";

describe("the generated housekeeping table", () => {
  it("matches the server metadata", () => {
    const chapter = readFileSync(
      new URL("../conformance/spec/housekeeping.md", import.meta.url),
      "utf8",
    );
    expect(
      chapter,
      "Run pnpm --filter @withmarfa/conformance exec tsx scripts/housekeeping-table.ts",
    ).toBe(withHousekeepingTable(chapter, Object.values(HOUSEKEEPING_JOBS)));
    for (const job of Object.values(HOUSEKEEPING_JOBS))
      expect(chapter).toContain(`| \`${job.name}\` `);
  });
  it.each([
    "",
    TABLE_START,
    TABLE_END,
    `${TABLE_END}${TABLE_START}`,
    `${TABLE_START}${TABLE_START}${TABLE_END}`,
    `${TABLE_START}${TABLE_END}${TABLE_END}`,
  ])("refuses missing, reversed or duplicate markers: %s", (chapter) => {
    expect(() =>
      withHousekeepingTable(chapter, Object.values(HOUSEKEEPING_JOBS)),
    ).toThrow();
  });
});
