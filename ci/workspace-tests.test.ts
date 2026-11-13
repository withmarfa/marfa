/**
 * The workspace's tests are one job of `ci.yml`, `workspace-tests`, which
 * runs when the workspace changed and the pull request is not a draft. The
 * quick job runs no test, so that its format check, classifier test and
 * reference check report as soon as they can. `Full CI` waits for both.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  steps: { run?: string }[];
}

const { jobs } = parse(
  readFileSync(
    resolve(import.meta.dirname, "..", ".github/workflows/ci.yml"),
    "utf8",
  ),
) as { jobs: Record<string, Job> };

const tests = jobs["workspace-tests"];
const needsOf = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

describe("the workspace tests", () => {
  it("run the whole workspace once", () => {
    const test = tests?.steps.filter((step) =>
      /\bpnpm test\b/.test(step.run ?? ""),
    );
    expect(test).toHaveLength(1);
    expect(test?.[0]?.run).not.toContain("--shard");
    expect(tests?.name).toBe("Workspace tests");
  });

  it("run when the workspace changed and the pull request is not a draft, or when the classifier did not answer", () => {
    expect(tests?.needs).toBe("changes");
    expect(tests?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || (needs.changes.outputs.workspace != 'false' && needs.changes.outputs.full != 'false')) }}",
    );
  });

  it("are waited for by Full CI and by the report of a failed night, and the quick job runs no test", () => {
    expect(needsOf(jobs.gate)).toContain("workspace-tests");
    expect(needsOf(jobs["report-failure"])).toContain("workspace-tests");
    expect(jobs["quick-checks"]?.steps.length).toBeGreaterThan(0);
    for (const step of jobs["quick-checks"]?.steps ?? []) {
      expect(step.run ?? "").not.toMatch(/\bpnpm test\b/);
    }
  });
});
