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
  movedClock,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * How the `version-thinning` job takes the policy: from the instance
 * defaults for each field no type in the chain declares, from the instance
 * defaults for an item whose type is gone, and from the type as it stands
 * when a version is removed.
 *
 * The instance defaults are the server's settings, set here to values
 * unlike the built-in ones, so a job that read any other value thins an item
 * differently. Each case writes the same history under a type declaring a
 * field and under one that leaves it to the defaults, moves the server's
 * clock, and runs the job: the type that declares the field is the witness
 * that the history would have been kept.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A day, the window of a day, a week or so: one value each, the daily no
 *  smaller than the recent and the weekly no smaller than the daily. */
const DEFAULTS = {
  VERSION_RECENT_DAYS: "1",
  VERSION_DAILY_SNAPSHOT_DAYS: "2",
  VERSION_WEEKLY_SNAPSHOT_DAYS: "20",
  // Past reach, so only the runs a case asks for happen.
  VERSION_THINNING_INTERVAL_MS: "3153600000000",
};

let sequence = 0;

async function register(
  client: MarfaClient,
  version_policy?: object,
): Promise<string> {
  sequence += 1;
  const id = `user.thinning-${String(Date.now())}-${String(sequence)}`;
  const registered = await client.registerType({
    id,
    fields: { title: { type: "string" } },
    ...(version_policy !== undefined && { version_policy }),
  } as Parameters<MarfaClient["registerType"]>[0]);
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  return id;
}

