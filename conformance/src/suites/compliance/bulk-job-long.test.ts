import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { HOLD, idsWith, jobOf, queue, seed } from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A bulk-action job that outlives the stop's wait for it: a stop on `SIGTERM`
 * ends with status 0 within the eight seconds a container runtime leaves, and
 * the next process finishes the job once.
 *
 * **How long is long.** The stop waits four seconds for a run in flight, so a
 * job that outlives the wait needs more than that to do. The contract
 * states no pace, so the fixture measures one: it times a job over a thousand
 * rows and sizes the long job to take at least `LONG_JOB_MS` at that
 * pace, up to the most a job may match.
 */
let server: FreshServer;

/** What the long job must still have to do when the stop begins. */
const LONG_JOB_MS = 15_000;
/** The most items one job may match (`items/bulk-action-cap`). */
const MOST_ROWS = 50_000;
const SAMPLE_ROWS = 1_000;

const PATCH = { resumed: "after the stop" };

function working(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
}

beforeAll(async () => {
  server = await bootFreshServer("bulk-job-long", {
    MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS: "1000",
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** How many rows of `tag` stand at each version. */
async function versionsOf(tag: string): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  let cursor: string | undefined;
  do {
    const page = await working().listItems({ tags: [tag], limit: 200, cursor });
    expect(page.status).toBe(200);
    for (const item of page.data.data) {
      counts.set(item.version, (counts.get(item.version) ?? 0) + 1);
    }
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return counts;
}

/** How many rows a second the worker writes, from a job over `SAMPLE_ROWS`. */
async function rowsPerSecond(): Promise<number> {
  await seed(working(), "pace", SAMPLE_ROWS);
  const started = Date.now();
  const job = await working().pollBulkActionToTerminal(
    await queue(working(), {
      action: "update_properties",
      patch: { pace: true },
      filter: { tags: ["pace"] },
    }),
    { timeoutMs: 120_000 },
  );
  expect(job.status).toBe("completed");
  return (SAMPLE_ROWS * 1000) / (Date.now() - started);
}

describe("a bulk action that takes seconds", () => {
  let rows: number;

  it("is sized to take seconds", async () => {
    const pace = await rowsPerSecond();
    rows = Math.min(MOST_ROWS, Math.ceil((pace * LONG_JOB_MS) / 1000));
    expect(
      rows,
      `at ${String(Math.round(pace))} rows a second, ${String(MOST_ROWS)} rows take under ${String(LONG_JOB_MS / 1000)} seconds`,
    ).toBeGreaterThan(SAMPLE_ROWS);
    await seed(working(), "long", rows);
    expect(await idsWith(working(), "long")).toHaveLength(rows);
  }, 600_000);
});

describe("stopping the server on SIGTERM", () => {
  it("exits 0 when a run outlives the stop's wait, and the job is finished once, on the return", async () => {
    const tag = "long";
    const rows = (await idsWith(working(), tag)).length;
    expect(await versionsOf(tag)).toEqual(new Map([[1, rows]]));

    await server.setFault(HOLD.betweenChunks);
    const id = await queue(working(), {
      action: "update_properties",
      patch: PATCH,
      filter: { tags: [tag] },
      max_items: rows,
    });
    await server.waitForHold(HOLD.betweenChunks);

    const ended = await server.restart({ signal: "SIGTERM" });
    expect(ended.code, "the stop was read as a crash").toBe(0);
    expect(ended.ms).toBeLessThan(8_000);

    // The witness that the run outlived the wait: the job is not finished,
    // and it has written some of its rows and not all.
    const cut = await jobOf(working(), id);
    expect(cut.status).toBe("in_progress");
    expect(cut.processed).toBeGreaterThan(0);
    expect(cut.processed).toBeLessThan(cut.matched);

    await server.advanceClock(5 * 60_000);
    const done = await working().pollBulkActionToTerminal(id, {
      timeoutMs: 600_000,
    });
    expect(done).toMatchObject({
      status: "completed",
      processed: rows,
      succeeded: rows,
    });
    expect(await versionsOf(tag)).toEqual(new Map([[2, rows]]));
  }, 900_000);
});
