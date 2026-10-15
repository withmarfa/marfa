/**
 * `Full CI` cannot pass over a failing run of the core's live checks. The
 * job that builds the Node module, runs the live tests and proves the Node
 * binding is the `core` job of `ci.yml`, which calls `core-live.yml` for a
 * pull request that reaches what that workflow reads, and `Full CI` waits for
 * it. A workflow of its own on `pull_request` would run beside the gate
 * instead of under it, and a merge waits only on required checks.
 * `core.yml` runs the same workflow for a push to `main`, the nightly and a
 * dispatch. `ci/full-ci-gate.test.ts` pins the gate itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(import.meta.dirname, "..", ".github", "workflows");
const CALLED = "./.github/workflows/core-live.yml";

interface Job {
  name?: string;
  uses?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  steps?: unknown[];
}
interface Workflow {
  on: Record<string, unknown>;
  concurrency?: unknown;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const read = (file: string): string =>
  readFileSync(resolve(WORKFLOWS, file), "utf8");
const workflow = (file: string): Workflow => parse(read(file)) as Workflow;
const needsOf = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));

/**
 * The workflows that start on a pull request. `ci.yml` is the gate, and
 * `Pull request description` is required by its own name. CodeQL and the
 * control socket's check are not required checks, so a merge does not wait
 * for them, though the control socket's check runs tests. Any other workflow
 * that runs the project's tests needs to be a job of `ci.yml` instead.
 */
const ON_PULL_REQUEST = [
  "ci.yml",
  "codeql.yml",
  "control-socket.yml",
  "pr-description.yml",
];

const startsOnPullRequest = (all: Record<string, Workflow>): string[] =>
  Object.entries(all)
    .filter(([, { on }]) => "pull_request" in on)
    .map(([file]) => file)
    .sort();

describe("the core's live checks under Full CI", () => {
  const all = Object.fromEntries(files.map((file) => [file, workflow(file)]));

  it("start on a pull request only as a job of ci.yml, so that no other workflow runs them beside the gate", () => {
    expect(startsOnPullRequest(all)).toEqual(ON_PULL_REQUEST);
    // The witness: a workflow that starts on its own pull request is found.
    expect(
      startsOnPullRequest({
        ...all,
        "core.yml": { ...all["core.yml"]!, on: { pull_request: null } },
      }),
    ).toContain("core.yml");
  });

  it("are the core job of ci.yml, which calls the workflow and nothing else of it", () => {
    const { jobs } = workflow("ci.yml");
    expect(jobs.core).toEqual({
      name: "Core",
      needs: "changes",
      if: "${{ !cancelled() && github.event_name == 'pull_request' && (needs.changes.result != 'success' || needs.changes.outputs.core != 'false') }}",
      uses: CALLED,
    });
    expect(jobs.changes?.outputs?.core).toBe(
      "${{ steps.classify.outputs.core }}",
    );
  });

  it("are waited for by Full CI and by the report of a failed night", () => {
    const { jobs } = workflow("ci.yml");
    expect(needsOf(jobs.gate)).toContain("core");
    expect(needsOf(jobs["report-failure"])).toContain("core");
  });

  it("run for a push to main, the nightly and a dispatch from core.yml, which calls the same workflow", () => {
    const { on, jobs, concurrency } = workflow("core.yml");
    expect(Object.keys(on).sort()).toEqual([
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
    expect(jobs.core).toEqual({ name: "Core", uses: CALLED });
    expect(Object.keys(jobs)).toEqual(["core", "report-failure"]);
    expect(needsOf(jobs["report-failure"])).toEqual(["core"]);
    // A group of its own per run, since a push, a schedule and a dispatch
    // are never cancelled for one another.
    expect(concurrency).toBeDefined();
  });

  it("are one workflow that only another can call, with nothing a caller's run could collide with", () => {
    const text = read("core-live.yml");
    const { on, jobs, concurrency, permissions } = workflow("core-live.yml");
    // A called workflow's `github.workflow` is the caller's, so a group
    // here would be the caller's own and cancel the run that called it.
    expect(on).toEqual({ workflow_call: null });
    expect(concurrency).toBeUndefined();
    expect(permissions).toEqual({ contents: "read" });
    expect(Object.keys(jobs)).toEqual(["live"]);
    expect(jobs.live?.name).toBe("Rust, bindings, live");
    expect(jobs.live?.["runs-on"]).toBe("macos-26");
    expect(jobs.live?.permissions).toBeUndefined();
    // Nothing is passed to it, so nothing needs to be.
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
  });
});