async function item(client: MarfaClient, type: string): Promise<string> {
  const created = await client.createItem({
    type,
    properties: { title: "v1" },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

/** Writes `count` updates at the server's time now, each leaving a snapshot. */
async function update(
  client: MarfaClient,
  id: string,
  count: number,
): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const current = await client.getItem(id);
    const updated = await client.updateItem(id, {
      properties: { title: `v${String(current.data.item.version + 1)}` },
      version: current.data.item.version,
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
  }
}

async function history(client: MarfaClient, id: string): Promise<number[]> {
  const versions = await client.getVersions(id);
  expect(versions.status, JSON.stringify(versions.error)).toBe(200);
  return versions.data.data.map((v) => v.version);
}

async function thin(server: FreshServer): Promise<void> {
  const run = await runJob(server, "version-thinning");
  expect(run.outcome, String(run.error)).toBe("ok");
}

/** Moves the clock out of the minute before a UTC midnight, so the writes of
 *  a case that wants one date all carry it. */
async function awayFromMidnight(
  clock: ReturnType<typeof movedClock>,
): Promise<void> {
  const intoDay = clock.now() % DAY_MS;
  if (intoDay > DAY_MS - 120_000) await clock.advance(DAY_MS - intoDay + 1_000);
}

describe("version thinning by the instance defaults", () => {
  let server: FreshServer;
  let writer: MarfaClient;
  let clock: ReturnType<typeof movedClock>;

  beforeAll(async () => {
    server = await bootFreshServer("housekeeping-thinning", DEFAULTS);
    writer = writerOf(server);
    clock = movedClock(server);
    await quiet(server, ["version-thinning"]);
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  it(
    "takes recent_days from the instance default when no type in the chain declares it",
    async () => {
      await awayFromMidnight(clock);
      const bare = await register(writer);
      const partial = await register(writer, { max_versions: 100 });
      const declaring = await register(writer, { recent_days: 30 });
      const left = await item(writer, bare);
      const other = await item(writer, partial);
      const kept = await item(writer, declaring);
      await update(writer, left, 4);
      await update(writer, other, 4);
      await update(writer, kept, 4);

      // A day and a half on: past the default's day, inside the declared thirty.
      await clock.advance(1.5 * DAY_MS);
      await thin(server);

      // Four snapshots from one day: the default keeps the latest of the day.
      expect(await history(writer, left)).toEqual([4]);
      // A type that declares another field leaves this one to the default.
      expect(await history(writer, other)).toEqual([4]);
      // The witness: the same four snapshots, kept by the declared window.
      expect(await history(writer, kept)).toEqual([1, 2, 3, 4]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "takes daily_snapshot_days from the instance default when no type in the chain declares it",
    async () => {
      // A Monday noon, so the snapshots of a Monday and a Tuesday share a
      // week and differ in day.
      const now = new Date(clock.now());
      const monday = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + ((8 - now.getUTCDay()) % 7 || 7),
        12,
      );
      await clock.advance(monday - clock.now());

      const bare = await register(writer);
      const partial = await register(writer, { max_versions: 100 });
      const declaring = await register(writer, { daily_snapshot_days: 60 });
      const left = await item(writer, bare);
      const other = await item(writer, partial);
      const kept = await item(writer, declaring);
      // Two snapshots on the Monday, one on the Tuesday.
      const all = [left, other, kept];
      for (const id of all) await update(writer, id, 2);
      await clock.advance(DAY_MS);
      for (const id of all) await update(writer, id, 1);

      // Thursday evening: the Tuesday's snapshot is two days and a quarter
      // old, past the default's two days and inside the declared sixty.
      await clock.advance(2.25 * DAY_MS);
      await thin(server);

      // Past the daily window the week keeps one snapshot, the latest.
      expect(await history(writer, left)).toEqual([3]);
      expect(await history(writer, other)).toEqual([3]);
      // The witness: inside the declared window a day keeps one, so the
      // Monday's latest and the Tuesday's stay.
      expect(await history(writer, kept)).toEqual([2, 3]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "takes weekly_snapshot_days from the instance default when no type in the chain declares it",
    async () => {
      await awayFromMidnight(clock);
      const bare = await register(writer);
      const partial = await register(writer, { max_versions: 100 });
      const declaring = await register(writer, { weekly_snapshot_days: 365 });
      const left = await item(writer, bare);
      const other = await item(writer, partial);
      const kept = await item(writer, declaring);
      const all = [left, other, kept];
      for (const id of all) await update(writer, id, 2);

      // The newest snapshot is written twenty days and a half on, and the
      // first two are then twenty-one days old: past the default's twenty.
      await clock.advance(20.5 * DAY_MS);
      for (const id of all) await update(writer, id, 1);
      await clock.advance(0.5 * DAY_MS);
      await thin(server);

      // Beyond the weekly window a snapshot is removed.
      expect(await history(writer, left)).toEqual([3]);
      expect(await history(writer, other)).toEqual([3]);
      // The witness: inside the declared year a week keeps one.
      expect(await history(writer, kept)).toEqual([2, 3]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "thins an item whose type is no longer registered by the instance defaults",
    async () => {
      await awayFromMidnight(clock);
      // A policy that keeps everything for ten years.
      const keeping = { recent_days: 3650 };
      const gone = await register(writer, keeping);
      const registered = await register(writer, keeping);
      const orphan = await item(writer, gone);
      const witness = await item(writer, registered);
      await update(writer, orphan, 4);
      await update(writer, witness, 4);
      const removed = await writer.deleteType(gone, true);
      expect(removed.status, JSON.stringify(removed.error)).toBe(200);

      await clock.advance(1.5 * DAY_MS);
      await thin(server);

      // The defaults keep the latest snapshot of the day.
      expect(await history(writer, orphan)).toEqual([4]);
      // The witness: the policy the removed type held, kept by a type that
      // still holds it.
      expect(await history(writer, witness)).toEqual([1, 2, 3, 4]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("version thinning by the default for most versions", () => {
  it(
    "takes max_versions from the instance default when no type in the chain declares it",
    async () => {
      const server = await bootFreshServer("housekeeping-thinning-max", {
        VERSION_MAX_VERSIONS: "2",
        VERSION_THINNING_INTERVAL_MS: "3153600000000",
      });
      try {
        await quiet(server, ["version-thinning"]);
        const writer = writerOf(server);
        const bare = await register(writer);
        const partial = await register(writer, { recent_days: 30 });
        const declaring = await register(writer, { max_versions: 10 });
        const left = await item(writer, bare);
        const other = await item(writer, partial);
        const kept = await item(writer, declaring);
        for (const id of [left, other, kept]) await update(writer, id, 4);

        await thin(server);

        // The cap drops the oldest.
        expect(await history(writer, left)).toEqual([3, 4]);
        expect(await history(writer, other)).toEqual([3, 4]);
        expect(await history(writer, kept)).toEqual([1, 2, 3, 4]);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("version thinning while a type is replaced", () => {
  it(
    "thins each item by the policy as it stands when its snapshots are removed",
    async () => {
      const server = await bootFreshServer("housekeeping-thinning-race", {
        VERSION_THINNING_INTERVAL_MS: "3153600000000",
      });
      try {
        await quiet(server, ["version-thinning"]);
        const writer = writerOf(server);
        const first = await register(writer, { max_versions: 2 });
        const second = await register(writer, { max_versions: 2 });
        // In the order the job takes them, the first held at its item.
        const held = await item(writer, first);
        const behind = await item(writer, second);
        await update(writer, held, 6);
        await update(writer, behind, 6);

        await server.setFault("hold:version-thinning:item");
        const run = runJob(server, "version-thinning");
        await server.waitForHold("hold:version-thinning:item");

        // The job has chosen to thin the first item to two and is holding.
        // Both types are replaced with room for more.
        for (const [type, max] of [
          [first, 5],
          [second, 3],
        ] as const) {
          const replaced = await writer.replaceType(type, {
            id: type,
            fields: { title: { type: "string" } },
            version_policy: { max_versions: max },
          });
          expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
        }
        // The witness: the job has removed nothing while it is held.
        expect(await history(writer, held)).toHaveLength(6);

        await server.clearFault();
        expect((await run).outcome).toBe("ok");

        expect(await history(writer, held)).toEqual([2, 3, 4, 5, 6]);
        expect(await history(writer, behind)).toEqual([4, 5, 6]);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
