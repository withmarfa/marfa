/**
 * The nightly benchmarks judge the Rust server: a release build without test
 * hooks, which both jobs download and boot through `MARFA_SERVER_BIN`. The
 * performance, load and hydration projects are in no other workflow, so what
 * this one boots is the only server that judges them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RUST_JUDGED } from "../conformance/src/utils/rust-judged.js";

interface Step {
  name?: string;
  "continue-on-error"?: boolean;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  steps: Step[];
}

const text = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/benchmarks.yml"),
  "utf8",
);
const { jobs } = parse(text) as { jobs: Record<string, Job> };
const step = (job: string, name: string): Step => {
  const found = jobs[job]?.steps.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${job} has no step ${name}`);
  return found;
};

describe("the nightly benchmarks", () => {
  it.each(["benchmarks", "scale"])(
    "boot the downloaded release server in the %s job, as a person runs it",
    (id) => {
      expect([jobs[id]?.needs ?? []].flat()).toContain("server");
      expect(jobs[id]?.env?.CONFORMANCE_SERVER_HOOK_FREE).toBe("true");
      expect(
        jobs[id]?.steps.some((s) =>
          s.uses?.startsWith("actions/download-artifact"),
        ),
      ).toBe(true);
      expect(step(id, "Name the server under test").run).toContain(
        "MARFA_SERVER_BIN=",
      );
      expect(step(id, "Boot the server").run).toContain("pnpm marfa:up");
    },
  );

  it("build the server without test hooks", () => {
    const build = step("server", "Build the Rust server");
    expect(build.run).toContain("release.sh");
    expect(build.run).toContain("--server");
    expect(JSON.stringify(jobs.server)).not.toContain("test-hooks");
  });

  it("measure memory beside an object store, in a step of the scale job after the other figures", () => {
    const names = jobs.scale?.steps.map((s) => s.name) ?? [];
    expect(names.indexOf("Memory with an object store")).toBeGreaterThan(
      names.indexOf("Folder watch"),
    );
    expect(
      step("scale", "Put an object store beside a second server").run,
    ).toContain("pnpm garage:up");
    expect(step("scale", "Stop the object store").run).toContain(
      "pnpm garage:down",
    );
  });

  it("fail the night, and open its issue, when a project that only they run fails", () => {
    for (const name of ["Performance", "Load", "Hydration"]) {
      const run = step("benchmarks", name);
      expect(run["continue-on-error"], name).toBeUndefined();
      expect(run.run, name).toMatch(/^pnpm test:(performance|load|hydration)$/);
    }
    const report = jobs["report-failure"];
    expect([report?.needs ?? []].flat()).toContain("benchmarks");
    expect(report?.if).toContain("failure()");
    expect(report?.if).toContain("schedule");
    // Their only verdict is the job's exit status, so none of their files may
    // sit in the list the gate's shards judge.
    expect(RUST_JUDGED.length).toBeGreaterThan(0);
    expect(
      RUST_JUDGED.filter((file) =>
        /^src\/suites\/(performance|load|hydration)\//.test(file),
      ),
    ).toEqual([]);
  });
});
