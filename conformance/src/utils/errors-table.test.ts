import { describe, expect, it } from "vitest";
import {
  TABLE_END,
  TABLE_START,
  errorRows,
  inTableOrder,
  renderTable,
  withErrorsTable,
  type ErrorRow,
} from "./errors-table.js";

const GONE: ErrorRow = { code: "gone", status: 404, summary: "It is gone." };
const BAD: ErrorRow = { code: "bad", status: 400, summary: "It is bad." };
const ODD: ErrorRow = {
  code: "odd",
  status: 400,
  statusLabel: "Another's",
  summary: "A | B.",
};

describe("the table of codes", () => {
  it("lists rows by status, then by code", () => {
    expect(inTableOrder([GONE, ODD, BAD]).map((row) => row.code)).toEqual([
      "bad",
      "odd",
      "gone",
    ]);
  });

  it("opens each row with the code in backticks, which the server's census reads", () => {
    const rows = renderTable([GONE, BAD]).split("\n").slice(2);
    expect(rows.map((row) => /^\| `([a-z_]+)`\s*\|/.exec(row)?.[1])).toEqual([
      "bad",
      "gone",
    ]);
  });

  it("shows a code's own label in place of its status", () => {
    expect(renderTable([ODD])).toContain("| Another's");
  });

  it("pads every column to its widest cell, as Prettier does", () => {
    const lines = renderTable([GONE, ODD]).split("\n");
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[1]).toMatch(/^\| -+ \| -+ \| -+ \|$/);
  });

  it("escapes a pipe so it stays inside its cell", () => {
    expect(renderTable([ODD])).toContain("A \\| B.");
  });

  it("takes the rows of the server's code table", () => {
    expect(
      errorRows({ gone: { status: 404, summary: "It is gone." } }),
    ).toEqual([GONE]);
  });

  it("replaces what lies between the markers and nothing else", () => {
    const chapter = `before\n${TABLE_START}\n\nold\n\n${TABLE_END}\nafter\n`;
    const written = withErrorsTable(chapter, [GONE]);
    expect(written.startsWith(`before\n${TABLE_START}\n\n| Code`)).toBe(true);
    expect(written.endsWith(`\n\n${TABLE_END}\nafter\n`)).toBe(true);
    expect(written).not.toContain("old");
    expect(withErrorsTable(written, [GONE])).toBe(written);
  });

  it("refuses a chapter without its markers, in order", () => {
    expect(() => withErrorsTable("no markers", [GONE])).toThrow(TABLE_START);
    expect(() =>
      withErrorsTable(`${TABLE_END}\n${TABLE_START}`, [GONE]),
    ).toThrow(TABLE_START);
  });
});
