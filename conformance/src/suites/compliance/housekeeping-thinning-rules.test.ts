import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  writerOf,
} from "../../utils/moved-clock.js";
import {
  history,
  item,
  register,
  thin,
  update,
} from "../../utils/version-history.js";

/**
 * Which snapshots the `version-thinning` job keeps. Each case writes one
 * history, a snapshot at each of the instants it names, at the server's moved
 * clock, and runs the job at the instant it names. The instants are given as
 * how far they stand from that one, on a day of the week the case picks, so
 * a snapshot falls on the side of a UTC midnight or an ISO week's start the
 * case means. The type of each item declares the whole policy, so the
 * instance defaults take no part. A case that asserts a snapshot removed has
 * an item of the same history under a policy that keeps it.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const WEEK_MS = 7 * DAY_MS;
const WEDNESDAY = 3;
const SATURDAY = 6;

/** The first noon UTC on that day of the week at least `after` ms on. */
function noonOn(weekday: number, after: number): number {
  const day = new Date(after);
  let noon = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    12,
  );
  while (new Date(noon).getUTCDay() !== weekday || noon < after) {
    noon += DAY_MS;
  }
  return noon;
}

interface Moment {
  /** How long before the run the snapshot is written. */
  before: number;
  /** Whether the first item, with the narrowest windows, keeps the snapshot. */
  kept: boolean;
}

/** The instant of a Monday 00:00 UTC that is `weeks` before the one that starts the week of a Wednesday noon. */
const mondayBefore = (weeks: number): number =>
  2 * DAY_MS + 12 * HOUR_MS + weeks * WEEK_MS;

