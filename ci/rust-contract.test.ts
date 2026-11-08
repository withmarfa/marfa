/**
 * The contract judged with the Rust server: a release build, shards that boot
 * it through the meter and run the server projects, and a score that fails
 * when a file the Rust server judges did not pass or a shard wrote no report.
 * `Full CI` waits for the score.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Entry {
  name: string;
  slug: string;
  args: string;
  binary: boolean;
  module: boolean;
}
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  strategy?: { "fail-fast"?: boolean; matrix?: { include?: Entry[] } };
  steps: Step[];
}

const ROOT = resolve(import.meta.dirname, "..");
const { jobs } = parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const build = jobs["rust-contract"];
const shards = jobs["rust-contract-shards"];
const score = jobs["rust-contract-score"];
const matrix = shards?.strategy?.matrix?.include ?? [];
const needsOf = (job: Job | undefined): string[] => [job?.needs ?? []].flat();
const step = (job: Job | undefined, name: string): Step => {
  const found = job?.steps.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
};

/** The projects a shard's arguments name, and the Vitest shard if it has one. */
function projectsOf(args: string): { projects: string[]; shard?: string } {
  return {
    projects: [...args.matchAll(/--project (\w+)/g)].map((m) => m[1] ?? ""),
    shard: /--shard=(\d+\/\d+)/.exec(args)?.[1],
  };
}

describe("the Rust server's release build", () => {
  it("is the release build of marfa-server on a standard Linux runner, locked, and is uploaded for the shards", () => {
    expect(build?.["runs-on"]).toBe("ubuntu-latest");
    expect(step(build, "Build the Rust server").run).toBe(
      "cargo build --locked --release -p marfa-server --features test-hooks",
    );
    const upload = step(build, "Keep the server");
    expect(upload.with?.path).toBe("core/target/release/marfa-server");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});

describe("the Rust contract shards", () => {
  it("wait for the build and run only when it passed", () => {
    expect(needsOf(shards)).toEqual(["changes", "rust-contract"]);
    expect(shards?.if).toBe(
      "${{ !cancelled() && needs.rust-contract.result == 'success' }}",
    );
    expect(shards?.["runs-on"]).toBe("ubuntu-latest");
    expect(shards?.strategy?.["fail-fast"]).toBe(false);
  });

  it("run each of the five server projects once, as the TypeScript shards do, and no other", () => {
    const whole = new Map<string, number>();
    const split = new Map<string, string[]>();
    for (const entry of matrix) {
      const { projects, shard } = projectsOf(entry.args);
      for (const project of projects) {
        if (shard === undefined) {
          whole.set(project, (whole.get(project) ?? 0) + 1);
        } else {
          split.set(project, [...(split.get(project) ?? []), shard]);
        }
      }
    }
    expect([...whole.keys()].sort()).toEqual(["cli", "correctness", "sync"]);
    for (const count of whole.values()) expect(count).toBe(1);
    // A split project has every shard of one count, once each.
    expect([...split.keys()].sort()).toEqual(["compliance", "device"]);
    for (const [project, listed] of split) {
      const count = Number(listed[0]?.split("/")[1]);
      expect(listed.slice().sort(), project).toEqual(
        Array.from(
          { length: count },
          (_, i) => `${String(i + 1)}/${String(count)}`,
        ).sort(),
      );
      expect(new Set(listed.map((s) => s.split("/")[1])).size, project).toBe(1);
    }
    expect(new Set(matrix.map((entry) => entry.slug)).size).toBe(matrix.length);
  });

  it("build the command-line binary for the fixtures that drive it, and the Node module for the device fixtures only", () => {
    for (const entry of matrix) {
      const { projects } = projectsOf(entry.args);
      expect(entry.binary, entry.name).toBe(
        projects.includes("cli") || projects.includes("device"),
      );
      expect(entry.module, entry.name).toBe(projects.includes("device"));
    }
  });

  it("boot the downloaded server through the meter and write a report whether or not a test failed", () => {
    expect(
      shards?.steps.some((s) =>
        s.uses?.startsWith("actions/download-artifact"),
      ),
    ).toBe(true);
    expect(step(shards, "Name the server under test").run).toContain(
      "MARFA_SERVER_BIN=",
    );
    expect(step(shards, "Boot the Rust server").run).toContain("pnpm marfa:up");
    const run = step(shards, "Run the shard").run ?? "";
    // The step fails for a missing report and for nothing Vitest says.
    expect(run).toContain("--reporter=json");
    // A retry would hide a flaky test: the reporters above replace the one
    // that records it.
    expect(run).toContain("--retry=0");
    expect(run).toContain("|| status=$?");
    expect(run).toContain('test -s "$report"');
    const keep = step(shards, "Keep the report");
    expect(keep.if).toBe("always()");
    expect(keep.with?.name).toBe("rust-contract-report-${{ matrix.slug }}");
    expect(keep.with?.["if-no-files-found"]).toBe("error");
    expect(step(shards, "Stop the server").if).toBe("always()");
  });

  it("start nothing that is for the TypeScript server", () => {
    const text = JSON.stringify(shards?.steps);
    expect(text).not.toContain("garage");
    expect(text).not.toContain("@withmarfa/server...");
    expect(text).not.toContain("MARFA_SERVER_BUILT");
  });
});

describe("the Rust contract score", () => {
  it("runs when the classifier owes a run, and fails when the build or a shard did not pass", () => {
    expect(needsOf(score)).toEqual([
      "changes",
      "rust-contract",
      "rust-contract-shards",
    ]);
    expect(score?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract != 'false') }}",
    );
    const first = score?.steps[0];
    expect(first?.run).toContain('[ "$BUILD" != success ]');
    expect(first?.run).toContain('[ "$SHARDS" != success ]');
  });

  it("scores the reports of every shard into the job summary", () => {
    const download = score?.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact"),
    );
    expect(download?.with?.pattern).toBe("rust-contract-report-*");
    const run = step(score, "Score the run").run ?? "";
    expect(run).toContain("pnpm rust:score");
    expect(run).toContain('--markdown "$GITHUB_STEP_SUMMARY"');
    const scripts = JSON.parse(
      readFileSync(resolve(ROOT, "conformance/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(scripts.scripts["rust:score"]).toBe("tsx scripts/rust-score.ts");
  });

  it("is waited for by Full CI and by the report of a failed night, with the jobs before it", () => {
    for (const waiter of ["gate", "report-failure"]) {
      for (const name of [
        "rust-contract",
        "rust-contract-shards",
        "rust-contract-score",
      ]) {
        expect(needsOf(jobs[waiter]), `${waiter} waits for ${name}`).toContain(
          name,
        );
      }
    }
  });
});
