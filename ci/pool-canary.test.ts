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
 * of them: the canary passes on a hosted runner, passes with its notifier
 * on the pool, and passes with a verdict that calls a cancellation
 * healthy.
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
  if?: string;
  needs?: unknown;
  steps?: { run?: unknown }[];
}

interface Workflow {
  on?: { schedule?: { cron?: string }[] };
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
}

const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
const probe = workflow.jobs?.probe;
const notify = workflow.jobs?.notify;

const notifyScript = (notify?.steps ?? [])
  .map((step) => (typeof step.run === "string" ? step.run : ""))
  .join("\n");

describe("the pool canary", () => {
  it("is reading the workflow it means to", () => {
    // The rest of this file asserts things about objects that would all be
    // `undefined` if the workflow were renamed or restructured, and
    // `undefined` satisfies most of the assertions below by accident.
    expect(probe).toBeDefined();
    expect(notify).toBeDefined();
    expect(notifyScript).toContain("ALERT_URL");
  });

  it("probes the pool by its literal label, never through CI_RUNNER", () => {
    // The property this whole workflow rests on. Routed through the
    // variable, it would run on whatever the estate's default happens to
    // be and report the pool healthy from a hosted runner.
    expect(probe?.["runs-on"]).toBe("self-hosted");
  });

  it("reports from a hosted runner, so the pool cannot silence its own alarm", () => {
    expect(notify?.["runs-on"]).toBe("ubuntu-latest");
  });

  it("reports whatever happened to the probe, including nothing", () => {
    // Without `always()` the notifier is skipped exactly when the probe
    // failed, which is every case worth reporting.
    expect(notify?.if ?? "").toContain("always()");
    expect(notify?.needs).toEqual(["probe"]);
  });

  it("sends nowhere when no destination is configured", () => {
    // A fork must contact nobody. The gate is on the variable rather than
    // the secret because `secrets` is not available in an `if:` at any
    // level and `vars` is.
    expect(notify?.if ?? "").toContain("vars.ALERT_WEBHOOK_URL != ''");
  });

  it("cancels a probe the pool never picked up", () => {
    // A job waiting for a self-hosted runner is not failed by GitHub until
    // its queue limit expires a day later. Cancelling on the next
    // scheduled run brings the report back to one hour, and it is the only
    // thing that does.
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

  it("calls only a successful probe healthy", () => {
    // The permissive direction, and the one a plausible edit reaches. A
    // `case` whose `cancelled` arm fell through to the catch-all would
    // resolve the alert on the run that detected the pool never picking a
    // job up — reporting the failure as the recovery.
    //
    // Asserted as "resolved is reached from exactly one place, and that
    // place is the success arm" rather than by matching each arm, because
    // the arms can be reordered and renamed while that property is what
    // makes the verdict correct.
    const resolvedArms = notifyScript.match(/STATE=resolved/g) ?? [];
    expect(resolvedArms).toHaveLength(1);
    const beforeResolved = notifyScript.slice(
      0,
      notifyScript.indexOf("STATE=resolved"),
    );
    expect(beforeResolved.slice(-200)).toContain("success)");
  });

  it("keys the alert on the condition rather than on the run", () => {
    // One alert opens when the pool goes down and the next healthy probe
    // resolves it. Keyed per run, every hourly failure would open its own
    // and nothing would ever close one.
    expect(notifyScript).toContain('--arg k "github/$REPO/$WORKFLOW"');
    // The key as the payload actually carries it, not merely the variable
    // that feeds it: composing anything per-run onto `$k` at the jq call
    // is the shape that would open an alert an hour and never close one.
    expect(notifyScript).toContain("key:$k,");
  });
});
