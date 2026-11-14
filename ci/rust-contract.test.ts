/**
 * The contract judged with the Rust server: a release build, shards that boot
 * it through the meter and run the server projects, and a score that fails
 * when a fixture file did not pass whole, no shard reported one, or a shard
 * wrote no report.
 * `Full CI` waits for the score. MCP conformance and the restore drill boot
 * the same build, and the nightly runs the device and CLI fixtures against a
 * build of its own on macOS, scored the same way.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  projectsOf as projectsOfShards,
  SHARDS,
  type Shard,
} from "../scripts/ci-required.js";

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
  "runs-on"?: string;
  env?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: unknown };
  steps: Step[];
}

const ROOT = resolve(import.meta.dirname, "..");
const { jobs } = parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const build = jobs["rust-contract"];
const shards = jobs["rust-contract-shards"];
const score = jobs["rust-contract-score"];
/** The shards the classifier hands the job, which `changes` filters by what a change can affect. */
const matrix: readonly Shard[] = SHARDS;
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
  it("runs for the contract, MCP conformance or the restore drill", () => {
    expect(build?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract-server != 'false' || needs.changes.outputs.rust-contract-device != 'false' || needs.changes.outputs.mcp-conformance != 'false' || needs.changes.outputs.restore-drill != 'false') }}",
    );
  });

  it("is the release build of marfa-server with the file readers linked in, on a standard Linux runner, and is uploaded for the shards", () => {
    expect(build?.["runs-on"]).toBe("ubuntu-latest");
    expect(build?.env?.TARGET).toBe("x86_64-unknown-linux-musl");
    const hooked = step(build, "Build the Rust server");
    expect(hooked.run).toBe(
      'core/marfa-enrichment/native/release.sh "$TARGET" --server',
    );
    expect(hooked.env?.MARFA_SERVER_FEATURES).toBe("test-hooks");
    const upload = step(build, "Keep the server");
    expect(upload.with?.path).toBe(
      "${{ runner.temp }}/marfa-servers/hooks/marfa-server",
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });

  it("builds the program a release ships a second time, without the test hooks, and uploads it for the shards", () => {
    const names = (build?.steps ?? []).map((candidate) => candidate.name);
    // After the hooked server is set aside: the second build replaces the output.
    expect(names.indexOf("Set the server aside")).toBeGreaterThan(-1);
    expect(
      names.indexOf("Build the Rust server without test hooks"),
    ).toBeGreaterThan(names.indexOf("Set the server aside"));
    const free = step(build, "Build the Rust server without test hooks");
    expect(free.run).toContain(
      'core/marfa-enrichment/native/release.sh "$TARGET" --server',
    );
    expect(free.env?.MARFA_SERVER_FEATURES).toBeUndefined();
    // Owed to the server's shards only, which the compliance fixture that
    // runs a release's program is in.
    expect(free.if).toContain("env.RELEASE_OWED == 'true'");
    expect(build?.env?.RELEASE_OWED).toBe(
      "${{ needs.changes.result != 'success' || needs.changes.outputs.rust-contract-server != 'false' }}",
    );
    const upload = step(build, "Keep the server without test hooks");
    expect(upload.if).toBe("${{ env.RELEASE_OWED == 'true' }}");
    expect(upload.with?.name).toBe("rust-contract-release-server");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(
      shards?.steps.some(
        (candidate) =>
          candidate.uses?.startsWith("actions/download-artifact") &&
          candidate.with?.name === "rust-contract-release-server",
      ),
    ).toBe(true);
    expect(step(shards, "Name the server a release ships").run).toContain(
      "MARFA_SERVER_RELEASE_BIN=",
    );
  });
});

