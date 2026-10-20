/**
 * The workspace's tests run as three shards of `ci-sqlite-tests`. Vitest
 * splits the files by a hash of each path, so the shard numbers and the
 * count they are divided by must agree, or a file is run twice or never.
 * `Full CI` waits for the job, which fails if any shard does.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps: { run?: string }[];
}

const { jobs } = parse(
  readFileSync(
    resolve(import.meta.dirname, "..", ".github/workflows/ci.yml"),
    "utf8",
  ),
) as { jobs: Record<string, Job> };

const shards = jobs["ci-sqlite-tests"];
const needsOf = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

describe("the SQLite test shards", () => {
  it("number 1 to 3, and each runs its own third of the files", () => {
    expect(shards?.strategy?.matrix?.shard).toEqual([1, 2, 3]);
    const test = shards?.steps.filter((step) =>
      /\bpnpm test\b/.test(step.run ?? ""),
    );
    expect(test).toHaveLength(1);
    expect(test?.[0]?.run).toContain("--shard=${{ matrix.shard }}/3");
    expect(shards?.name).toBe("CI (SQLite) tests ${{ matrix.shard }}/3");
  });

  it("all report, so one failure shows the others", () => {
    expect(shards?.strategy?.["fail-fast"]).toBe(false);
  });

  it("run when the workspace changed and the pull request is not a draft, or when the classifier did not answer", () => {
    expect(shards?.needs).toBe("changes");
    expect(shards?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || (needs.changes.outputs.workspace != 'false' && needs.changes.outputs.full != 'false')) }}",
    );
  });

  it("are waited for by Full CI and by the report of a failed night, and the job that remains runs no test", () => {
    expect(needsOf(jobs.gate)).toContain("ci-sqlite-tests");
    expect(needsOf(jobs["report-failure"])).toContain("ci-sqlite-tests");
    for (const step of jobs["ci-sqlite"]?.steps ?? []) {
      expect(step.run ?? "").not.toMatch(/\bpnpm test\b/);
    }
  });
});
