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
  "timeout-minutes"?: number;
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
 * Artifacts kept whatever the verdict, with the reason. The load reports are
 * what the benchmarks exist to produce.
 */
const KEPT_ON_SUCCESS = new Set([
  // The score job reads every shard's report, and each shard downloads the
  // server the build job made, so both are inputs and not diagnostics.
  "ci.yml:rust-contract:Keep the server",
  "ci.yml:rust-contract:Keep the server without test hooks",
  "ci.yml:rust-contract-shards:Keep the report",
  // A shard passes when a test fails, which only the score reports, so its
  // log is kept for that failure.
  "ci.yml:rust-contract-shards:Keep the server log",
  // Both nightly jobs download it, so it is an input and not a diagnostic.
  "benchmarks.yml:server:Keep the server",
  "benchmarks.yml:benchmarks:Keep the load reports",
  // The next night reads it to show a change, so a passing night keeps it too.
  "benchmarks.yml:scale:Keep the scale figures",
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
      // The scale benchmark seeds a 250,000-item instance, measures it, then
      // times a folder and a device against it: 45 to 75 minutes on a hosted
      // runner, the seed alone 15 to 45.
      const ceiling = file === "benchmarks.yml" && id === "scale" ? 180 : 100;
      expect(
        Math.max(...(numbers ?? []).map(Number)),
        `${file}: ${id}`,
      ).toBeLessThanOrEqual(ceiling);
    }
  });

  it("gives each step of the scale benchmark a limit, the sum of which leaves the job's room to finish", () => {
    const job = jobsOf("benchmarks.yml").find(([id]) => id === "scale")?.[1];
    expect(job).toBeDefined();
    const steps = job?.steps ?? [];
    // The steps that measure or build, each of which can hang. The rest set up
    // the toolchain, report and upload, and take seconds.
    const heavy = steps.filter(
      (step) =>
        step["timeout-minutes"] !== undefined ||
        /^(Build|Boot|Seed|Restart|Reads|Parent|Archive|Storage|Device|Folder)/.test(
          step.name ?? "",
        ),
    );
    expect(heavy.length).toBeGreaterThan(8);
    for (const step of heavy) {
      expect(step["timeout-minutes"], step.name).toBeTypeOf("number");
    }
    const sum = heavy.reduce(
      (a, step) => a + (step["timeout-minutes"] ?? 0),
      0,
    );
    // `finish`, the artifact upload and `judge`, and the toolchain steps,
    // which take minutes, not hours.
    const reserve = 20;
    expect(sum + reserve).toBeLessThanOrEqual(job?.["timeout-minutes"] ?? 0);
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