describe("the Rust contract shards", () => {
  it("wait for the build and run only when it passed", () => {
    expect(needsOf(shards)).toEqual(["changes", "rust-contract"]);
    // The matrix is the classifier's, so the job cannot read it when the
    // classifier did not run: `Full CI` fails for that on its own.
    expect(shards?.if).toBe(
      "${{ !cancelled() && needs.rust-contract.result == 'success' && needs.changes.result == 'success' && (needs.changes.outputs.rust-contract-server != 'false' || needs.changes.outputs.rust-contract-device != 'false') }}",
    );
    expect(shards?.strategy?.matrix).toBe(
      "${{ fromJSON(needs.changes.outputs.rust-shards) }}",
    );
    expect(shards?.["runs-on"]).toBe("ubuntu-latest");
    expect(shards?.strategy?.["fail-fast"]).toBe(false);
  });

  it("run each of the five server projects once, and no other", () => {
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
    // The witness: the matrix is the classifier's whole list, and a project
    // is in it or it is not judged.
    expect(matrix.length).toBeGreaterThan(0);
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

  it("belong to one group each, and a group is the shards of the projects its fixtures need", () => {
    const lanes = (lane: Shard["lane"]) =>
      projectsOfShards(matrix.filter((entry) => entry.lane === lane));
    expect(lanes("rust-contract-server")).toEqual([
      "correctness",
      "sync",
      "compliance",
    ]);
    expect(lanes("rust-contract-device")).toEqual(["cli", "device"]);
    // Only the compliance fixture that runs a release's program needs it, so
    // the group that holds it downloads the build without test hooks.
    for (const entry of matrix) {
      expect(entry.release, entry.name).toBe(
        entry.lane === "rust-contract-server",
      );
    }
    expect(
      matrix
        .filter((entry) => entry.args.includes("--project compliance"))
        .every((entry) => entry.release),
    ).toBe(true);
    expect(
      readFileSync(
        resolve(
          ROOT,
          "conformance/src/suites/compliance/hook-free-server.test.ts",
        ),
        "utf8",
      ),
    ).toContain("MARFA_SERVER_RELEASE_BIN");
    // The two steps that fetch and name it are the ones that wait on it.
    expect(
      shards?.steps.filter(
        (candidate) => candidate.if === "${{ matrix.release }}",
      ).length,
    ).toBe(2);
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

  it("hold every status the server answered to its declaration, before the stop clears the log, on the shards whose server draws none undeclared", () => {
    const names = shards?.steps.map((s) => s.name) ?? [];
    const held = names.indexOf("Hold every status observed to its declaration");
    expect(held).toBeGreaterThan(names.indexOf("Run the shard"));
    expect(held).toBeLessThan(names.indexOf("Stop the server"));
    const check = step(shards, "Hold every status observed to its declaration");
    expect(check.run).toBe('pnpm check:statuses --state "$RUNNER_TEMP/marfa"');
    expect(check.if).toBe("${{ !cancelled() && matrix.statuses }}");
    expect(
      matrix.filter((entry) => entry.statuses).map((entry) => entry.slug),
    ).toEqual(["correctness-sync", "cli"]);
  });

  it("put an object store beside the server for the stores chapter, and always stop it", () => {
    const names = shards?.steps.map((s) => s.name) ?? [];
    const store = names.indexOf("Put an object store beside the server");
    expect(store).toBeGreaterThanOrEqual(0);
    expect(store).toBeLessThan(names.indexOf("Boot the Rust server"));
    expect(step(shards, "Put an object store beside the server").run).toContain(
      "pnpm garage:up",
    );
    const stop = step(shards, "Stop the object store");
    expect(stop.if).toBe("always()");
    expect(stop.run).toContain("pnpm garage:down");
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
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract-server != 'false' || needs.changes.outputs.rust-contract-device != 'false') }}",
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
    // Only the projects of the shards that ran are judged, from the list
    // that made the matrix.
    expect(run).toContain('--projects "$PROJECTS"');
    expect(step(score, "Score the run").env?.PROJECTS).toBe(
      "${{ needs.changes.outputs.rust-projects }}",
    );
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

describe("MCP conformance and the restore drill", () => {
  it.each(["mcp-conformance", "restore-drill"])(
    "%s boots the Rust server's release build",
    (name) => {
      const job = jobs[name];
      expect(needsOf(job)).toEqual(["changes", "rust-contract"]);
      expect(job?.if).toContain("needs.rust-contract.result == 'success'");
      expect(job?.if).toContain(`needs.changes.outputs.${name} != 'false'`);
      expect(
        job?.steps.some(
          (candidate) =>
            candidate.uses?.startsWith("actions/download-artifact") &&
            candidate.with?.name === "rust-contract-server",
        ),
      ).toBe(true);
      expect(step(job, "Name the server under test").run).toContain(
        "MARFA_SERVER_BIN=",
      );
      const text = JSON.stringify(job?.steps);
      expect(text).not.toContain("litestream");
    },
  );
});

describe("the Rust contract on macOS", () => {
  const mac = jobs["rust-contract-macos"];
  const macShards = jobs["rust-contract-macos-shards"];
  const macScore = jobs["rust-contract-macos-score"];
  const entries = ((
    macShards?.strategy?.matrix as { include?: unknown[] } | undefined
  )?.include ?? []) as { args: string; slug: string }[];
  const gate =
    "(github.event_name == 'schedule' || inputs.macos) && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract-macos != 'false')";

  it("runs only on the nightly and a dispatch that asks for macOS", () => {
    expect(mac?.["runs-on"]).toBe("macos-26");
    expect(macShards?.["runs-on"]).toBe("macos-26");
    expect(mac?.if).toBe(`\${{ !cancelled() && ${gate} }}`);
    expect(needsOf(macShards)).toEqual(["changes", "rust-contract-macos"]);
    expect(macShards?.if).toBe(
      "${{ !cancelled() && needs.rust-contract-macos.result == 'success' }}",
    );
    expect(macScore?.if).toBe(`\${{ !cancelled() && ${gate} }}`);
  });

  it("runs the CLI fixtures whole and every shard of the device fixtures once", () => {
    const whole: string[] = [];
    const device: string[] = [];
    for (const entry of entries) {
      const { projects, shard } = projectsOf(entry.args);
      expect(projects).toHaveLength(1);
      if (shard === undefined) whole.push(...projects);
      else if (projects[0] === "device") device.push(shard);
    }
    expect(whole).toEqual(["cli"]);
    const count = Number(device[0]?.split("/")[1]);
    expect(device.sort()).toEqual(
      Array.from(
        { length: count },
        (_, i) => `${String(i + 1)}/${String(count)}`,
      ),
    );
    expect(new Set(entries.map((entry) => entry.slug)).size).toBe(
      entries.length,
    );
  });

  it("builds the server with its test hooks, the device and the Node module once, and every shard downloads them", () => {
    const built = step(
      mac,
      "Build the server, the device and the Node module under test",
    ).run;
    expect(built).toContain(
      "cargo build --locked --release -p marfa-server --features test-hooks",
    );
    expect(built).toContain("cargo build --locked -p marfa-cli");
    expect(built).toContain("run build:debug");
    const kept = step(mac, "Keep what is under test");
    expect(kept.with?.name).toBe("rust-contract-macos-build");
    expect(kept.with?.["if-no-files-found"]).toBe("error");
    for (const path of [
      "core/target/release/marfa-server",
      "core/target/debug/marfa",
      "core/bindings/node/*.node",
    ]) {
      expect(kept.with?.path).toContain(path);
    }
    const download = macShards?.steps.find(
      (s) =>
        s.uses?.startsWith("actions/download-artifact") &&
        s.with?.name === "rust-contract-macos-build",
    );
    expect(download?.with?.path).toBe("core");
    expect(JSON.stringify(macShards?.steps)).not.toContain("cargo build");
  });

  it("leaves the login keychain as it was, fails on a failed test and keeps the report whatever the verdict", () => {
    const run = step(macShards, "Run the shard").run ?? "";
    expect(run).toContain("../core/scripts/login-keychain-unchanged.sh");
    expect(run).toContain("--retry=0");
    expect(run).toContain("--reporter=json");
    expect(run).not.toContain("|| status");
    const keep = step(macShards, "Keep the report");
    expect(keep.if).toBe("always()");
    expect(keep.with?.name).toBe(
      "rust-contract-macos-report-${{ matrix.slug }}",
    );
    expect(step(macShards, "Stop the server").if).toBe("always()");
    expect(step(macShards, "Stop the object store").if).toBe("always()");
  });

  it("scores the CLI and device projects as macOS, so a skip there fails unless the machine cannot show the test", () => {
    expect(needsOf(macScore)).toEqual([
      "changes",
      "rust-contract-macos",
      "rust-contract-macos-shards",
    ]);
    expect(macScore?.["runs-on"]).toBe("ubuntu-latest");
    const download = macScore?.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact"),
    );
    expect(download?.with?.pattern).toBe("rust-contract-macos-report-*");
    const run = step(macScore, "Score the run").run ?? "";
    expect(run).toContain("pnpm rust:score");
    expect(run).toContain("--platform darwin");
    expect(run).toContain("--projects cli,device");
    expect(macScore?.steps[0]?.run).toContain('[ "$BUILD" != success ]');
  });

  it("is waited for by Full CI and by the report of a failed night", () => {
    for (const waiter of ["gate", "report-failure"]) {
      for (const name of [
        "rust-contract-macos",
        "rust-contract-macos-shards",
        "rust-contract-macos-score",
      ]) {
        expect(needsOf(jobs[waiter]), `${waiter} waits for ${name}`).toContain(
          name,
        );
      }
    }
  });
});
