/**
 * What every job of the workflows that run on a pull request or a schedule
 * costs when it hangs or fails: a time limit of its own, and artifacts kept
 * only when something failed. `release.yml` is left out: what it uploads is
 * what it releases.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(import.meta.dirname, "..", ".github", "workflows");

interface Step {
  name?: string;
  if?: string;
  uses?: string;
}
interface Job {
  "timeout-minutes"?: number;
  uses?: string;
  steps?: Step[];
}

const files = readdirSync(WORKFLOWS).filter(
  (file) => file.endsWith(".yml") && file !== "release.yml",
);

const jobsOf = (file: string): [string, Job][] =>
  Object.entries(
    (
      parse(readFileSync(join(WORKFLOWS, file), "utf8")) as {
        jobs: Record<string, Job>;
      }
    ).jobs,
  );

/**
 * Artifacts kept whatever the verdict, with the reason. The shard's log is the
 * input of `Conformance statuses`, which reads every shard's; the load reports
 * are what the benchmarks exist to produce.
 */
const KEPT_ON_SUCCESS = new Set([
  "ci.yml:conformance-shards:Keep the server log",
  "benchmarks.yml:benchmarks:Keep the load reports",
]);

describe("job limits", () => {
  it.each(files)("%s gives every job that runs steps a time limit", (file) => {
    for (const [id, job] of jobsOf(file)) {
      if (job.uses !== undefined) continue;
      const limit = job["timeout-minutes"];
      // A limit is a number, or an expression whose numbers are the limits.
      const numbers =
        typeof limit === "number" ? [limit] : String(limit).match(/\d+/g);
      expect(numbers, `${file}: ${id}`).not.toBeNull();
      expect(
        Math.max(...(numbers ?? []).map(Number)),
        `${file}: ${id}`,
      ).toBeLessThanOrEqual(100);
    }
  });

  it.each(files)("%s uploads an artifact only after a failure", (file) => {
    for (const [id, job] of jobsOf(file)) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/upload-artifact")) continue;
        const key = `${file}:${id}:${step.name ?? ""}`;
        if (KEPT_ON_SUCCESS.has(key)) continue;
        expect(step.if, key).toBe("failure()");
      }
    }
  });

  it("names only artifact steps that exist", () => {
    const found = new Set(
      files.flatMap((file) =>
        jobsOf(file).flatMap(([id, job]) =>
          (job.steps ?? [])
            .filter((step) => step.uses?.startsWith("actions/upload-artifact"))
            .map((step) => `${file}:${id}:${step.name ?? ""}`),
        ),
      ),
    );
    for (const key of KEPT_ON_SUCCESS) expect(found.has(key), key).toBe(true);
  });
});
