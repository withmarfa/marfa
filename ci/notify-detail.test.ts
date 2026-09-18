/**
 * A surviving `notify` job states what its guard found, and every property
 * that makes that work is one whose absence produces a green run.
 *
 * ## The failure this is written against
 *
 * Two scheduled guards report to an alert destination, and nobody watches
 * their runs — a 07:17 and a 07:42 cron. Until recently both sent only
 * `join(needs.*.result, ',')`, so the alert for a genuine drift said
 * `failure` and sent whoever read it back to the log to find out what had
 * actually happened. The checking job knew which integration, which commit
 * and which paths, logged all of it, and told the notifier none of it.
 *
 * The fix is that each checking job publishes its finding as job outputs.
 * Three things have to hold for that to survive the only run that matters,
 * which is a failing one, and **none of them produces an error when undone**:
 *
 *   - The step that writes `$GITHUB_OUTPUT` runs on `if: always()`. Without
 *     it the step is skipped exactly when a previous step failed, so every
 *     alert worth sending arrives with no detail.
 *   - The job's `outputs:` name that step, and the notifier reads them. A
 *     notifier still reading only `needs.*.result` is the state this
 *     replaced, and it looks identical from the outside.
 *   - **An absent verdict never resolves an alert.** This is the subtle one.
 *     A `run:` block runs under `bash -e`, so any command exiting non-zero
 *     kills its step where it stands — a failed install, a failed `gh api` —
 *     and nothing after it in that step records anything. If silence meant
 *     "the guard passed", every such death would post a `resolved` and close
 *     an alert about a condition nobody re-tested. So each branch that
 *     establishes something writes `current` itself, and `STATE=resolved` is
 *     reachable only from that explicit verdict.
 *
 * ## What this does not check
 *
 * That no unguarded failing command sits between a finding being recorded
 * and the exit that follows it. Whether an arbitrary command can fail is not
 * a question the workflow text answers, so it is not assertable here. The
 * third property above is what makes it not matter: a step dying anywhere,
 * for any reason, leaves no verdict, and no verdict resolves nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The scheduled guards that report a finding, and the job each notifier
 * reads it from.
 *
 * Enumerated rather than scanned for a `notify` job, because the property is
 * that exactly these two carry one. A scan would pass over a notifier
 * quietly reverting to `needs.*.result`, and it would also pass over one
 * being added to a workflow that should not have gained it.
 */
const GUARDS = [{ file: "openapi-drift.yml", checkJob: "drift" }] as const;

interface Step {
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: unknown;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  jobs?: Record<string, Job>;
}

function load(file: string): Workflow {
  const path = join(repoRoot, ".github", "workflows", file);
  return parse(readFileSync(path, "utf8")) as Workflow;
}

/** Every `TITLE="…"` assigned in a script, in source order. */
function titles(script: string): string[] {
  return [...script.matchAll(/TITLE="([^"]*)"/g)].map((m) => m[1] ?? "");
}

