import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob } from "../../client/types.js";
import { HOLD, idsWith, jobOf, queue, seed } from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

// An uncapped type move can outlast the stop's wait on a fast server.
let server: FreshServer;

/** What the long job must still have to do when the stop begins. */
const LONG_JOB_MS = 15_000;
const SAMPLE_ROWS = 1_000;
const FROM = "longjob.before";
const TO = "longjob.after";

function working(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
}

beforeAll(async () => {
  server = await bootFreshServer("bulk-job-long");
  for (const id of [FROM, TO]) {
    const registered = await working().registerType({
      id,
      fields: { body: { type: "string" } },
    } as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  }
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** How many items of `tag` stand at each type and version. */
async function versionsOf(tag: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await working().listItems({ tags: [tag], limit: 200, cursor });
    expect(page.status).toBe(200);
    for (const item of page.data.data) {
      const at = `${item.type}@${String(item.version)}`;
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return counts;
}

/** How many items a second the worker writes, from a job over `SAMPLE_ROWS`. */
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
    rows = Math.ceil((pace * LONG_JOB_MS) / 1000);
    expect(rows).toBeGreaterThan(SAMPLE_ROWS);
    await seed(working(), "long", rows, { type: FROM });
    expect(await idsWith(working(), "long")).toHaveLength(rows);
  }, 600_000);
});

describe("stopping the server on SIGTERM", () => {
  it("exits 0 when a run outlives the stop's wait, and the job is finished once, on the return", async () => {
    const tag = "long";
    const rows = (await idsWith(working(), tag)).length;
    expect(await versionsOf(tag)).toEqual(new Map([[`${FROM}@1`, rows]]));

    await server.setFault(HOLD.betweenChunks);
    const moved = await working().moveType(FROM, { to: TO });
    expect(moved.status, JSON.stringify(moved.error)).toBe(202);
    const id = (moved.data as BulkActionJob).id;
    await server.waitForHold(HOLD.betweenChunks);

    const ended = await server.restart({ signal: "SIGTERM" });
    expect(ended.code, "the stop was read as a crash").toBe(0);
    expect(ended.ms).toBeLessThan(8_000);

    // The witness that the run outlived the wait: the job is not finished,
    // and it has written some of its items and not all.
    const cut = await jobOf(working(), id);
    expect(cut.status).toBe("in_progress");
    expect(cut.processed).toBeGreaterThan(0);
    expect(cut.processed).toBeLessThan(cut.matched);

    const done = await working().pollBulkActionToTerminal(id, {
      timeoutMs: 600_000,
    });
    expect(done).toMatchObject({
      status: "completed",
      processed: rows,
      succeeded: rows,
    });
    expect(await versionsOf(tag)).toEqual(new Map([[`${TO}@2`, rows]]));
  }, 900_000);
});
