/**
 * Every covered operation's happy-path body is validated against the served
 * document somewhere in the suite. A fixture can assert a status and a few
 * fields and still pass a body the document does not describe; the call to
 * `expectMatchesSchema` is what makes the document a party to the run, and
 * nothing else keeps a new fixture from leaving it out.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageRows } from "./coverage-table.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return testFiles(full);
    return entry.endsWith(".test.ts") ? [full] : [];
  });
}

/** Operations whose 2xx body is not JSON, listed with the reason in the table. */
function outsideTheSchemas(): Set<string> {
  const table = readFileSync(join(repoRoot, "spec/coverage.md"), "utf8");
  const section = table.split("## Bodies outside the document's schemas")[1];
  expect(
    section,
    "coverage.md lists the bodies outside the schemas",
  ).toBeDefined();
  return new Set(
    [...(section ?? "").matchAll(/^- `([A-Z]+ [^`]+)`/gm)].map((m) => m[1]),
  );
}

describe("every covered operation is validated against the served document", () => {
  const validated = new Set<string>();
  for (const file of testFiles(join(repoRoot, "src/suites"))) {
    const text = readFileSync(file, "utf8");
    // Only a success body counts: a refusal validated on a door whose 2xx
    // is not JSON says nothing about that 2xx.
    for (const m of text.matchAll(
      /expectMatchesSchema\(\s*"([A-Z]+)",\s*"([^"]+)",\s*(\d{3})?/g,
    )) {
      if (m[3] !== undefined && !m[3].startsWith("2")) continue;
      validated.add(`${m[1]} ${m[2]}`);
    }
  }

  it("finds validation calls at all", () => {
    expect(validated.size).toBeGreaterThan(40);
  });

  it("names every covered operation in a validation call or in the exceptions", () => {
    const exempt = outsideTheSchemas();
    const missing = coverageRows()
      .filter((row) => row.status === "covered")
      .map((row) => `${row.method} ${row.path}`)
      .filter((key) => !validated.has(key) && !exempt.has(key));
    expect(missing).toEqual([]);
  });

  it("keeps no exception the suite validates anyway", () => {
    const stale = [...outsideTheSchemas()].filter((key) => validated.has(key));
    expect(stale).toEqual([]);
  });
});
