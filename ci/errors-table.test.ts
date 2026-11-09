import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CHAPTER = new URL("../conformance/spec/errors.md", import.meta.url);
const DOCUMENT = new URL("../openapi.json", import.meta.url);

interface Row {
  code: string;
  status: string;
}

/**
 * The table of codes in the errors chapter is the contract's own list. The
 * Rust server's `app/refusal.rs` holds its codes and statuses to it in a
 * unit test; this holds `openapi.json` to it.
 */
function tableRows(): Row[] {
  const chapter = readFileSync(CHAPTER, "utf8");
  const start = chapter.indexOf("<!-- errors-table:start -->");
  const end = chapter.indexOf("<!-- errors-table:end -->");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [
    ...chapter
      .slice(start, end)
      .matchAll(/^\| `([a-z_]+)`\s*\|\s*([^|]+?)\s*\|/gm),
  ].map((row) => ({ code: row[1]!, status: row[2]! }));
}

/** Every code an error response in the document can carry. */
function documentCodes(): Set<string> {
  const codes = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const code = (
      (record.properties as Record<string, unknown> | undefined)?.error as
        { properties?: { code?: { enum?: unknown[] } } } | undefined
    )?.properties?.code;
    for (const value of code?.enum ?? []) {
      if (typeof value === "string") codes.add(value);
    }
    Object.values(record).forEach(walk);
  };
  walk(JSON.parse(readFileSync(DOCUMENT, "utf8")));
  return codes;
}

describe("the table of codes in the errors chapter", () => {
  it("lists each code once, by status and then by code", () => {
    const rows = tableRows();
    expect(rows.length).toBeGreaterThan(60);
    const codes = rows.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    const numbered = rows.filter((row) => /^\d{3}$/.test(row.status));
    const sorted = [...numbered].sort(
      (a, b) =>
        Number(a.status) - Number(b.status) || a.code.localeCompare(b.code),
    );
    expect(numbered.map((row) => row.code)).toEqual(
      sorted.map((row) => row.code),
    );
  });

  it("holds every code an error response in openapi.json names", () => {
    const tabled = new Set(tableRows().map((row) => row.code));
    const named = documentCodes();
    expect(named.size).toBeGreaterThan(60);
    expect([...named].filter((code) => !tabled.has(code))).toEqual([]);
  });
});
