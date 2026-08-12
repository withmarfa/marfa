/**
 * The PDF reader's version is a security property, so it is asserted.
 *
 * `officeparser` pins `pdfjs-dist` to an exact version, and the version it
 * pins carries an advisory for arbitrary JavaScript execution on opening a
 * malicious document. No published release of `officeparser` admits the
 * patched reader, so the version is forced by a package-manager override.
 *
 * An override is invisible. Nothing fails if a future contributor drops it,
 * if an `officeparser` bump re-pins the reader, or if an install resolves it
 * differently — the extractor keeps working and quietly parses attacker-
 * supplied documents with a vulnerable reader again. This test is the only
 * thing that would notice.
 *
 * It deliberately resolves the reader the way `officeparser` does, from
 * `officeparser`'s own location, rather than from this package. Asserting on
 * what the server resolves would pass while the parser that actually opens
 * the bytes loaded something else.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

/** First release carrying the fix for the arbitrary-execution advisory. */
const MINIMUM_SAFE = [6, 2, 108] as const;

function parse(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function isAtLeast(actual: number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i += 1) {
    const a = actual[i] ?? 0;
    const m = minimum[i] ?? 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true;
}

describe("the PDF reader behind the document extractor", () => {
  it("resolves at or above the version that patched arbitrary execution", () => {
    const fromHere = createRequire(import.meta.url);
    // `officeparser` does not export `./package.json`, so the main entry is
    // the reachable anchor for a require rooted inside it.
    const fromOfficeparser = createRequire(fromHere.resolve("officeparser"));
    const { version } = fromOfficeparser("pdfjs-dist/package.json") as {
      version: string;
    };

    expect(
      isAtLeast(parse(version), MINIMUM_SAFE),
      `the document extractor resolved pdfjs-dist ${version}, below the ` +
        `patched ${MINIMUM_SAFE.join(".")}. The override that forces it has ` +
        `been lost, or officeparser re-pinned the reader.`,
    ).toBe(true);
  });
});
