import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
} from "../../utils/moved-clock.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * What the retention jobs do to the event log and announce through it.
 *
 * Nothing a request does ages a row, and the retention windows are an hour
 * and a day at the least, so each case writes through the doors, moves the
 * server's clock past the window through the target interface, and runs the
 * job through the operator's door. That is the state a long-running instance
 * reaches, arranged rather than waited for.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Past the default window of both jobs, the event log's thirty days and the
 *  trash's sixty. */
const PAST_BOTH_WINDOWS_MS = 61 * DAY_MS;
/** Past the event log's window and inside the trash's. */
const PAST_EVENT_WINDOW_MS = 31 * DAY_MS;

/** The clients are made on each use, bound to the address a restart moves. */
interface Instance {
  server: FreshServer;
  clock: ReturnType<typeof movedClock>;
  writer: () => MarfaClient;
  operator: () => MarfaClient;
}

/**
 * A server of its own whose two retention jobs are not due: each has run once
 * and its next run is out of reach, so the run the fixture asks for is the
 * only one however far the clock moves.
 */
async function instance(label: string): Promise<Instance> {
  const server = await bootFreshServer(label, QUIET_SCHEDULE);
  await quiet(server, ["event-log-cleanup", "trash-purge"]);
  return {
    server,
    clock: movedClock(server),
    writer: () =>
      new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey }),
    operator: () =>
      new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.managementKey }),
  };
}

const itemOf = (e: SseEvent): string | undefined =>
  (e.data as { item?: { id?: string } }).item?.id;
const edgeOf = (e: SseEvent): string | undefined =>
  (e.data as { edge?: { id?: string } }).edge?.id;

function reach(instanceOf: Instance): {
  read: (
    cursor: string | undefined,
    until: (events: SseEvent[]) => boolean,
    signal: AbortSignal,
  ) => Promise<SseEvent[]>;
} {
  return {
    read: (cursor, until, signal) =>
      withStream(
        instanceOf.server.apiUrl,
        instanceOf.server.workingKey,
        cursor === undefined ? {} : { lastEventId: cursor },
        async (stream) =>
          (
            await collectUntil(
              stream,
              until,
              `a frame ending the read from cursor ${cursor ?? "none"}`,
              signal,
            )
          ).events,
      ),
  };
}

const tooOld = (events: SseEvent[]): boolean =>
  events.some((e) => e.event === "catchup_too_old");

/** The event id of the frame for each of `items`, read from the whole log. */
async function eventIds(
  instanceOf: Instance,
  items: readonly string[],
  signal: AbortSignal,
): Promise<bigint[]> {
  const last = items.at(-1)!;
  const events = await reach(instanceOf).read(
    "0",
    (seen) => seen.some((e) => itemOf(e) === last),
    signal,
  );
  return items.map((item) => {
    const frame = events.find((e) => itemOf(e) === item);
    expect(frame?.id, `no event for ${item}`).toBeDefined();
    return BigInt(frame!.id!);
  });
}

