import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  jobs,
  movedClock,
  operatorOf,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * The tombstones a purge leaves, when the purge is the `trash-purge` job's,
 * and the jobs that must leave them alone. The job purges an item that has
 * been in the bin longer than the retention, so each case moves the server's
 * clock past it.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const SOURCE = "tombstone-housekeeping";

let server: FreshServer;
let writer: MarfaClient;
let clock: ReturnType<typeof movedClock>;
let linked: string;
let serial = 0;

beforeAll(async () => {
  server = await bootFreshServer(SOURCE, QUIET_SCHEDULE);
  writer = writerOf(server);
  clock = movedClock(server);
  await quiet(server, ["trash-purge"]);
  const config = (await writer.getConfig()).data as Record<string, unknown>;
  const set = await writer.updateConfig({ ...config, trash_retention_days: 1 });
  expect(set.status, JSON.stringify(set.error)).toBe(200);
  linked = `user.tombstone-${String(Date.now())}`;
  const registered = await writer.registerType({
    id: linked,
    fields: { vendor_id: { type: "string" }, title: { type: "string" } },
    link_field: "vendor_id",
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A row holding a link and a natural key, put in the bin. */
async function binned(): Promise<{ id: string; link: string; key: string }> {
  serial += 1;
  const link = `link-${String(serial)}`;
  const key = `key-${String(serial)}`;
  const created = await writer.createItem({
    type: linked,
    source: SOURCE,
    source_id: key,
    properties: { vendor_id: link },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const id = created.data.item.id;
  expect((await writer.deleteItem(id)).ok).toBe(true);
  return { id, link, key };
}

async function tombstones(link: string, key: string) {
  const byLink = await writer.lookupItems({ type: linked, links: [link] });
  const byKey = await writer.lookupItems({
    type: linked,
    source: SOURCE,
    source_ids: [key],
  });
  expect(byLink.ok, JSON.stringify(byLink.error)).toBe(true);
  expect(byKey.ok, JSON.stringify(byKey.error)).toBe(true);
  return {
    byLink: byLink.data.tombstones,
    byKey: byKey.data.tombstones,
    rows: [...byLink.data.data, ...byKey.data.data].map((i) => i.state),
  };
}

describe("a tombstone and housekeeping", () => {
  it(
    "is recorded, for the link and the natural key, when the trash-purge job purges an item",
    async () => {
      const row = await binned();
      // The witness: a row in the bin holds its link and leaves no tombstone.
      expect(await tombstones(row.link, row.key)).toEqual({
        byLink: [],
        byKey: [],
        rows: ["trashed", "trashed"],
      });

      await clock.advance(2 * DAY_MS);
      const before = new Date(clock.now()).toISOString();
      const run = await runJob(server, "trash-purge");
      expect(run.outcome, String(run.error)).toBe("ok");
      const after = new Date(clock.now()).toISOString();
      expect(run.result).toMatchObject({ deleted: 1 });

      const left = await tombstones(row.link, row.key);
      expect(left.rows).toEqual([]);
      expect(left.byLink).toHaveLength(1);
      const [tombstone] = left.byLink;
      expect(tombstone?.key).toBe(row.link);
      const purgedAt = tombstone?.purged_at ?? "";
      // The purge time is the server's, which the clock was moved to.
      expect(purgedAt >= before && purgedAt <= after, purgedAt).toBe(true);
      expect(tombstone?.settled_at).toBe(purgedAt);
      expect(left.byKey).toEqual([
        { key: row.key, purged_at: purgedAt, settled_at: purgedAt },
      ]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is not removed by any housekeeping job, however far the clock moves",
    async () => {
      const row = await binned();
      await clock.advance(2 * DAY_MS);
      expect((await runJob(server, "trash-purge")).outcome).toBe("ok");
      const recorded = await tombstones(row.link, row.key);
      // The witness: the tombstones are there to be removed.
      expect(recorded.byLink).toHaveLength(1);
      expect(recorded.byKey).toHaveLength(1);

      // Ten years, and then every job the instance runs.
      await clock.advance(3650 * DAY_MS);
      const names = Object.keys(await jobs(server));
      expect(names.length).toBeGreaterThanOrEqual(10);
      for (const name of names) {
        const run = await runJob(server, name);
        expect(run.name).toBe(name);
      }
      expect(Object.keys(await jobs(server)).sort()).toEqual(names.sort());

      expect(await tombstones(row.link, row.key)).toEqual(recorded);
      // The jobs ran: the operator's listing records each finishing.
      const listed = await operatorOf(server).listHousekeeping();
      for (const job of listed.data.data) {
        expect(job.last_finished_at, job.name).not.toBeNull();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
