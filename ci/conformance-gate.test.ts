/**
 * `Conformance`, the check a ruleset waits on, once its work is split over
 * shards: that it still exists under that name and nothing else has it, that
 * it fails for any shard that failed or was cancelled and passes for ones the
 * classifier skipped, that the shards cover every file of their project once,
 * and that the matrix `ci.yml` falls back to is the classifier's.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_GROUPS,
  classify,
  conformanceShards,
} from "../scripts/ci-required.js";
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
  "timeout-minutes"?: number;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: string };
  };
  steps: Step[];
}

const { jobs } = parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const SHARD_JOB = "conformance-shards";
const CONFORMANCE_JOBS = [
  "conformance-offline",
  SHARD_JOB,
  "conformance-statuses",
];

describe("the Conformance check", () => {
  it("is one job with that exact name, and no shard is called that", () => {
    expect(
      Object.entries(jobs)
        .filter(([, job]) => job.name === "Conformance")
        .map(([id]) => id),
    ).toEqual(["conformance"]);
    for (const id of CONFORMANCE_JOBS) {
      expect(jobs[id]?.name, id).not.toBe("Conformance");
    }
    expect(jobs[SHARD_JOB]?.name).toBe(
      "Conformance shard (${{ matrix.name }})",
    );
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
      owed: { shards?: boolean; offline?: boolean } = {},
    ): number => {
      const [offline = "", shards = ""] = results.split(" ");
      try {
        execFileSync("sh", ["-c", step?.run ?? "exit 99"], {
          env: {
            ...process.env,
            RESULTS: `success ${results}`,
            SHARDS: shards,
            SHARDS_OWED: String(owed.shards ?? false),
            OFFLINE: offline,
            OFFLINE_OWED: String(owed.offline ?? false),
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
      ["every job passed", "success success success"],
      ["the classifier skipped every job", "skipped skipped skipped"],
      ["only the offline lane ran", "success skipped skipped"],
      [
        "the shards ran and the statuses job did not",
        "success success skipped",
      ],
    ])("passes when %s", (_, results) => {
      expect(verdict(results)).toBe(0);
    });

    it("fails when the shards were owed a run and were skipped", () => {
      expect(verdict("success skipped skipped", { shards: true })).toBe(1);
    });

    it("fails when the offline lane was owed a run and was skipped", () => {
      expect(verdict("skipped success skipped", { offline: true })).toBe(1);
    });

    it("passes when the jobs owed a run ran", () => {
      expect(
        verdict("success success success", { shards: true, offline: true }),
      ).toBe(0);
    });

    it.each([
      ["a shard failed", "success failure skipped"],
      ["a shard was cancelled", "success cancelled skipped"],
      ["the statuses job failed", "success success failure"],
      ["the offline lane failed", "failure skipped skipped"],
    ])("fails when %s", (_, results) => {
      expect(verdict(results)).toBe(1);
    });
  });
});

describe("the shard matrix", () => {
  const job = jobs[SHARD_JOB];

  it("falls back to every shard when the classifier did not answer, and to none for none", () => {
    const include = job?.strategy?.matrix?.include ?? "";
    const literal = /\|\| '(\[.*\])'\) \}\}$/.exec(include)?.[1] ?? "";
    expect(
      include.startsWith(
        "${{ fromJSON(needs.changes.outputs.conformance-shards",
      ),
    ).toBe(true);
    expect(JSON.parse(literal)).toEqual(conformanceShards(classify([])));
  });

  it("reports every shard, with a limit on how long one may take", () => {
    expect(job?.strategy?.["fail-fast"]).toBe(false);
    expect(job?.["timeout-minutes"]).toBeLessThanOrEqual(30);
  });

  it("keeps each shard's server log under a name of its own, and stops what it started whatever happened", () => {
    const steps = job?.steps ?? [];
    const upload = steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact"),
    );
    expect(upload?.with?.name).toBe("marfa-server-log-${{ matrix.slug }}");
    expect(upload?.if).toBe("always()");
    expect(
      steps
        .filter((s) => /^pnpm (marfa|garage):down/.test(s.run ?? ""))
        .map((s) => s.if),
    ).toEqual(["always()", "always()"]);
    // The upload comes before the stop, which clears the state directory.
    expect(
      steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact")),
    ).toBeLessThan(
      steps.findIndex((s) => s.run?.startsWith("pnpm marfa:down")),
    );
  });

  it("downloads the logs the shards keep, by the name they are kept under", () => {
    const download = jobs["conformance-statuses"]?.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact"),
    );
    expect(download?.with?.pattern).toBe("marfa-server-log-*");
  });
});

describe("the files of each group, over its shards", () => {
  const filesOf = (project: string): string[] =>
    readdirSync(resolve(ROOT, "conformance/src/suites", project))
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => !name.endsWith(".decision.test.ts"))
      .map((name) => `src/suites/${project}/${name}`);

  it.each(CONFORMANCE_GROUPS.filter((group) => group.shards > 1))(
    "$job runs every file of its project in exactly one shard, and no shard is far from another",
    (group) => {
      const [project = ""] = group.projects;
      const files = filesOf(project);
      expect(files.length).toBeGreaterThan(group.shards);
      const shards = assignShards(files, group.shards);
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
