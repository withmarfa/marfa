/**
 * `Full CI` cannot pass over a failing run of the core's live checks. The
 * job that builds the Node module, runs the live tests and proves the Node
 * binding is the `core` job of `ci.yml`, which calls `core-live.yml` for a
 * pull request that reaches what that workflow reads, and `Full CI` waits for
 * it. A workflow of its own on `pull_request` would run beside the gate
 * instead of under it, and a merge waits only on required checks.
 * `core.yml` runs the same workflow for a push to `main`, the nightly and a
 * dispatch. The private control socket's macOS tests are a job of `ci.yml`
 * for the same reason. `ci/full-ci-gate.test.ts` pins the gate itself.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(import.meta.dirname, "..", ".github", "workflows");
const CALLED = "./.github/workflows/core-live.yml";

interface Step {
  name?: string;
  if?: string;
  run?: string;
}
interface Job {
  name?: string;
  uses?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: string | string[] | Record<string, unknown>;
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
 * `Pull request description` is required by its own name. CodeQL analyzes
 * the tree and runs no tests, and its check is not required. Any other
 * workflow that runs the project's tests on a pull request needs to be a job
 * of `ci.yml` instead, since a merge waits only on required checks.
 */
const ON_PULL_REQUEST = ["ci.yml", "codeql.yml", "pr-description.yml"];

/** Both run a workflow for a pull request. */
const PULL_REQUEST_EVENTS = ["pull_request", "pull_request_target"];

/** The events of a workflow, which `on` names as a string, a list or a map. */
const eventsOf = (on: Workflow["on"]): string[] =>
  typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);

const startsOnPullRequest = (all: Record<string, Workflow>): string[] =>
  Object.entries(all)
    .filter(([, { on }]) =>
      eventsOf(on).some((event) => PULL_REQUEST_EVENTS.includes(event)),
    )
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
    // And one that names its events as a string, a list or a map, with
    // either event that runs a workflow for a pull request.
    for (const on of [
      "pull_request",
      "pull_request_target",
      ["push", "pull_request"],
      ["push", "pull_request_target"],
      { pull_request_target: null },
    ]) {
      expect(
        startsOnPullRequest({
          ...all,
          "core.yml": { ...all["core.yml"]!, on },
        }),
        JSON.stringify(on),
      ).toContain("core.yml");
    }
    expect(
      startsOnPullRequest({
        ...all,
        "core.yml": { ...all["core.yml"]!, on: ["push", "schedule"] },
      }),
    ).not.toContain("core.yml");
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
    // No group: only a pull request's run is ever cancelled, and none starts
    // this workflow.
    expect(concurrency).toBeUndefined();
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

describe("the control socket's tests under Full CI", () => {
  const TESTS =
    "packages/server/src/control/socket.test.ts packages/server/src/control/socket-race.test.ts";

  it("run on macOS as a job of ci.yml, only when the classifier says so, and not as a workflow of their own", () => {
    expect(existsSync(resolve(WORKFLOWS, "control-socket.yml"))).toBe(false);
    const { jobs } = workflow("ci.yml");
    const job = jobs["control-socket"];
    expect(job?.name).toBe("Control socket (macOS)");
    expect(job?.needs).toBe("changes");
    expect(job?.if).toBe(
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.control-socket != 'false') }}",
    );
    expect(job?.["runs-on"]).toBe("macos-26");
    expect(job?.steps?.at(-1)?.run).toBe(`pnpm exec vitest run ${TESTS}`);
    expect(jobs.changes?.outputs?.["control-socket"]).toBe(
      "${{ steps.classify.outputs.control-socket }}",
    );
  });

  it("are waited for by Full CI and by the report of a failed night", () => {
    const { jobs } = workflow("ci.yml");
    expect(needsOf(jobs.gate)).toContain("control-socket");
    expect(needsOf(jobs["report-failure"])).toContain("control-socket");
  });

  it("run on Linux in CI (SQLite) tests, where the tool they read is installed first and nothing leaves them out", () => {
    const steps = workflow("ci.yml").jobs["ci-sqlite-tests"]?.steps ?? [];
    const install = steps.findIndex((step) =>
      step.run?.includes("apt-get install -y acl"),
    );
    const test = steps.findIndex((step) => step.run?.includes("pnpm test"));
    expect(install).toBeGreaterThan(-1);
    expect(steps[install]?.if).toBe("runner.os == 'Linux'");
    expect(test).toBeGreaterThan(install);
    expect(steps[test]?.run).not.toMatch(/control|socket/);
    for (const file of TESTS.split(" ")) {
      expect(existsSync(resolve(import.meta.dirname, "..", file)), file).toBe(
        true,
      );
    }
    const serverConfig = readFileSync(
      resolve(import.meta.dirname, "..", "packages/server/vitest.config.ts"),
      "utf8",
    );
    expect(serverConfig).not.toMatch(/\b(include|exclude)\s*:/);
  });
});