describe.each(GUARDS)("$file", ({ file, checkJob }) => {
  const workflow = load(file);
  const check = workflow.jobs?.[checkJob];
  const notify = workflow.jobs?.notify;
  const notifyScript = (notify?.steps ?? [])
    .map((step) => step.run ?? "")
    .join("\n");
  const notifyEnv = Object.values(notify?.steps?.[0]?.env ?? {}).join("\n");

  it("is reading the workflow it means to", () => {
    // Everything below asserts against objects that would be `undefined` if
    // the workflow were renamed or restructured, and `undefined` satisfies
    // several of these by accident.
    expect(check).toBeDefined();
    expect(notify).toBeDefined();
    expect(notifyScript).toContain("ALERT_URL");
  });

  it("publishes the finding from a step that runs even when the job failed", () => {
    const outputs = check?.outputs ?? {};
    expect(Object.keys(outputs).sort()).toEqual([
      "detail",
      "fields",
      "verdict",
    ]);

    // Every output must come from one step, and that step must be the one
    // carrying `if: always()`. Resolved from the expression rather than by
    // name, so renaming the step cannot quietly split the two apart.
    const ids = new Set(
      Object.values(outputs).map(
        (expression) => /steps\.([\w-]+)\.outputs/.exec(expression)?.[1] ?? "",
      ),
    );
    expect(ids.size).toBe(1);
    const emitterId = [...ids][0] ?? "";
    expect(emitterId).toBeTruthy();

    const emitter = (check?.steps ?? []).find((step) => step.id === emitterId);
    expect(emitter, `no step with id ${emitterId}`).toBeDefined();
    expect(emitter?.if).toBe("always()");
    expect(emitter?.run ?? "").toContain("GITHUB_OUTPUT");

    // The default verdict, which is the whole of the property above. Flip
    // this one word to `current` and every prematurely-dead step resolves
    // the open alert instead of reporting inconclusive — with no error
    // anywhere, and with the rest of this file still green.
    expect(emitter?.run ?? "").toMatch(/or "inconclusive"/);
    expect(emitter?.run ?? "").not.toMatch(/or "current"/);
  });

  it("reads the finding rather than the job's result", () => {
    expect(notify?.needs).toEqual([checkJob]);
    // A job result cannot distinguish drift from a guard that never ran, so
    // the notifier reading only `needs.*.result` is the state this replaced.
    expect(notifyEnv).toContain(`needs.${checkJob}.outputs.verdict`);
    expect(notifyEnv).toContain(`needs.${checkJob}.outputs.detail`);
    expect(notifyEnv).toContain(`needs.${checkJob}.outputs.fields`);
  });

  it("never resolves an alert on an absent verdict", () => {
    // The property that makes `bash -e` killing a step mid-way harmless.
    // Asserted as "resolved is reached from exactly one place, and that
    // place is the explicit `current` arm" rather than by matching each
    // arm, because the arms can be reordered and renamed while that
    // property is what makes the verdict correct.
    const resolvedArms = notifyScript.match(/STATE=resolved/g) ?? [];
    expect(resolvedArms).toHaveLength(1);
    const beforeResolved = notifyScript.slice(
      0,
      notifyScript.indexOf("STATE=resolved"),
    );
    expect(beforeResolved.slice(-120)).toContain("current)");
  });

  it("gives an open and its resolve the same subject", () => {
    // So the pair reads as one thing changing state rather than as two
    // unrelated messages. The subject is everything before the colon.
    const subject = (title: string) => title.split(":")[0];
    const resolved = titles(notifyScript).find((t) => t.endsWith(": current"));
    const open = titles(notifyScript).find((t) => t.includes("$DETAIL"));
    expect(resolved).toBeDefined();
    expect(open).toBeDefined();
    expect(subject(open ?? "")).toBe(subject(resolved ?? ""));
  });

  it("calls a guard that reached no verdict inconclusive, never skipped", () => {
    // "Skipped" implies a decision, and makes a guard that silently stopped
    // running read as routine. The subject changes too, deliberately: it
    // becomes the check rather than the thing checked, because nothing in
    // that message is a statement about the thing checked.
    const third = titles(notifyScript).find((t) => t.includes("inconclusive"));
    expect(third, "no inconclusive title").toBeDefined();
    expect(third).toMatch(/ check: inconclusive$/);
    expect(notifyScript).not.toMatch(/TITLE="[^"]*skipped[^"]*"/);
  });

  it("sends nowhere when no destination is configured", () => {
    // A fork must contact nobody. The gate is on the variable rather than
    // the secret because `secrets` is not available in an `if:` at any
    // level and `vars` is, so a job cannot ask whether a secret exists.
    expect(notify?.if ?? "").toContain("vars.ALERT_WEBHOOK_URL != ''");
    // And an unset token omits the header rather than sending "Bearer "
    // with nothing after it.
    expect(notifyScript).toContain('if [ -n "${ALERT_TOKEN:-}" ]; then');
  });

  it("keys the alert on the condition rather than on the run", () => {
    // One alert opens when the condition appears and the next clean run
    // resolves it. Keyed per run, every daily failure would open its own
    // and nothing would ever close one.
    expect(notifyScript).toContain('--arg k "github/$REPO/$WORKFLOW"');
    // The key as the payload actually carries it, not merely the variable
    // that feeds it: composing anything per-run onto `$k` at the jq call
    // is the shape that would open an alert a day and never close one.
    expect(notifyScript).toContain("key:$k,");
  });

  it("puts links in fields and keeps them out of titles", () => {
    for (const title of titles(notifyScript)) {
      expect(title, `link syntax in title: ${title}`).not.toMatch(/\]\(/);
    }
    expect(notifyScript).toContain('--arg r "[$REPO]($REPO_URL)"');
  });
});
