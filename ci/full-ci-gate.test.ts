/**
 * `Full CI`, the check a ruleset waits on: the job of `ci.yml` that collects
 * the rest. On a draft it is named `Draft CI`, so the required `Full CI`
 * stays expected, and blocks a merge, until the run that marking the pull
 * request ready starts has finished: a skipped job passes a required check,
 * and a draft skips most jobs. These tests hold that it exists once, under
 * that name, waits for every other job, and fails for a failed or a cancelled
 * job and for nothing else.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

interface Step {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  steps: Step[];
}

const { jobs } = parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const GATE = "gate";
/** The job that opens an issue for a failed nightly run. Nothing waits for it. */
const REPORT = "report-failure";
const NAME =
  "${{ github.event.pull_request.draft && 'Draft CI' || 'Full CI' }}";

const needsOf = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

/** The jobs of a workflow that `Full CI` does not wait for. */
function unwaited(all: Record<string, Job>): string[] {
  const waited = new Set(needsOf(all[GATE]));
  return Object.keys(all).filter((id) => !waited.has(id));
}

describe("Full CI", () => {
  it("is one job, named Full CI, or Draft CI for a draft, and no other job has either name", () => {
    expect(jobs[GATE]?.name).toBe(NAME);
    expect(
      Object.entries(jobs)
        .filter(([, job]) => /Full CI|Draft CI/.test(job.name ?? ""))
        .map(([id]) => id),
    ).toEqual([GATE]);
  });

  it("waits for every other job, so that adding a job without making it a need fails here", () => {
    expect(unwaited(jobs).sort()).toEqual([GATE, REPORT].sort());
    expect(needsOf(jobs[GATE]).sort()).toEqual(
      Object.keys(jobs)
        .filter((id) => id !== GATE && id !== REPORT)
        .sort(),
    );
    // The witness: the same check refuses a job nobody made a need.
    const added = {
      ...jobs,
      "a-new-job": { steps: [{ run: "true" }] },
    };
    expect(unwaited(added).sort()).toEqual([GATE, REPORT, "a-new-job"].sort());
  });

  it("is waited for by no job, so the report of a failed night cannot hold it", () => {
    for (const [id, job] of Object.entries(jobs)) {
      expect(needsOf(job), id).not.toContain(GATE);
    }
    expect(needsOf(jobs[REPORT]), REPORT).not.toContain(GATE);
  });

  it("runs after a failed job, and is skipped when the run is cancelled", () => {
    // Not `always()`: a cancelled run would report `Full CI` green. A skipped
    // job keeps its raw name and never reports as `Full CI`.
    expect(jobs[GATE]?.if).toBe("${{ !cancelled() }}");
    expect(jobs[GATE]?.["runs-on"]).toBe("ubuntu-latest");
  });

  it("reads the results of the jobs it waits for, and does nothing else", () => {
    expect(jobs[GATE]?.steps.map((step) => step.env)).toEqual([
      { RESULTS: "${{ join(needs.*.result, ' ') }}" },
    ]);
    expect(jobs[GATE]?.steps).toHaveLength(1);
  });

  describe("as the shell step reads the results", () => {
    const script = jobs[GATE]?.steps[0]?.run ?? "exit 99";
    const status = (results: string): number => {
      try {
        execFileSync("bash", ["-e", "-c", script], {
          env: { ...process.env, RESULTS: results },
          stdio: "pipe",
        });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };

    it.each([
      ["every job passed", "success success success success"],
      ["the classifier skipped jobs", "success skipped skipped skipped"],
      ["every job was skipped", "skipped skipped skipped"],
      ["a lone job passed", "success"],
    ])("passes when %s", (_, results) => {
      expect(status(results)).toBe(0);
    });

    it.each([
      ["a job failed", "success failure skipped success"],
      ["the first job failed", "failure skipped skipped"],
      ["the last job failed", "success success failure"],
      ["a job was cancelled", "success success cancelled"],
      ["a lone job failed", "failure"],
      ["a lone job was cancelled", "cancelled"],
      ["a failure is among skipped jobs", "skipped failure skipped"],
    ])("fails when %s", (_, results) => {
      expect(status(results)).toBe(1);
    });
  });
});
