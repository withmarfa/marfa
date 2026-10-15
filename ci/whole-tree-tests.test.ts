/**
 * `pnpm test:changed` runs the tests listed in `scripts/whole-tree-tests.ts`
 * whatever the diff, since Vitest selects by import and cannot see a test
 * that reads files by path.
 *
 * **A filter that matches nothing drops its test without a sound.** Vitest
 * takes the filters as alternatives, so one that matches no file adds
 * nothing and raises no error as long as another matches. Renaming a listed
 * test would turn its entry into a no-op while the quick check stayed
 * green. Each entry has to name at least one file, and none can start with
 * a dash, which Vitest would read as an option.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_FILTERS,
  ROOT_FILTERS,
} from "../scripts/whole-tree-tests.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Test files in the tree, including ones not yet added to Git. */
const testFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts"],
  { cwd: ROOT, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

const rootFiles = testFiles.filter(
  (file) => file.startsWith("packages/") || file.startsWith("ci/"),
);
const conformanceFiles = testFiles
  .filter((file) => file.startsWith("conformance/"))
  .map((file) => file.slice("conformance/".length));

describe("the whole-tree tests that test:changed always runs", () => {
  it.each([
    ["the repository root", ROOT_FILTERS, rootFiles],
    ["the conformance suite", CONFORMANCE_FILTERS, conformanceFiles],
  ] as const)(
    "names a test file with every filter for %s",
    (_, filters, files) => {
      expect(files.length).toBeGreaterThan(0);
      expect(filters.length).toBeGreaterThan(0);
      for (const filter of filters) {
        expect(filter.startsWith("-"), `${filter} reads as an option`).toBe(
          false,
        );
        expect(
          files.some((file) => file.includes(filter)),
          `${filter} matches no test file`,
        ).toBe(true);
      }
    },
  );

  it("covers every census, whatever it is named after", () => {
    const census = rootFiles.filter((file) => file.includes("census"));
    expect(census.length).toBeGreaterThan(10);
    for (const file of census) {
      expect(
        ROOT_FILTERS.some((filter) => file.includes(filter)),
        `${file} is a census that test:changed would not run`,
      ).toBe(true);
    }
  });
});