async function notes(
  log: Instance,
  count: number,
  label: string,
): Promise<string[]> {
  const written: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const created = await log.writer().createItem({
      type: "core.note",
      properties: { body: `${label}-${String(n)}` },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    written.push(created.data.item.id);
  }
  return written;
}

/**
 * Sets one event's stored time to the instant the server's clock now reads.
 * The log's retention cuts by id, below the oldest event within the window,
 * because `append` stamps an event before its insert waits for the write
 * lock, so a stamp can stand below the stamps of events before it. No door
 * lets a fixture lose that race on purpose, so the one event is stamped in
 * the stored file, the only thing in this fixture that is not the clock.
 */
async function stampNow(log: Instance, eventId: bigint): Promise<void> {
  await log.server.restart({
    whileStopped: () => {
      withInstanceDatabase(log.server.sqlitePath, (db) => {
        const stamped = db
          .prepare("UPDATE event_log SET created_at = ? WHERE id = ?")
          .run(new Date(log.clock.now()).toISOString(), Number(eventId));
        expect(stamped.changes).toBe(1);
      });
    },
  });
}

describe("the event log's retention job", () => {
  it(
    "retires the oldest events together, keeping every event from the oldest one within the window",
    async ({ signal }) => {
      const log = await instance("event-retention-prefix");
      const early = await notes(log, 2, "retired-together");
      await log.clock.advance(PAST_EVENT_WINDOW_MS);
      const late = await notes(log, 4, "kept-together");
      const written = [...early, ...late];
      const ids = await eventIds(log, written, signal);
      const read = reach(log).read;

      // The witness: nothing has been retired before the job runs, though
      // the first two events are past the window.
      const whole = await read(
        "0",
        (seen) => seen.some((e) => itemOf(e) === written[5]),
        signal,
      );
      expect(tooOld(whole)).toBe(false);
      for (const item of written) {
        expect(whole.some((e) => itemOf(e) === item)).toBe(true);
      }

      const run = await log.operator().runHousekeeping("event-log-cleanup");
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(run.data.outcome).toBe("ok");
      expect(run.data.result).toMatchObject({ deleted: 2 });

      // The oldest event the log keeps is the third, so the largest cursor
      // refused is the first event's and the smallest accepted is the
      // second's.
      const refused = await read(String(ids[0]), tooOld, signal);
      expect(
        refused.find((e) => e.event === "catchup_too_old")?.data,
      ).toMatchObject({ min_retained_id: String(ids[2]) });

      const kept = await read(
        String(ids[1]),
        (seen) => seen.some((e) => itemOf(e) === written[5]),
        signal,
      );
      expect(tooOld(kept)).toBe(false);
      expect(
        kept
          .filter((e) => e.event === "item.created" && e.id !== undefined)
          .map((e) => itemOf(e)),
      ).toEqual(written.slice(2));
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "never leaves a hole: an event past the window that stands above one within it is kept",
    async ({ signal }) => {
      const log = await instance("event-retention-hole");
      const old = await notes(log, 4, "past-the-window");
      await log.clock.advance(PAST_EVENT_WINDOW_MS);
      const young = await notes(log, 2, "within-the-window");
      const written = [...old, ...young];
      const ids = await eventIds(log, written, signal);
      // Of the six, the first two and the fourth are past the window and the
      // rest are within it. The fourth is old but stands above an event the
      // log keeps, so retiring it would leave a hole.
      await stampNow(log, ids[2]!);
      const read = reach(log).read;

      // The witness: nothing has been retired before the job runs.
      const whole = await read(
        "0",
        (seen) => seen.some((e) => itemOf(e) === written[5]),
        signal,
      );
      expect(tooOld(whole)).toBe(false);
      for (const item of written) {
        expect(whole.some((e) => itemOf(e) === item)).toBe(true);
      }

      const run = await log.operator().runHousekeeping("event-log-cleanup");
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(run.data.outcome).toBe("ok");
      expect(run.data.result).toMatchObject({ deleted: 2 });

      const refused = await read(String(ids[0]), tooOld, signal);
      expect(
        refused.find((e) => e.event === "catchup_too_old")?.data,
      ).toMatchObject({ min_retained_id: String(ids[2]) });

      const kept = await read(
        String(ids[1]),
        (seen) => seen.some((e) => itemOf(e) === written[5]),
        signal,
      );
      expect(tooOld(kept)).toBe(false);
      // Every event from the oldest kept onward, the old fourth included.
      expect(
        kept
          .filter((e) => e.event === "item.created" && e.id !== undefined)
          .map((e) => itemOf(e)),
      ).toEqual(written.slice(2));
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the newest event however old it is",
    async ({ signal }) => {
      const log = await instance("event-retention-newest");
      const written = await notes(log, 3, "all-old");
      const ids = await eventIds(log, written, signal);
      await log.clock.advance(PAST_EVENT_WINDOW_MS);
      const read = reach(log).read;

      // The witness: every event is past the window and the log holds all
      // three before the job runs.
      const whole = await read(
        "0",
        (seen) => seen.some((e) => itemOf(e) === written[2]),
        signal,
      );
      expect(tooOld(whole)).toBe(false);

      const run = await log.operator().runHousekeeping("event-log-cleanup");
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(run.data.outcome).toBe("ok");
      expect(run.data.result).toMatchObject({ deleted: 2 });

      const refused = await read(String(ids[0]), tooOld, signal);
      expect(
        refused.find((e) => e.event === "catchup_too_old")?.data,
      ).toMatchObject({ min_retained_id: String(ids[2]) });

      const newest = await read(
        String(ids[1]),
        (seen) => seen.some((e) => itemOf(e) === written[2]),
        signal,
      );
      expect(tooOld(newest)).toBe(false);
      expect(newest.find((e) => itemOf(e) === written[2])?.id).toBe(
        String(ids[2]),
      );
      const head = await read(
        String(ids[2]),
        (seen) => seen.some((e) => e.event === "stream_cursor"),
        signal,
      );
      expect(head.find((e) => e.event === "stream_cursor")?.data).toMatchObject(
        { cursor: String(ids[2]) },
      );
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("the trash retention job", () => {
  interface Purge {
    events: SseEvent[];
    doomed: string;
    edges: string[];
    kept: string;
  }
  let purge: Promise<Purge> | undefined;

  /** Arranged once for the two cases that read what the job announced. */
  function purged(signal: AbortSignal): Promise<Purge> {
    purge ??= (async () => {
      const bin = await instance("event-retention-trash");
      const [doomed, other, pointing] = await notes(bin, 3, "bin");
      const edgeBetween = async (
        source_id: string,
        target_id: string,
      ): Promise<string> => {
        const created = await bin.writer().createEdge({
          source_id,
          target_id,
          edge_type: "about",
        });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        return created.data.edge.id;
      };
      const outbound = await edgeBetween(doomed!, other!);
      const inbound = await edgeBetween(pointing!, doomed!);
      // An edge the purge does not touch, so a frame for every edge would
      // show as a frame for this one.
      const kept = await edgeBetween(pointing!, other!);
      expect((await bin.writer().deleteItem(doomed!)).ok).toBe(true);

      const head = await reach(bin).read(
        undefined,
        (seen) => seen.some((e) => e.event === "stream_cursor"),
        signal,
      );
      const cursor = (
        head.find((e) => e.event === "stream_cursor")!.data as {
          cursor: string;
        }
      ).cursor;

      await bin.clock.advance(PAST_BOTH_WINDOWS_MS);
      // The witness: the row is in the bin, past the window, until the job runs.
      const binned = async (): Promise<boolean> => {
        const listed = await bin.writer().listItems({ state: "trashed" });
        expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
        return listed.data.data.some((item) => item.id === doomed);
      };
      expect(await binned()).toBe(true);

      const run = await bin.operator().runHousekeeping("trash-purge");
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(run.data.outcome).toBe("ok");
      expect(run.data.result).toEqual({ deleted: 1 });

      expect(await binned()).toBe(false);

      const events = await reach(bin).read(
        cursor,
        (seen) =>
          seen.some((e) => e.event === "item.purged" && itemOf(e) === doomed),
        signal,
      );
      return {
        events,
        doomed: doomed!,
        edges: [outbound, inbound],
        kept,
      };
    })();
    return purge;
  }

  it(
    "announces item.purged for an item the retention job purges",
    async ({ signal }) => {
      const { events, doomed } = await purged(signal);
      const frames = events.filter(
        (e) => e.event === "item.purged" && itemOf(e) === doomed,
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]!.id).toBeDefined();
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "announces edge.deleted for each edge of an item the retention job purges, naming the item",
    async ({ signal }) => {
      const { events, doomed, edges, kept } = await purged(signal);
      const purgedId = BigInt(
        events.find((e) => e.event === "item.purged" && itemOf(e) === doomed)!
          .id!,
      );
      for (const edge of edges) {
        const frame = events.find(
          (e) => e.event === "edge.deleted" && edgeOf(e) === edge,
        );
        expect(frame, `no edge.deleted for ${edge}`).toBeDefined();
        expect((frame!.data as { purged_with?: string }).purged_with).toBe(
          doomed,
        );
        expect(
          BigInt(frame!.id!) < purgedId,
          `edge.deleted for ${edge} does not precede item.purged`,
        ).toBe(true);
      }
      expect(
        events.some((e) => e.event === "edge.deleted" && edgeOf(e) === kept),
        "an edge the purged item did not have was announced deleted",
      ).toBe(false);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
