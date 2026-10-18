import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { HOLD, jobOf, queue, seed } from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  jobs,
  movedClock,
  quiet,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * A stop on `SIGTERM` while a bulk action and a housekeeping run are both in
 * flight. The target holds each where it stands; the stop lets them go, as a
 * run that was not held would have gone on, and the fixture then asks what
 * the storage was left holding: whether the work finished and wrote its
 * record, or was cut off when the storage closed.
 */
let server: FreshServer;
let writer: MarfaClient;
const THINNING = "version-thinning";
const HELD_THINNING = "hold:version-thinning:item";

/** Rows enough that the job has a place between chunks, whatever the chunk size. */
const ROWS = 350;

beforeAll(async () => {
  server = await bootFreshServer("stop-waits-for-work", {
    // The instance defaults the thinning of a plain type follows: a day, two
    // days, twenty. The interval is past reach, so the only runs are the
    // fixture's own.
    VERSION_RECENT_DAYS: "1",
    VERSION_DAILY_SNAPSHOT_DAYS: "2",
    VERSION_WEEKLY_SNAPSHOT_DAYS: "20",
    VERSION_THINNING_INTERVAL_MS: "3153600000000",
    MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS: "1000",
  });
  writer = writerOf(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("stopping the server with runs in flight", () => {
  it("lets the bulk action and the housekeeping run finish before the storage closes, and exits 0", async () => {
    const clock = movedClock(server);
    await quiet(server, [THINNING]);
    const before = (await jobs(server))[THINNING]!;
    expect(before.last_outcome).toBe("ok");

    // An item with three snapshots from one day, a day and a half old when
    // the job runs: the job thins them to the latest.
    const intoDay = clock.now() % DAY_MS;
    if (intoDay > DAY_MS - 120_000)
      await clock.advance(DAY_MS - intoDay + 1_000);
    const created = await writer.createItem({
      type: "core.note",
      properties: { body: "v1" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const noteId = created.data.item.id;
    for (let version = 1; version < 4; version += 1) {
      const updated = await writer.updateItem(noteId, {
        properties: { body: `v${String(version + 1)}` },
        version,
      });
      expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    }
    await clock.advance(1.5 * DAY_MS);
    const snapshots = async () =>
      (await writer.getVersions(noteId)).data.data.map((v) => v.version);
    expect(await snapshots()).toEqual([1, 2, 3]);

    await seed(writer, "stop-waits", ROWS);

    // Both held: the housekeeping run mid-way, before it removes a version,
    // and the bulk action between two chunks.
    await server.setFault(HELD_THINNING);
    await server.setFault(HOLD.betweenChunks);
    const run = fetch(`${server.apiUrl}/housekeeping/${THINNING}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.managementKey}` },
    }).catch(() => undefined);
    const id = await queue(writer, {
      action: "update_tags",
      add: ["stop-waits-done"],
      filter: { tags: ["stop-waits"] },
    });
    await server.waitForHold(HELD_THINNING);
    await server.waitForHold(HOLD.betweenChunks);
    const held = await jobOf(writer, id);
    expect(held.status).toBe("in_progress");
    expect(held.processed).toBeLessThan(held.matched);
    expect(await snapshots()).toEqual([1, 2, 3]);

    const ended = await server.restart({ signal: "SIGTERM" });
    await run;
    expect(ended.code, "the stop was read as a crash").toBe(0);
    expect(ended.ms).toBeLessThan(8_000);

    // No claim has gone stale, so a job the stop cut off is still in
    // progress here: it is complete only if the run finished first.
    writer = writerOf(server);
    expect(await jobOf(writer, id)).toMatchObject({
      status: "completed",
      processed: ROWS,
      succeeded: ROWS,
    });
    expect(await snapshots()).toEqual([3]);
    const after = (await jobs(server))[THINNING]!;
    expect(after.running_since).toBeNull();
    expect(after.last_outcome).toBe("ok");
    expect(Date.parse(after.last_finished_at ?? "")).toBeGreaterThan(
      Date.parse(before.last_finished_at ?? ""),
    );
  }, 300_000);
});