describe("version thinning by the policy a type declares", () => {
  let server: FreshServer;
  let writer: MarfaClient;
  let clock: ReturnType<typeof movedClock>;

  beforeAll(async () => {
    server = await bootFreshServer("housekeeping-thinning-rules", {
      ...QUIET_SCHEDULE,
    });
    writer = writerOf(server);
    clock = movedClock(server);
    await quiet(server, ["version-thinning"]);
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  async function advanceTo(at: number): Promise<void> {
    expect(at, "the clock only goes forward").toBeGreaterThanOrEqual(
      clock.now(),
    );
    await clock.advance(at - clock.now());
  }

  /**
   * Creates an item under each policy, updates each at each instant, so that
   * the snapshot of the version an update replaces has the time of that
   * update, and moves the clock to the first instant on the given weekday
   * that leaves room for the oldest. The item's own last version is no
   * snapshot, so an item holds one snapshot for each instant.
   */
  async function written(
    weekday: number,
    befores: readonly number[],
    policies: readonly object[],
  ): Promise<{ ids: string[]; runAt: number }> {
    const oldest = Math.max(...befores);
    const runAt = noonOn(weekday, clock.now() + oldest + HOUR_MS);
    const ids: string[] = [];
    for (const policy of policies) {
      ids.push(await item(writer, await register(writer, policy)));
    }
    for (const before of befores) {
      await advanceTo(runAt - before);
      for (const id of ids) await update(writer, id, 1);
    }
    await advanceTo(runAt);
    return { ids, runAt };
  }

  async function thinned(
    weekday: number,
    befores: readonly number[],
    policies: readonly object[],
  ): Promise<number[][]> {
    const { ids } = await written(weekday, befores, policies);
    await thin(server);
    return Promise.all(ids.map((id) => history(writer, id)));
  }

  /** The versions a case expects of the first item. */
  const keptOf = (moments: readonly Moment[]): number[] =>
    moments.flatMap((moment, at) => (moment.kept ? [at + 1] : []));
  const beforesOf = (moments: readonly Moment[]): number[] =>
    moments.map((moment) => moment.before);

  it(
    "keeps every snapshot no older than recent_days, and removes those older than weekly_snapshot_days",
    async () => {
      // Run on a Wednesday noon, so that two days back is a Monday noon.
      const moments: Moment[] = [
        { before: 2 * DAY_MS + 4 * HOUR_MS, kept: false },
        { before: 2 * DAY_MS + 3 * HOUR_MS, kept: false },
        { before: 2 * DAY_MS - HOUR_MS, kept: true },
        { before: DAY_MS + 2 * HOUR_MS, kept: true },
        { before: DAY_MS + 90 * MINUTE_MS, kept: true },
      ];
      const [narrow, wide] = await thinned(WEDNESDAY, beforesOf(moments), [
        { recent_days: 2, daily_snapshot_days: 2, weekly_snapshot_days: 2 },
        { recent_days: 3, daily_snapshot_days: 3, weekly_snapshot_days: 3 },
      ]);
      // The two snapshots from before the window go, and the three after it
      // stay, though two of them share a day.
      expect(narrow).toEqual(keptOf(moments));
      // The witness: a window of three days holds every one of them.
      expect(wide).toEqual([1, 2, 3, 4, 5]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the latest snapshot of each UTC calendar day past recent_days, up to daily_snapshot_days",
    async () => {
      // Run on a Saturday noon: the daily window opens the Sunday noon, and
      // the recent window the Friday noon.
      const moments: Moment[] = [
        // The Sunday 09:00, before the window.
        { before: 6 * DAY_MS + 3 * HOUR_MS, kept: false },
        // The Monday 09:00 and 15:00: the latest of the day stays.
        { before: 5 * DAY_MS + 3 * HOUR_MS, kept: false },
        { before: 5 * DAY_MS - 3 * HOUR_MS, kept: true },
        // The Tuesday 23:30 and the Wednesday 00:30 stand an hour apart in
        // two days, so the Tuesday's stays though the Wednesday's does not.
        { before: 4 * DAY_MS - 11 * HOUR_MS - 30 * MINUTE_MS, kept: true },
        { before: 3 * DAY_MS + 11 * HOUR_MS + 30 * MINUTE_MS, kept: false },
        // The Wednesday 18:00, the latest of its day.
        { before: 3 * DAY_MS - 6 * HOUR_MS, kept: true },
        // The Friday 13:00 and 14:00, within recent_days: both stay.
        { before: DAY_MS - HOUR_MS, kept: true },
        { before: DAY_MS - 2 * HOUR_MS, kept: true },
      ];
      const [narrow, witness] = await thinned(SATURDAY, beforesOf(moments), [
        { recent_days: 1, daily_snapshot_days: 6, weekly_snapshot_days: 6 },
        { recent_days: 7, daily_snapshot_days: 7, weekly_snapshot_days: 7 },
      ]);
      expect(narrow).toEqual(keptOf(moments));
      // The witness: a recent window of a week holds every snapshot.
      expect(witness).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the latest snapshot of each ISO week past daily_snapshot_days, up to weekly_snapshot_days",
    async () => {
      // Run on a Wednesday noon. A week starts on a Monday, so a Sunday 23:30
      // and the Monday 00:30 after it stand an hour apart in two weeks.
      const moments: Moment[] = [
        // Past the weekly window of forty days.
        { before: 41 * DAY_MS, kept: false },
        // The Sunday 10:00 and 23:30 that end one week: the latest stays.
        { before: mondayBefore(2) + 14 * HOUR_MS, kept: false },
        { before: mondayBefore(2) + 30 * MINUTE_MS, kept: true },
        // The Monday 00:30 that starts the next, alone in it.
        { before: mondayBefore(2) - 30 * MINUTE_MS, kept: true },
        // The Tuesday and the Friday 08:00 of the week after: the Friday stays.
        { before: mondayBefore(1) - DAY_MS - 8 * HOUR_MS, kept: false },
        { before: mondayBefore(1) - 4 * DAY_MS - 8 * HOUR_MS, kept: true },
        // Within recent_days.
        { before: 2 * HOUR_MS, kept: true },
      ];
      const [narrow, witness] = await thinned(WEDNESDAY, beforesOf(moments), [
        { recent_days: 1, daily_snapshot_days: 1, weekly_snapshot_days: 40 },
        { recent_days: 1, daily_snapshot_days: 1, weekly_snapshot_days: 60 },
      ]);
      expect(narrow).toEqual(keptOf(moments));
      // The witness: a window of sixty days keeps the oldest as well.
      expect(witness).toEqual([1, 3, 4, 6, 7]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "removes no snapshot by age where weekly_snapshot_days is 0, and keeps nothing by recent_days or daily_snapshot_days where they are 0",
    async () => {
      // Run on a Wednesday noon: the last two snapshots share its day.
      const befores = [
        100 * DAY_MS,
        100 * DAY_MS - HOUR_MS,
        50 * DAY_MS,
        20 * DAY_MS,
        5 * HOUR_MS,
        4 * HOUR_MS,
      ];
      const [keeping, weekly, recent] = await thinned(WEDNESDAY, befores, [
        { recent_days: 0, daily_snapshot_days: 0, weekly_snapshot_days: 0 },
        { recent_days: 0, daily_snapshot_days: 0, weekly_snapshot_days: 7 },
        { recent_days: 1, daily_snapshot_days: 1, weekly_snapshot_days: 7 },
      ]);
      // A weekly window of 0 keeps every snapshot, whatever its age.
      expect(keeping).toEqual([1, 2, 3, 4, 5, 6]);
      // Windows of 0 days keep nothing for being recent or daily: the one
      // week within the weekly window keeps its latest snapshot.
      expect(weekly).toEqual([6]);
      // The witness: a recent window of a day keeps both of the last two.
      expect(recent).toEqual([5, 6]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the newest version whatever its age",
    async () => {
      const [thinnedAway] = await thinned(
        WEDNESDAY,
        [10 * DAY_MS, 9 * DAY_MS, 8 * DAY_MS],
        [{ recent_days: 1, daily_snapshot_days: 1, weekly_snapshot_days: 1 }],
      );
      expect(thinnedAway).toEqual([3]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "drops the oldest of the snapshots the windows keep past max_versions, and never the newest",
    async () => {
      // Run on a Saturday noon: the snapshots of the Monday, the Tuesday and
      // the Wednesday are in the daily window, the Friday's is recent, and
      // the windows keep all four.
      const befores = [
        5 * DAY_MS + 3 * HOUR_MS,
        4 * DAY_MS + 3 * HOUR_MS,
        3 * DAY_MS + 3 * HOUR_MS,
        DAY_MS - HOUR_MS,
      ];
      const windows = {
        recent_days: 1,
        daily_snapshot_days: 6,
        weekly_snapshot_days: 6,
      };
      const [two, one, witness] = await thinned(SATURDAY, befores, [
        { ...windows, max_versions: 2 },
        { ...windows, max_versions: 1 },
        { ...windows, max_versions: 10 },
      ]);
      expect(two).toEqual([3, 4]);
      expect(one).toEqual([4]);
      // The witness: the windows alone keep all four.
      expect(witness).toEqual([1, 2, 3, 4]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps a snapshot whose stored time does not read, and counts it toward max_versions",
    async () => {
      const old = [10 * DAY_MS, 9 * DAY_MS, 8 * DAY_MS, 7 * DAY_MS];
      const windows = {
        recent_days: 1,
        daily_snapshot_days: 1,
        weekly_snapshot_days: 1,
      };
      const wide = {
        recent_days: 100,
        daily_snapshot_days: 100,
        weekly_snapshot_days: 100,
        max_versions: 2,
      };
      const { ids } = await written(WEDNESDAY, old, [windows, wide, wide]);
      // A hand edit leaves a time no door writes, on the second snapshot of
      // the first two items. The third is the witness.
      withInstanceDatabase(server.sqlitePath, (db) => {
        for (const id of ids.slice(0, 2)) {
          db.prepare(
            "UPDATE item_versions SET created_at = 'not a time' " +
              "WHERE version = 2 AND item_seq = (SELECT seq FROM items WHERE id = ?)",
          ).run(id);
        }
      });
      await thin(server);
      const [aged, capped, witness] = await Promise.all(
        ids.map((id) => history(writer, id)),
      );
      // Beyond every window the first and third go; the second, whose age
      // cannot be read, and the newest stay.
      expect(aged).toEqual([2, 4]);
      // The four snapshots are all within the windows and the cap is two.
      // The second counts toward the cap, so two are to go, and they come
      // from the oldest whose time reads: the first and the third. A count
      // that left the second out would remove only the first.
      expect(capped).toEqual([2, 4]);
      // The witness: the same cap on a history whose times all read removes
      // the oldest two and keeps the other two.
      expect(witness).toEqual([3, 4]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
