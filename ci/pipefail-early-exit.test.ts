/**
 * A pipeline whose consumer can exit early must not decide anything, in a
 * `run:` block that sets `pipefail`.
 *
 * `grep -q` exits the moment it matches. Its producer is then left writing
 * into a closed pipe and dies, and `pipefail` makes the whole pipeline
 * non-zero **even though grep matched**. An `if` over that pipeline takes
 * the else branch, so the guard answers the opposite of the truth, with
 * nothing on the exit status and nothing in the log.
 *
 * That inversion is what earns a guard, rather than the flakiness. A check
 * that fails when the code is right teaches its readers that the suite lies.
 * A check that silently answers "no" makes a job that should have run not
 * run, and the pull request goes green having skipped it. This repository's
 * own rule is that a guard which cannot run fails rather than passes, and
 * this shape does the opposite of that.
 *
 * Not theoretical. Measured on a 7.4 MB changed-path list, the piped form
 * answered NO MATCH for a path that was present, with exit status zero; the
 * here-string form answered MATCH. The threshold is the pipe buffer, so an
 * ordinary pull request is unaffected and a very large one is not — which is
 * the worst available shape for noticing.
 *
 * **Two bounds, both load-bearing, because the obvious wider version of this
 * check asserts something false.**
 *
 *   - Only `run:` blocks that set `pipefail`. GitHub runs a `run:` step under
 *     `bash -e`, not `-o pipefail`, so without an explicit set the pipeline
 *     already takes grep's own status and the shape is correct, and a check
 *     that ignored the set would flag a correct block.
 *   - Only `if` conditions, because that is where a wrong answer becomes a
 *     wrong decision. A pipeline whose status is discarded, or one guarded
 *     with `|| true`, is outside this deliberately.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);

/** `grep -q`, `grep -m N` and `head` all stop reading before their input ends. */
const EARLY_EXIT_CONSUMER =
  /\|\s*(grep\s+(?:-\S*\s+)*-\S*q|grep\s+(?:-\S*\s+)*-m\s|head\b)/;
const SETS_PIPEFAIL = /set\s+-\S*o?\S*\s*pipefail|set\s+-o\s+pipefail/;

/**
 * Split a workflow into its `run:` blocks by indentation, which is enough
 * here and needs no YAML parser: a block runs until a line at or below the
 * `run:` key's own indent.
 */
export function runBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-?\s*run:\s*\|/.exec(lines[i] ?? "");
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent)
        break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

export function offendingLines(text: string): string[] {
  return runBlocks(text)
    .filter((block) => SETS_PIPEFAIL.test(block))
    .flatMap((block) => block.split("\n").map((l) => l.trim()))
    .filter(
      (line) =>
        line.startsWith("if ") &&
        EARLY_EXIT_CONSUMER.test(line) &&
        !line.includes("|| true"),
    );
}

describe("a decision taken from a pipeline that can exit early", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));

  it("finds the workflows, so an empty pass cannot be a missing directory", () => {
    // The control this file needs most: a glob matching nothing would report
    // every assertion below as satisfied.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("does not appear in %s", (file) => {
    expect(offendingLines(readFileSync(join(WORKFLOWS, file), "utf8"))).toEqual(
      [],
    );
  });

  it("recognizes the shape, and only where pipefail is set", () => {
    // Without these the regex could be wrong in a way that passes everything.
    const withPipefail = [
      "      - run: |",
      "          set -euo pipefail",
      "          if echo \"$changed\" | grep -qE '^packages/' ; then",
      "            echo yes",
      "          fi",
    ].join("\n");
    expect(offendingLines(withPipefail)).toHaveLength(1);

    // The same line without the set is correct, and this is the bound that
    // stops the check asserting something false about a block without it.
    const withoutPipefail = withPipefail.replace(
      "          set -euo pipefail\n",
      "",
    );
    expect(offendingLines(withoutPipefail)).toEqual([]);

    const hereString = withPipefail.replace(
      "if echo \"$changed\" | grep -qE '^packages/' ; then",
      "if grep -qE '^packages/' <<< \"$changed\"; then",
    );
    expect(offendingLines(hereString)).toEqual([]);
  });
});
