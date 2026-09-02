/**
 * The pool canary answers a question about the self-hosted pool, and every
 * property below is one that can be undone without producing an error.
 *
 * ## Why this is a test rather than a comment
 *
 * The workflow's whole value is that it fails when the pool is broken.
 * Every way of breaking it leaves a green, quiet workflow — which is
 * indistinguishable from the healthy state it is supposed to certify, and
 * is the exact failure it was written to close. A CI run cannot catch any
 * of them: the canary passes on a hosted runner, and passes when its
 * cancellation stops being visible.
 *
 * The routing one is the sharpest. Every other job in this repository
 * reads `vars.CI_RUNNER` so work can be moved between the pool and a
 * managed runner, and somebody tidying towards that convention would move
 * this one too. It would keep reporting green from a hosted runner, having
 * stopped testing the pool at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(repoRoot, ".github", "workflows", "pool-canary.yml");

interface Job {
  "runs-on"?: unknown;
  steps?: { run?: unknown }[];
}

interface Workflow {
  on?: { schedule?: { cron?: string }[] };
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
}

const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
const probe = workflow.jobs?.probe;

describe("the pool canary", () => {
  it("is reading the workflow it means to", () => {
    // The rest of this file asserts things about objects that would all be
    // `undefined` if the workflow were renamed or restructured, and
    // `undefined` satisfies most of the assertions below by accident.
    expect(probe).toBeDefined();
    expect(probe?.steps ?? []).not.toHaveLength(0);
  });

  it("probes the pool by its literal label, never through CI_RUNNER", () => {
    // The property this whole workflow rests on. Routed through the
    // variable, it would run on whatever the estate's default happens to
    // be and report the pool healthy from a hosted runner.
    expect(probe?.["runs-on"]).toBe("self-hosted");
  });

  it("cancels a probe the pool never picked up", () => {
    // A job waiting for a self-hosted runner is not failed by GitHub until
    // its queue limit expires a day later. Cancelling on the next
    // scheduled run gives it a conclusion within the hour, and it is the
    // only thing that does.
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(workflow.concurrency?.group).toBe("pool-canary");
  });

  it("runs often enough to be worth having", () => {
    // Not a style rule. The outage this exists for lasted nineteen hours,
    // and a daily probe would have bounded it at roughly the same number.
    const crons = workflow.on?.schedule ?? [];
    expect(crons).toHaveLength(1);
    expect(crons[0]?.cron).toMatch(/^\d+ \* \* \* \*$/);
  });
});
