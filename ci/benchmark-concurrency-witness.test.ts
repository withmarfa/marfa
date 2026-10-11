import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("runs the HTTP overlap witness in the nightly benchmark job", () => {
  const workflow = parse(
    readFileSync(
      resolve(import.meta.dirname, "../.github/workflows/benchmarks.yml"),
      "utf8",
    ),
  ) as {
    jobs: {
      benchmarks: { steps: { name?: string; run?: string; if?: string }[] };
    };
  };
  const steps = workflow.jobs.benchmarks.steps;
  const witness = steps.findIndex(
    (step) => step.name === "Witness concurrent HTTP reads",
  );
  const load = steps.findIndex((step) => step.name === "Load");
  expect(witness).toBeGreaterThan(-1);
  expect(load).toBeGreaterThan(witness);
  expect(steps[witness].run).toBe(
    "pnpm exec vitest run packages/server/src/read-concurrency.test.ts",
  );
  expect(steps[witness].if).toBeUndefined();
});
