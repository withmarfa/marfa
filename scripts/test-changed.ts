/**
 * The quick check before a push: `pnpm test:changed`.
 *
 * Runs the tests Vitest selects from the diff against `origin/main`, then
 * the whole-tree tests that selection cannot see (`whole-tree-tests.ts`).
 * Each step runs even when an earlier one failed, so one run shows every
 * failure. With `--whole-tree-only` it skips the diff step.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFORMANCE_FILTERS, ROOT_FILTERS } from "./whole-tree-tests.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Vitest reads an argument that starts with a dash as an option, so no filter may. */
function vitest(cwd: string, args: string[], filters: readonly string[]) {
  const argv = ["exec", "vitest", "run", ...args, ...filters];
  console.log(`\n$ pnpm ${argv.join(" ")}\n`);
  const run = spawnSync("pnpm", argv, { cwd, stdio: "inherit" });
  return run.status === 0;
}

const steps = [
  ...(process.argv.includes("--whole-tree-only")
    ? []
    : [() => vitest(ROOT, ["--changed", "origin/main"], [])]),
  () => vitest(ROOT, [], ROOT_FILTERS),
  () =>
    vitest(
      `${ROOT}conformance`,
      ["--project", "generators"],
      CONFORMANCE_FILTERS,
    ),
];

// Every step runs; `every` would stop at the first failure.
const results = steps.map((step) => step());
process.exit(results.every(Boolean) ? 0 : 1);
