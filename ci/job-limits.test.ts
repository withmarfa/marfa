/**
 * What every job of the workflows costs when it hangs or fails: a time limit
 * of its own, and, outside `release.yml`, artifacts kept only when something
 * failed. `release.yml` is left out of the artifact rule: what it uploads is
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

/**
 * Each job's limit in minutes, as `.github/AGENTS.md` sets the rule: twice the
 * 90th percentile of its successful runs, rounded up to a multiple of 5 and
 * never under 5, or 3 for a job that only reads a result. Where a figure is
 * higher, the reason is beside it: a job whose slow run is a cold cache or a
 * wait on another service must clear that run, which a failure would repeat.
 * A hung job then ends at its limit, not at GitHub's six hours. A limit set
 * here is changed from a new measurement, in the same pull request as the
 * workflow.
 */
const LIMITS: Record<string, number> = {
  "ci.yml:changes": 3,
  "ci.yml:quick-checks": 5,
  "ci.yml:typecheck": 5,
  "ci.yml:lint": 5,
  "ci.yml:stop-after-format": 3,
  "ci.yml:stop-after-typecheck": 3,
  "ci.yml:stop-after-lint": 3,
  "ci.yml:workspace-tests": 5,
  // A run on a cold cache hit the old limit of 45 and failed `main`.
  "ci.yml:core-checks": 60,
  "ci.yml:core-checks-linux": 40,
  // A cold build of the one crate takes about 3.5 minutes.
  "ci.yml:core-fault-injection": 10,
  // A change to what the native readers are built from builds PDFium and
  // Tesseract again, which took up to 42 minutes.
  "ci.yml:core-native": 50,
  "ci.yml:conformance-offline": 10,
  "ci.yml:mcp-conformance": 5,
  "ci.yml:conformance": 3,
  // The same cold native build, less the second server the job no longer builds.
  "ci.yml:rust-contract": 45,
  "ci.yml:rust-contract-release": 45,
  "ci.yml:rust-contract-shards": 25,
  "ci.yml:rust-contract-release-check": 10,
  "ci.yml:rust-contract-score": 10,
  "ci.yml:restore-drill": 10,
  "ci.yml:rust-contract-macos": 40,
  "ci.yml:rust-contract-macos-shards": 45,
  "ci.yml:rust-contract-macos-score": 5,
  // The native build again, and the image after it.
  "ci.yml:image": 50,
  "ci.yml:types-freshness": 5,
  "ci.yml:version-fields": 5,
  "ci.yml:clients-freshness": 5,
  "ci.yml:gate": 3,
  "ci.yml:report-failure": 5,
  // A cold cache on a Mac: the run that hit 45 minutes was one.
  "core-live.yml:live": 60,
  "core.yml:report-failure": 5,
  // The Rust analysis takes 11 to 17 minutes; the others a few.
  "codeql.yml:analyze": 30,
  "benchmarks.yml:server": 30,
  "benchmarks.yml:benchmarks": 100,
  // The seed alone takes 15 to 45 minutes; each step has a budget of its own,
  // and the test below holds the job to their sum.
  "benchmarks.yml:scale": 180,
  "benchmarks.yml:report-failure": 5,
  "pdfium-upkeep.yml:prepare": 10,
  "pdfium-upkeep.yml:report-failure": 5,
  "pr-description.yml:description": 5,
  "release.yml:require-green-ci": 5,
  "release.yml:require-green-core": 5,
  "release.yml:version": 5,
  "release.yml:programs-macos": 90,
  // `sign-binary.sh` waits up to 30 minutes for Apple's notary, for each of two programs.
  "release.yml:sign": 75,
  "release.yml:programs-linux": 70,
  "release.yml:run-linux": 5,
  "release.yml:collect": 5,
  "release.yml:image": 20,
  "release.yml:install-proof": 10,
  "release.yml:publish": 15,
  "release.yml:tap": 5,
};

const workflows = readdirSync(WORKFLOWS).filter((file) =>
  file.endsWith(".yml"),
);
const files = workflows.filter((file) => file !== "release.yml");

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
  // server the build job made, so both are inputs and not diagnostics. The
  // job that runs the fixture for the server without test hooks reports the
  // same way, and downloads the build of that server.
  "ci.yml:rust-contract:Keep the server",
  "ci.yml:rust-contract-release:Keep the server without test hooks",
  "ci.yml:rust-contract-shards:Keep the report",
  "ci.yml:rust-contract-release-check:Keep the report",
  "ci.yml:rust-contract-macos:Keep what is under test",
  "ci.yml:rust-contract-macos-shards:Keep the report",
  // A shard passes when a test fails, which only the score reports, so its
  // log is kept for that failure.
  "ci.yml:rust-contract-shards:Keep the server log",
  "ci.yml:rust-contract-release-check:Keep the server log",
  // Both nightly jobs download it, so it is an input and not a diagnostic.
  "benchmarks.yml:server:Keep the server",
  "benchmarks.yml:benchmarks:Keep the load reports",
  // The next night reads it to show a change, so a passing night keeps it too.
  "benchmarks.yml:scale:Keep the scale figures",
]);

describe("job limits", () => {
  it.each(workflows)(
    "%s gives every job that runs steps the time limit LIMITS names",
    (file) => {
      for (const [id, job] of jobsOf(file)) {
        // A job that calls a workflow takes no limit, which GitHub refuses
        // there; the called workflow's jobs carry their own.
        if (job.uses !== undefined) continue;
        expect(job["timeout-minutes"], `${file}: ${id}`).toBe(
          LIMITS[`${file}:${id}`],
        );
      }
    },
  );

  it("names only jobs that exist", () => {
    const found = new Set(
      workflows.flatMap((file) =>
        jobsOf(file)
          .filter(([, job]) => job.uses === undefined)
          .map(([id]) => `${file}:${id}`),
      ),
    );
    for (const key of Object.keys(LIMITS))
      expect(found.has(key), key).toBe(true);
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
