/**
 * The two suite jobs must not run at the same time as each other, on any ref.
 *
 * Each of them runs vitest's `forks` pool at its default `cpus - 1`, so one
 * job is thirteen child processes on the fourteen-core machine that hosts the
 * self-hosted pool. The pool has four runners. Nothing in the workflow bounded
 * how many of these could start at once, and four of them is fifty-two forked
 * test processes plus up to four Postgres clusters, because `test-pg.sh` boots
 * a container per run rather than sharing one.
 *
 * ## Why this is a test rather than a comment
 *
 * **The regression this guards is silent in exactly the way the bug was.**
 * Add `${{ github.ref }}` to the group — the obvious move for anyone who finds
 * the queue slow — and the expression still resolves, every job still runs,
 * every run is still green on a quiet machine, and the serialization is gone.
 * It comes back as timeouts in files the branch never touched, on somebody
 * else's pull request, weeks later. That is how it arrived the first time: two
 * sessions on two branches each read it as a defect in their own diff before
 * either looked at the machine.
 *
 * The same is true of the queue mode. Dropping `queue: max` leaves a valid
 * workflow that keeps one pending entry per group and cancels it when the next
 * arrives, so a required check disappears instead of failing. A cancelled
 * required check blocks a merge with nothing to read, which is worse than the
 * false red this whole arrangement exists to stop.
 *
 * **A green run cannot see any of this.** Serialization only matters when two
 * runs overlap, and the check that would notice is the one that cannot run
 * where the regression bites.
 *
 * ## What it cannot see
 *
 * That the group actually holds. It asserts the workflow says the right thing,
 * not that GitHub does the right thing with it — that was established once, by
 * starting two runs on two refs and watching the second queue rather than fail.
 * It also cannot reach other repositories: a concurrency group is scoped to one
 * repository, so this bounds `withmarfa/marfa` against itself and nothing else
 * sharing the pool.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ciWorkflow = join(repoRoot, ".github", "workflows", "ci.yml");

/**
 * The jobs that run the whole suite, and so must take the machine one at a
 * time.
 *
 * Enumerated rather than scanned, for the same reason `runner-routing.test.ts`
 * enumerates: the property is that exactly these two are the heavy ones. A
 * third job quietly acquiring a suite run is the decision worth noticing, and
 * a scan would pass over it.
 */
const SUITE_JOBS = ["ci-sqlite", "ci-pg"] as const;

/** The one group name they share. Fixed, so that it cannot vary by ref. */
const SHARED_GROUP = "marfa-suite-shared-host";

interface Concurrency {
  group?: unknown;
  "cancel-in-progress"?: unknown;
  queue?: unknown;
}
interface Job {
  concurrency?: unknown;
}
interface Workflow {
  concurrency?: unknown;
  jobs?: Record<string, Job>;
}

const workflow = existsSync(ciWorkflow)
  ? (parse(readFileSync(ciWorkflow, "utf8")) as Workflow)
  : { jobs: {} };

function jobConcurrency(jobId: string): Concurrency {
  const raw = workflow.jobs?.[jobId]?.concurrency;
  expect(
    raw,
    `job \`${jobId}\` declares no job-level \`concurrency\`, so it can run ` +
      `beside the other suite job on the same machine`,
  ).toBeDefined();
  expect(
    typeof raw,
    `job \`${jobId}\` declares \`concurrency\` in a shape this check does ` +
      `not model — a bare string cannot carry \`queue\``,
  ).toBe("object");
  return raw as Concurrency;
}

describe("the suite jobs take the machine one at a time", () => {
  it("is reading the workflow and finding the jobs it names", () => {
    // A rule-checking test that silently matches nothing reports a confident
    // pass, and a renamed job is exactly how that happens.
    expect(existsSync(ciWorkflow), `${ciWorkflow} is missing`).toBe(true);
    for (const jobId of SUITE_JOBS) {
      expect(
        Object.keys(workflow.jobs ?? {}),
        `job \`${jobId}\` is not in the workflow, so every assertion about ` +
          `it below would pass over nothing`,
      ).toContain(jobId);
    }
  });

  it("puts both of them in one group, named for the machine", () => {
    for (const jobId of SUITE_JOBS) {
      expect(
        jobConcurrency(jobId).group,
        `job \`${jobId}\` must share the group with the other suite job. ` +
          `Two groups means two suites at once, which is twenty-six forked ` +
          `processes on fourteen cores.`,
      ).toBe(SHARED_GROUP);
    }
  });

  it("keeps the group free of anything that varies per run", () => {
    // The regression that resolves cleanly and serializes nothing. `github.ref`
    // is the one somebody reaches for to make the queue shorter; `run_id`,
    // `run_number` and `sha` all do the same thing more thoroughly.
    for (const jobId of SUITE_JOBS) {
      const group = String(jobConcurrency(jobId).group);
      expect(
        group.includes("${{"),
        `job \`${jobId}\`'s group is an expression. Anything that varies ` +
          `per ref or per run gives each run its own group, which is the ` +
          `arrangement this replaced and is green until two runs overlap.`,
      ).toBe(false);
    }
  });

  it("queues rather than cancelling when a second run arrives", () => {
    for (const jobId of SUITE_JOBS) {
      const concurrency = jobConcurrency(jobId);
      expect(
        concurrency.queue,
        `job \`${jobId}\` must set \`queue: max\`. The default keeps one ` +
          `pending entry and cancels it when the next arrives, so a ` +
          `required check vanishes instead of failing — a merge blocked ` +
          `with nothing to read.`,
      ).toBe("max");
      expect(
        concurrency["cancel-in-progress"],
        `job \`${jobId}\` must not cancel in progress. GitHub refuses ` +
          `\`queue: max\` beside it, and cancelling the running suite to ` +
          `start another would defeat the point.`,
      ).toBe(false);
    }
  });

  it("leaves the ref-scoped workflow group cancelling as it did", () => {
    // The half that was already right, and that the job-level group must not
    // cost: a second push to one branch still cancels the first. That is also
    // what bounds the queue — it holds one entry per live branch rather than
    // one per push.
    const top = workflow.concurrency as Concurrency | undefined;
    expect(
      top?.group,
      `the workflow-level group must stay keyed on the ref, so a superseded ` +
        `run on one branch is cancelled rather than queued behind others`,
    ).toBe("${{ github.workflow }}-${{ github.ref }}");
    expect(top?.["cancel-in-progress"]).toBe(true);
  });
});
