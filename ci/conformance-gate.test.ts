/**
 * `Conformance`, the one verdict `Full CI` collects for the offline lane and
 * MCP conformance: that it exists under that name and nothing else has it,
 * that it fails for any job that ended as anything but success or skipped and
 * passes for ones the classifier skipped, and that the Rust contract shards
 * cover every file of a split project once.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  assignShards,
  secondsOf,
  shardLoads,
} from "../conformance/src/utils/shard-sequencer.js";

const ROOT = resolve(import.meta.dirname, "..");

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number | string;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: { args: string }[] };
  };
  steps: Step[];
}

const { jobs } = parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const CONFORMANCE_JOBS = ["conformance-offline", "mcp-conformance"];

describe("the Conformance check", () => {
  it("is one job with that exact name, and no other job is called that", () => {
    expect(
      Object.entries(jobs)
        .filter(([, job]) => job.name === "Conformance")
        .map(([id]) => id),
    ).toEqual(["conformance"]);
    for (const id of CONFORMANCE_JOBS) {
      expect(jobs[id]?.name, id).not.toBe("Conformance");
    }
  });

  it("waits for every conformance job, whether or not they ran", () => {
    expect(jobs.conformance?.needs).toEqual(["changes", ...CONFORMANCE_JOBS]);
    // Not `success()`, which a skipped job fails: the classifier skips them.
    expect(jobs.conformance?.if).toBe("${{ !cancelled() }}");
    // Every job collected is one this workflow defines.
    for (const id of CONFORMANCE_JOBS) expect(jobs[id], id).toBeDefined();
  });

  describe("as the shell step reads the results of the jobs it waits on", () => {
    const step = jobs.conformance?.steps[0];
    const verdict = (
      results: string,
      owed: { offline?: boolean; mcp?: boolean } = {},
    ): number => {
      const [offline = "", mcp = ""] = results.split(" ");
      try {
        execFileSync("sh", ["-c", step?.run ?? "exit 99"], {
          env: {
            ...process.env,
            RESULTS: `success ${results}`,
            OFFLINE: offline,
            OFFLINE_OWED: String(owed.offline ?? false),
            MCP: mcp,
            MCP_OWED: String(owed.mcp ?? false),
          },
          stdio: "pipe",
        });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };

    it("reads its results from the jobs it needs", () => {
      expect(step?.env?.RESULTS).toBe("${{ join(needs.*.result, ' ') }}");
    });

    it.each([
      ["every job passed", "success success"],
      ["the classifier skipped every job", "skipped skipped"],
      ["only the offline lane ran", "success skipped"],
      ["only MCP conformance ran", "skipped success"],
    ])("passes when %s", (_, results) => {
      expect(verdict(results)).toBe(0);
    });

    it("fails when the offline lane was owed a run and was skipped", () => {
      expect(verdict("skipped success", { offline: true })).toBe(1);
    });

    it("fails when MCP conformance was owed a run and was skipped", () => {
      expect(verdict("success skipped", { mcp: true })).toBe(1);
    });

    it("passes when the jobs owed a run ran", () => {
      expect(verdict("success success", { offline: true, mcp: true })).toBe(0);
    });

    it.each([
      ["the offline lane failed", "failure skipped"],
      ["MCP conformance failed", "skipped failure"],
      ["MCP conformance was cancelled", "skipped cancelled"],
      ["the offline lane was abandoned", "abandoned skipped"],
      ["MCP conformance was abandoned", "skipped abandoned"],
    ])("fails when %s", (_, results) => {
      expect(verdict(results)).toBe(1);
    });
  });
});

describe("the files of each group, over its shards", () => {
  const filesOf = (project: string): string[] =>
    readdirSync(resolve(ROOT, "conformance/src/suites", project))
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => !name.endsWith(".decision.test.ts"))
      .map((name) => `src/suites/${project}/${name}`);

  const split = new Map<string, number>();
  for (const entry of jobs["rust-contract-shards"]?.strategy?.matrix?.include ??
    []) {
    const shard = /--project (\w+) --shard=\d+\/(\d+)/.exec(entry.args);
    if (shard) split.set(shard[1] ?? "", Number(shard[2]));
  }

  it("finds the split projects of the Rust contract shards", () => {
    expect([...split.keys()].sort()).toEqual(["compliance", "device"]);
  });

  it.each([...split])(
    "%s runs every file of its project in exactly one of %i shards, and no shard is far from another",
    (project, count) => {
      const files = filesOf(project);
      expect(files.length).toBeGreaterThan(count);
      const shards = assignShards(files, count);
      expect(shards.flat().sort()).toEqual([...files].sort());
      const loads = shardLoads(shards);
      // The slowest shard sets how long the job takes.
      expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.2);
      // The witness: the weights do the work, since the longest file by
      // itself is heavier than a fair share of the plain count.
      const heaviest = Math.max(...files.map((file) => secondsOf(file)));
      expect(heaviest).toBeGreaterThan(Math.min(...loads) / 4);
    },
  );
});
