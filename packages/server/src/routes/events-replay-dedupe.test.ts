/**
 * A reconnect's replay withholds only what it actually sent.
 *
 * `event_log.id` comes from a Postgres identity column, so an id is
 * assigned when the row is inserted and not when the transaction commits.
 * Two writers therefore commit out of order routinely: transaction A can
 * hold id 100 while B commits 101 first. A client reconnecting in that
 * window replays 101, and the replay used to discard every buffered live
 * event whose id was at or below the highest id it had walked past. Event
 * 100 arrived live a moment later and was dropped — with the client's
 * cursor already above it, so no later reconnect asks for it again and
 * nothing anywhere reports a gap.
 *
 * The replay now records the ids it sent and withholds against that set,
 * which is the only thing double delivery can mean. Two properties, one
 * per test below: an event that commits late is still delivered, and a
 * row the replay *skipped* is not treated as though it had been sent.
 *
 * **Postgres only, and the reason is the defect itself.** SQLite admits
 * one write transaction at a time: the rowid is assigned inside that
 * exclusive transaction, which commits before another writer may assign
 * one, so assignment order and commit order are identical by
 * construction and the interleaving under test cannot exist there. A
 * second concurrent writer does not produce an out-of-order id, it
 * produces SQLITE_BUSY. Skipping the dialect is the honest outcome
 * rather than a gap in coverage.
 *
 * **What is real here and what is arranged.** The transactions are real,
 * the ids come from the identity column, and the commit order is the
 * genuine article. The one thing arranged is *when* the replay reads the
 * log, by substituting `getAfter` with a gated wrapper — and that is
 * scheduling, which is what varies in production. Each test asserts on
 * the rows that gated read returned, so a stray caller consuming the
 * gate fails the test by name instead of quietly reducing it to a
 * no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Item } from "@withmarfa/shared";
import { createTestContext, request, readSse, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog, publish } from "../pubsub.js";
import type { PersistedEvent } from "../storage/interface.js";

/** Same gate as the other concurrency suites in this package. */
const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

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
    spaceId?: string,
  ): Promise<PersistedEvent[]> => {
    if (!armed) return real(afterId, limit, spaceId);
    armed = false;
    await opened.promise;
    const batch = await real(afterId, limit, spaceId);
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
    key: ctx.spaceKey,
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
function pgQuery(sql: string): Promise<unknown[]> {
  const s = ctx.storage as unknown as {
    __pgClient?: (query: string) => Promise<unknown[]>;
  };
  if (!s.__pgClient) {
    throw new Error("PG test storage no longer exposes __pgClient");
  }
  return s.__pgClient(sql);
}

describe.skipIf(!isPg)("GET /events replay dedupe", () => {
  it("delivers a live event whose id is below one the replay already sent", async () => {
    const LOW = "ZZlowcommitZZ";
    const HIGH = "ZZhighcommitZZ";
    // Published after the drain, and what the read stops on. Without a
    // terminator the read stops at the first frame it was looking for and
    // never observes what the drain wrote after it — which is exactly
    // where a second copy of an already-replayed frame appears.
    const END = "ZZdrainedZZ";

    // Created before the cursor is taken, so the replay carries no
    // `created` frame for any marker and a marker in the read can only
    // have come from the events published below.
    const lowItem = await createNote(LOW);
    const highItem = await createNote(HIGH);
    const endItem = await createNote(END);
    const cursor = await latestEventId();

    const gate = gateFirstRead();
    const heldLow = deferred();
    const publishedLow = deferred();
    let lowId: bigint | undefined;
    let highId: bigint | undefined;
    let lowTx: Promise<void> | undefined;

    try {
      const stream = await request(ctx.app, "GET", "/events", {
        key: ctx.spaceKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      expect(stream.status).toBe(200);

      const reading = readSse(stream, { until: (t) => t.includes(END) });
      // The read is the assertion. If the setup below throws first, its
      // eventual rejection must not surface as an unhandled one.
      void reading.catch(() => undefined);

      // Lets the subscription attach and the replay reach the gate, so
      // everything published below lands in the live buffer.
      await settle();

      // The lower id, assigned and emitted but deliberately not committed.
      lowTx = ctx.storage.runInTransaction(async () => {
        lowId = await publish({ type: "updated", item: lowItem });
        publishedLow.resolve();
        await heldLow.promise;
      });
      await publishedLow.promise;

      // The higher id, committed on return — so the gated read below sees
      // this row and cannot see the one above it.
      highId = await ctx.storage.runInTransaction(async () =>
        publish({ type: "updated", item: highItem }),
      );

      // `publish` returns no id when no event-log store is installed, and
      // the ids are the whole subject here — narrowed once rather than
      // asserted at each use below.
      if (lowId === undefined || highId === undefined) {
        throw new Error("publish appended no event id; the log is unwired");
      }
      // Carrying the weight of the whole arrangement: without it a run in
      // which the ids happened to come out in order would pass while
      // proving nothing about out-of-order commit.
      expect(lowId).toBeLessThan(highId);

      gate.open();
      const replayed = (await gate.rows).map((row) => row.id);
      // The premise, asserted rather than assumed: the read the gate
      // released is the replay's, it saw the committed higher id, and it
      // could not see the lower one because that transaction was open.
      expect(replayed).toContain(highId);
      expect(replayed).not.toContain(lowId);

      // Only now, so the replay's read genuinely could not see this row.
      heldLow.resolve();
      await lowTx;

      // The drain runs to completion before this is published, and SSE
      // preserves order, so a read that reaches this marker has read
      // everything the drain wrote. That is what lets the frame counts
      // below see a duplicate at all, and it also turns a dropped event
      // into an immediate assertion naming the missing frame rather than
      // an expired clock.
      await settle();
      await ctx.storage.runInTransaction(async () =>
        publish({ type: "updated", item: endItem }),
      );

      const { text } = await reading;

      // The higher id was replayed, and its live copy — buffered because
      // it was emitted after this connection subscribed — was withheld.
      // One frame, not two. Without this the suite would pass against a
      // replay that recorded nothing and sent everything twice.
      expect(text).toContain(HIGH);
      expect(frames(text, highId)).toBe(1);

      // The lower id committed after the replay's read, so the replay
      // cannot have sent it. It still reached the client, once, from the
      // live buffer rather than being discarded as already seen.
      expect(text).toContain(LOW);
      expect(frames(text, lowId)).toBe(1);
    } finally {
      // Unblocks whatever the body did not reach, in either order.
      gate.open();
      heldLow.resolve();
      if (lowTx) await lowTx.catch(() => undefined);
      gate.restore();
    }
  });

  it("delivers the live copy of a row the replay skipped, exactly once", async () => {
    const SKIPPED = "ZZskippedrowZZ";
    const END = "ZZskipdrainedZZ";

    const skippedItem = await createNote(SKIPPED);
    const endItem = await createNote(END);
    const cursor = await latestEventId();

    const gate = gateFirstRead();
    try {
      // `?type=` is what makes the replay decode a stored payload at all.
      // Without a filter it never parses, never skips, and the property
      // below has no way to arise — which is also why a suite run only
      // with an unfiltered platform key cannot tell recording-on-send
      // from recording-on-walk.
      const stream = await request(ctx.app, "GET", "/events?type=core.note", {
        key: ctx.spaceKey,
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

      // Now damage the stored row. The replay decodes it, fails, warns
      // and skips — while the buffered live copy is an object and is
      // untouched. This is the one skip whose live twin the stream can
      // still deliver, which makes it the only place the difference
      // between recording what was sent and recording what was walked is
      // observable.
      await pgQuery(
        `UPDATE event_log SET payload = 'not valid json' WHERE id = ${String(skippedId)}`,
      );

      gate.open();
      const replayed = (await gate.rows).map((row) => row.id);
      // The replay really did walk the damaged row; without this the test
      // could pass on a read that never reached it.
      expect(replayed).toContain(skippedId);

      await settle();
      await publish({ type: "updated", item: endItem });

      const { text } = await reading;
      // The marker cannot have come from the replay: the stored row no
      // longer contains it. Its presence is therefore proof that the
      // buffered live copy was delivered, which happens only because a
      // skipped row is not recorded as sent.
      expect(text).toContain(SKIPPED);
      expect(frames(text, skippedId)).toBe(1);
    } finally {
      gate.open();
      gate.restore();
    }
  });
});
