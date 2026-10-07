import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../packages/shared/src/errors.js";
import {
  errorRows,
  withErrorsTable,
} from "../conformance/src/utils/errors-table.js";

const CHAPTER = new URL("../conformance/spec/errors.md", import.meta.url);

/**
 * The errors chapter's table of codes is written from the server's code
 * table by `conformance/scripts/errors-table.ts`. A code added, removed,
 * re-statused or re-described in `packages/shared/src/errors.ts` changes the
 * table, so one that was not rewritten is stale in the contract. Compared as
 * text, because the table is text a reader sees.
 */
describe("the table of codes in the errors chapter", () => {
  it("is what the server's code table produces", () => {
    const committed = readFileSync(CHAPTER, "utf8");
    expect(
      committed,
      "Run `pnpm --filter @withmarfa/conformance exec tsx scripts/errors-table.ts` and commit the result.",
    ).toBe(withErrorsTable(committed, errorRows(ERROR_CODES)));
  });

  it("holds every code the server can answer, so the comparison above cannot pass on an empty table", () => {
    const committed = readFileSync(CHAPTER, "utf8");
    const codes = Object.keys(ERROR_CODES);
    expect(codes.length).toBeGreaterThan(60);
    for (const code of codes) {
      expect(committed, code).toContain(`| \`${code}\` `);
    }
  });
});
