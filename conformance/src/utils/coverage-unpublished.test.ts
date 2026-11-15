/**
 * Every route the server serves outside its private control socket and does
 * not publish has a row in the "Served but unpublished" table of
 * `spec/coverage.md`. The server's own list of those routes, `UNPUBLISHED`
 * in `document.rs`, is read from its source, so a route added to the server
 * and not to the table fails here.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coverageRows } from "./coverage-table.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const suites = resolve(root, "src/suites");
const CONTROL_PREFIX = "/_control/";

/** The route of each entry of `UNPUBLISHED`, as the server lists it. */
function unpublishedRoutes(): string[] {
  const source = readFileSync(
    resolve(root, "../core/marfa-server/src/http/document.rs"),
    "utf8",
  );
  const start = source.indexOf("const UNPUBLISHED");
  const end = source.indexOf("\n];", start);
  expect(start, "document.rs holds UNPUBLISHED").toBeGreaterThanOrEqual(0);
  expect(end, "UNPUBLISHED ends").toBeGreaterThan(start);
  return [
    ...source
      .slice(start, end)
      .matchAll(/\(\s*"([A-Z]+ [^"]+)",\s*"[^"]*"\s*,?\s*\)/g),
  ].map((entry) => entry[1] as string);
}

const served = unpublishedRoutes().filter(
  (route) => !route.split(" ")[1]?.startsWith(CONTROL_PREFIX),
);

describe("the routes the server serves and does not publish", () => {
  const rows = coverageRows().filter((row) => row.status === "unpublished");
  const rowed = new Set(rows.map((row) => `${row.method} ${row.path}`));

  it("are read from the server's list, which holds the routes the chapter names", () => {
    // The witness: the list read is the whole list, a private route and a public one among them.
    expect(unpublishedRoutes().length).toBeGreaterThan(served.length);
    expect(served).toContain("POST /mcp");
    expect(served).toContain("GET /auth/sign-in");
    expect(served.every((route) => !route.includes(CONTROL_PREFIX))).toBe(true);
  });

  it("each have a row in the coverage chapter", () => {
    expect(served.filter((route) => !rowed.has(route))).toEqual([]);
  });

  it("are all that the chapter's unpublished rows name", () => {
    const listed = new Set(served);
    expect([...rowed].filter((route) => !listed.has(route))).toEqual([]);
  });

  it("each cite fixtures that exist", () => {
    for (const row of rows) {
      expect(row.fixtures, `${row.method} ${row.path}`).not.toEqual([]);
      for (const fixture of row.fixtures) {
        expect(
          existsSync(resolve(suites, fixture)),
          `${row.method} ${row.path}: ${fixture}`,
        ).toBe(true);
      }
    }
  });

  it("have no row that repeats another", () => {
    expect(rows.length).toBe(rowed.size);
  });
});
