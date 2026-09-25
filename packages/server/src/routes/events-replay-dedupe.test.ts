/**
 * A reconnect's replay withholds only what it actually sent.
 *
 * The replay used to discard every buffered live event whose id was at or
 * below the highest id it had walked past. It now records the ids it sent
 * and withholds against that set, which is the only thing double delivery
 * can mean. The property below: a row the replay *skipped* is not treated
 * as though it had been sent, so its buffered live copy is still
 * delivered.
 *
 * **What is real here and what is arranged.** The write is real and the
 * damaged row is really stored. The one thing arranged is *when* the
 * replay reads the log, by substituting `getAfter` with a gated wrapper —
 * and that is scheduling, which is what varies in production. The test
 * asserts on the rows that gated read returned, so a stray caller
 * consuming the gate fails the test by name instead of quietly reducing
 * it to a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Item } from "@withmarfa/shared";
import { createTestContext, request, readSse, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog, publish } from "../pubsub.js";
import type { PersistedEvent } from "../storage/interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this `publish` appends nothing and there is no replay at all:
  // the test context does not install an event-log store.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Park the replay's first `getAfter` until `open()`, then hand back the
 * rows that call returned.
 *
 * `rows` is the guard rather than a convenience. The gate is armed on the
 * first call, and nothing else in the process calls `getAfter` today —
 * but a retention tick or a background poller that did would spend the
 * gate, letting the replay read early, before the writes below exist. The
 * batch would come back empty, everything would go out live, and the test
 * would pass having exercised none of its own arrangement. Asserting what
 * the released read actually saw is what turns that into a named failure.
 */
interface ReplayGate {
  open: () => void;
  rows: Promise<PersistedEvent[]>;
  restore: () => void;
}

function gateFirstRead(): ReplayGate {
  const opened = deferred();
  const seen = deferred<PersistedEvent[]>();
  const store = ctx.storage.eventLog;
  const real = store.getAfter.bind(store);
  let armed = true;
  store.getAfter = async (
    afterId: bigint,
    limit: number,
  ): Promise<PersistedEvent[]> => {
    if (!armed) return real(afterId, limit);
    armed = false;
    await opened.promise;
    const batch = await real(afterId, limit);
    seen.resolve(batch);
    return batch;
  };
  return {
    open: () => {
      opened.resolve();
    },
    rows: seen.promise,
    restore: () => {
      store.getAfter = real;
    },
  };
}

/** The newest id in the log. Read rather than assumed: a fixed cursor
 *  trips the retention check and the stream then closes with
 *  `catchup_too_old` having replayed nothing. */
async function latestEventId(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 1000);
  return rows.reduce((max, row) => (row.id > max ? row.id : max), 0n);
}

async function createNote(marker: string): Promise<Item> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: marker } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: Item }).item;
}

/** How many frames carried this id. Counted rather than matched as a
 *  substring, which would read `id: 4` inside `id: 41`. */
function frames(text: string, id: bigint): number {
  return text.split("\n").filter((line) => line === `id: ${String(id)}`).length;
}

/** Raw SQL, for the one setup below that has to damage a stored row. */
function rawQuery(sql: string): Promise<unknown> {
  const s = ctx.storage as unknown as {
    __sqliteRun?: (query: string, params: unknown[]) => Promise<unknown>;
  };
  if (!s.__sqliteRun) {
    throw new Error("test storage no longer exposes __sqliteRun");
  }
  return s.__sqliteRun(sql, []);
}

describe("GET /events replay dedupe", () => {
  it("delivers the live copy of a row the replay skipped, exactly once", async () => {
    const SKIPPED = "ZZskippedrowZZ";
    const HEALTHY = "ZZhealthyrowZZ";
    const END = "ZZskipdrainedZZ";

    const skippedItem = await createNote(SKIPPED);
    const healthyItem = await createNote(HEALTHY);
    const endItem = await createNote(END);
    const cursor = await latestEventId();

    const gate = gateFirstRead();
    try {
      // `?type=` is what makes the replay decode a stored payload at all.
      // Without a filter it never parses, never skips, and the property
      // below has no way to arise — which is also why a suite run only
      // with an unfiltered operator key cannot tell recording-on-send
      // from recording-on-walk.
      const stream = await request(ctx.app, "GET", "/events?type=core.note", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      expect(stream.status).toBe(200);

      const reading = readSse(stream, { until: (t) => t.includes(END) });
      void reading.catch(() => undefined);
      await settle();

      // Emitted into the live buffer and committed, so the replay will
      // walk this row.
      const skippedId = await publish({ type: "updated", item: skippedItem });
      if (skippedId === undefined) {
        throw new Error("publish appended no event id; the log is unwired");
      }
      // A healthy row beside it, walked by the same replay and held by
      // the same buffer: the replay sends it, and the release must then
      // drop its held copy. Without it, a release that sent every held
      // frame would pass on the damaged row alone, whose only copy is
      // the held one.
      const healthyId = await publish({ type: "updated", item: healthyItem });
      if (healthyId === undefined) {
        throw new Error("publish appended no event id; the log is unwired");
      }

      // Now damage the stored row. The replay decodes it, fails, warns
      // and skips — while the buffered live copy is an object and is
      // untouched. This is the one skip whose live twin the stream can
      // still deliver, which makes it the only place the difference
      // between recording what was sent and recording what was walked is
      // observable.
      await rawQuery(
        `UPDATE event_log SET payload = 'not valid json' WHERE id = ${String(skippedId)}`,
      );

      gate.open();
      const replayed = (await gate.rows).map((row) => row.id);
      // The replay really did walk both rows; without this the test
      // could pass on a read that never reached them.
      expect(replayed).toContain(skippedId);
      expect(replayed).toContain(healthyId);

      await settle();
      await publish({ type: "updated", item: endItem });

      const { text } = await reading;
      // The marker cannot have come from the replay: the stored row no
      // longer contains it. Its presence is therefore proof that the
      // buffered live copy was delivered, which happens only because a
      // skipped row is not recorded as sent.
      expect(text).toContain(SKIPPED);
      expect(frames(text, skippedId)).toBe(1);
      // The healthy row went out with the replay and its held copy was
      // dropped: once, not twice.
      expect(text).toContain(HEALTHY);
      expect(frames(text, healthyId)).toBe(1);
    } finally {
      gate.open();
      gate.restore();
    }
  });
});
