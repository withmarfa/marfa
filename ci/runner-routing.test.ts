/**
 * The two main database suites run on a managed runner after a merge and on
 * the local pool for a pull request, and that split is a property of the
 * workflow rather than of a repository variable.
 *
 * Both halves are deliberate and they answer different problems. Post-merge
 * validation is the long pole and nobody is waiting on it interactively, so
 * moving it off the shared machine buys back capacity for everything else.
 * A pull request is the opposite: it runs on every push to every branch, so
 * routing it to a metered runner would multiply managed traffic by review
 * volume for a check somebody is actually waiting on.
 *
 * ## Why this is a test rather than a comment
 *
 * The routing lives in an expression, and an expression that drops its
 * `github.event_name` clause still resolves — to the managed runner on
 * every event, which is the expensive direction and produces no error. It
 * would be found on a bill rather than in a run. The mirror is quieter
 * still: dropping the event-specific variable leaves every job on the pool,
 * which is exactly what the estate looked like last week, so nothing about
 * a green run would say the routing had been undone.
 *
 * **A green CI run cannot prove either.** The variables are repository
 * state, so the same file resolves differently depending on settings this
 * file cannot read; and a pull request only ever exercises the local half.
 *
 * ## What this does not check
 *
 * Whether each job caches correctly for the runner it lands on.
 * `cache-rule.test.ts` already holds every `cache:` value to its own job's
 * `runs-on` by template equality, and every standalone cache step to the
 * same rule through its `if:`. Restating it here would give the pair two
 * places to disagree about one question, which is the failure that file was
 * written to close.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ciWorkflow = join(repoRoot, ".github", "workflows", "ci.yml");

/**
 * The jobs routed by event, and the variable each reads on a push.
 *
 * An enumerated list rather than a scan, because the property is that
 * exactly these two are routed this way. A scan would pass over a third job
 * quietly acquiring the same shape, and acquiring it is the decision worth
 * noticing.
 */
const EVENT_ROUTED = [
  { jobId: "ci-sqlite", variable: "CI_SQLITE_RUNNER" },
  { jobId: "ci-pg", variable: "CI_POSTGRES_RUNNER" },
] as const;

/** The chain each routed job's `runs-on` must be, whitespace-normalized. */
function expectedChain(variable: string): string {
  return (
    `github.event_name == 'push' && vars.${variable} ` +
    `|| vars.CI_RUNNER || 'ubuntu-latest'`
  );
}

interface Job {
  "runs-on"?: unknown;
}
interface Workflow {
  jobs?: Record<string, Job>;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The body of a value that is entirely one `${{ … }}`, or null. */
function expressionBody(value: string): string | null {
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
  return whole ? normalize(whole[1] ?? "") : null;
}

const workflow = existsSync(ciWorkflow)
  ? (parse(readFileSync(ciWorkflow, "utf8")) as Workflow)
  : { jobs: {} };

describe("the main database suites are routed by event", () => {
  it("is reading the workflow and finding the jobs it names", () => {
    // A rule-checking test that silently matches nothing reports a
    // confident pass, and a renamed job is exactly how that happens.
    expect(existsSync(ciWorkflow), `${ciWorkflow} is missing`).toBe(true);
    for (const { jobId } of EVENT_ROUTED) {
      expect(
        Object.keys(workflow.jobs ?? {}),
        `job \`${jobId}\` is not in the workflow, so every assertion about ` +
          `it below would pass over nothing`,
      ).toContain(jobId);
    }
  });

  it("sends each one to its own variable on a push and nowhere else", () => {
    for (const { jobId, variable } of EVENT_ROUTED) {
      const runsOn = workflow.jobs?.[jobId]?.["runs-on"];
      expect(
        typeof runsOn,
        `job \`${jobId}\` resolves its runner in a shape this check does ` +
          `not model`,
      ).toBe("string");
      expect(
        expressionBody(runsOn as string),
        `job \`${jobId}\` must resolve its runner through the event, so ` +
          `that a merge and a pull request can land in different places.`,
      ).toBe(expectedChain(variable));
    }
  });

  it("leaves every other job on the ordinary runner", () => {
    // The other half of the split, and the one a bill would report before a
    // person did. A job that quietly picks up an event-specific variable is
    // managed traffic nobody decided to buy.
    const routed = new Set<string>(EVENT_ROUTED.map((entry) => entry.jobId));
    const strays: string[] = [];
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      if (routed.has(jobId)) continue;
      const runsOn = job["runs-on"];
      if (typeof runsOn !== "string") continue;
      if (runsOn.includes("github.event_name")) strays.push(jobId);
    }
    expect(
      strays,
      `these jobs route by event without being named above. Adding a third ` +
        `is a decision about managed spend, so it goes in the list rather ` +
        `than only in the workflow.`,
    ).toEqual([]);
  });
});
