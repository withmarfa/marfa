import { expect } from "vitest";
import type { FreshServer } from "./fresh-server.js";
import { operatorOf } from "./moved-clock.js";

/**
 * `GET /health` answered while a long job runs, between two of its steps,
 * with nothing holding the job (`instance/long-job-health`).
 *
 * **The witness is an order the target records.** Each case holds the job at
 * an early point and arms a second hold near its last step, so the job takes
 * dozens of turns between the two. A `release` fault clears the first hold
 * as the target admits `GET /health`, so the request is already in the
 * server when the job resumes, and the fault records which holds had a caller waiting when that
 * request answered. The server runs each database statement synchronously,
 * so a job that does not hand the process to other requests between its
 * steps runs from the first hold to the second before `/health` can finish
 * the disk and store reads it waits on. A job that yields lets `/health`
 * answer while it is still short of the second hold. The case reads that
 * order from the target, never from when this process sends or receives.
 *
 * `/health` is asked once while the job is held too, so the write probe has
 * committed before the job writes: its outcome answers the calls of the next
 * ten seconds, and a restore holds the write lock until it commits.
 */

async function health(server: FreshServer): Promise<void> {
  const answer = await fetch(`${server.apiUrl}/health`);
  await answer.arrayBuffer();
  expect(answer.status).toBe(200);
}

/** The name of a fault spec, without its argument. */
function nameOf(spec: string): string {
  const at = spec.indexOf("=");
  return at < 0 ? spec : spec.slice(0, at);
}

/**
 * Runs the job once and answers the holds the target recorded as waiting
 * when the `GET /health` that released the job answered. Once that is read,
 * it waits for the job to reach the later hold, which shows the later step
 * is on the job's path, and lets it finish.
 */
export async function heldWhenHealthAnswered(
  server: FreshServer,
  job: {
    /** The hold the job waits at before its steps. */
    start: string;
    /** The hold at the later step, armed before the job starts. */
    later: string;
    /** Starts the job, and answers what checks its outcome once it may finish. */
    begin: () => Promise<() => Promise<void>>;
  },
): Promise<string[]> {
  const release = `release:${nameOf(job.start).slice("hold:".length)}`;
  let finish: (() => Promise<void>) | undefined;
  let recorded: Awaited<ReturnType<FreshServer["faults"]>>[number] | undefined;
  let finished = false;
  try {
    await server.setFault(job.start);
    await server.setFault(job.later);
    finish = await job.begin();
    await server.waitForHold(nameOf(job.start));
    await health(server);
    await server.setFault(release);
    await health(server);
    recorded = (await server.faults()).find((fault) => fault.name === release);
    expect(recorded?.fired, `${release} released the job`).toBe(1);
    expect(recorded?.held_when_answered, "/health answered").toBeDefined();
    await server.waitForHold(nameOf(job.later));
    await server.clearFault();
    await finish();
    finished = true;
  } finally {
    // A failed case leaves no hold armed for the next, and its job ends.
    await server.clearFault();
    if (!finished && finish !== undefined) await finish().catch(() => {});
  }
  return recorded?.held_when_answered ?? [];
}

/** Every audit entry recorded for `action`. */
export async function audited(
  server: FreshServer,
  action: string,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await operatorOf(server).listAudit({
      action,
      limit: 200,
      cursor,
    });
    expect(page.status).toBe(200);
    count += page.data.data.length;
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return count;
}
