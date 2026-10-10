/**
 * Every version names the sign-in whose request wrote it, or none by a rule.
 *
 * A credential's write names the credential (`item-write.ts`), and every
 * platform write says who it is written by: `ItemWriter` will not compile
 * without `by`, and every item write goes through `writeItem`
 * (`item-write-census.test.ts`). What the compiler cannot judge is a write
 * that names nobody, so each module that does is named here with why.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

/** The source without its comments, so a mention is not a use. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** A write said to be written by nobody. */
const NOBODY = /\bby:\s*null\b/;

/** Modules whose writes name no writer, each with why no sign-in wrote them. */
const NOBODY_WRITES: Record<string, string> = {
  "enrichment/sweeper.ts":
    "the enrichment sweep, which no request asks for (`versions/writer-none`)",
  "storage/retention.ts":
    "the retention sweep's purges, which write no version, and the retirement of an app unused past its window, which no request asks for",
};

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        rel !== "test-utils.ts"
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

describe("every version names its writer", () => {
  it("names no writer only where a reason is named", () => {
    const nobody = sources().filter((rel) =>
      NOBODY.test(code(readFileSync(join(root, rel), "utf8"))),
    );
    expect(nobody).toEqual(Object.keys(NOBODY_WRITES).sort());
  });

  it("sees a write by nobody, and not one only mentioned", () => {
    expect(
      NOBODY.test(code('writeItem(s, { kind: "platform", by: null }, w)')),
    ).toBe(true);
    expect(NOBODY.test(code("// by: null\nconst a = 1;"))).toBe(false);
    expect(
      NOBODY.test(
        code('writeItem(s, { kind: "platform", by: requestWriter(c) }, w)'),
      ),
    ).toBe(false);
  });
});
