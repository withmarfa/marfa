/**
 * A reconnect's replay withholds only what it actually sent.
 *
 * `event_log.id` comes from a Postgres identity column, so the id is
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
 * which is the only thing double delivery can mean.
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
 * **What is real here and what is arranged.** Both transactions are real,
 * both ids come from the identity column, and the commit order is the
 * genuine article. The one thing the test arranges is *when* the replay
 * reads the log, by substituting `getAfter` with a gated wrapper — and
 * that is scheduling, which is exactly what varies in production. The
 * gate resolves only after the read has happened, so the lower id cannot
 * commit early and quietly turn this into a test of nothing.
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

/** The newest id in the log. Read rather than assumed: a fixed cursor
 *  trips the retention check and the stream then closes with
 *  `catchup_too_old` having replayed nothing. */
async function latestEventId(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 1000);
  return rows.reduce((max, row) => (row.id > max ? row.id : max), 0n);
}

async function createNote(marker: string): Promise<Item> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type: "core.note", properties: { body: marker } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: Item }).item;
}

describe.skipIf(!isPg)(
  "GET /events replay dedupe under out-of-order commit",
  () => {
    it("delivers a live event whose id is below one the replay already sent", async () => {
      const LOW = "ZZlowcommitZZ";
      const HIGH = "ZZhighcommitZZ";
      // Published after the drain, and what the read stops on. Without a
      // terminator the read stops at the first frame it was looking for
      // and never observes what the drain wrote after it — which is
      // exactly where a second copy of an already-replayed frame appears.
      const END = "ZZdrainedZZ";

      // Created before the cursor is taken, so the replay has no `created`
      // frame carrying either marker and a marker in the read can only have
      // come from the events published below.
      const lowItem = await createNote(LOW);
      const highItem = await createNote(HIGH);
      const endItem = await createNote(END);
      const cursor = await latestEventId();

      // Park the replay's first read. `getMinRetainedId` runs ahead of it
      // and is left alone, so the stale-cursor check still happens for real.
      const openGate = deferred();
      const readHappened = deferred();
      const store = ctx.storage.eventLog;
      const realGetAfter = store.getAfter.bind(store);
      let gated = false;
      store.getAfter = async (
        afterId: bigint,
        limit: number,
        spaceId?: string,
      ): Promise<PersistedEvent[]> => {
        if (gated) return realGetAfter(afterId, limit, spaceId);
        gated = true;
        await openGate.promise;
        const rows = await realGetAfter(afterId, limit, spaceId);
        readHappened.resolve();
        return rows;
      };

      const heldLow = deferred();
      const publishedLow = deferred();
      let lowId: bigint | undefined;
      let highId: bigint | undefined;
      let lowTx: Promise<void> | undefined;

      try {
        const stream = await request(ctx.app, "GET", "/events", {
          key: ctx.adminKey,
          headers: { "Last-Event-ID": String(cursor) },
        });
        expect(stream.status).toBe(200);

        const reading = readSse(stream, {
          until: (t) => t.includes(END),
          // Explicit and under the suite's own 20s budget. Left at the
          // helper's default the two are equal, vitest expires first, and
          // the failure arrives as a bare timeout naming no condition.
          timeoutMs: 10_000,
        });
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

        // `publish` returns no id when no event-log store is installed,
        // and the ids are the whole subject here — narrowed once rather
        // than asserted at each use below.
        if (lowId === undefined || highId === undefined) {
          throw new Error("publish appended no event id; the log is unwired");
        }
        // Carrying the weight of the whole arrangement: without it a run
        // in which the ids happened to come out in order would pass while
        // proving nothing about out-of-order commit.
        expect(lowId).toBeLessThan(highId);

        openGate.resolve();
        await readHappened.promise;
        // Only now, so the replay's read genuinely could not see this row.
        heldLow.resolve();
        await lowTx;

        // The drain runs to completion before this is published, and SSE
        // preserves order, so a read that reaches this marker has read
        // everything the drain wrote. That is what lets the frame counts
        // below see a duplicate at all, and it also turns a dropped event
        // into an immediate assertion naming the missing frame rather
        // than an expired clock.
        await settle();
        await ctx.storage.runInTransaction(async () =>
          publish({ type: "updated", item: endItem }),
        );

        const { text } = await reading;
        // Exact frame counts rather than `toContain`, holding the two
        // halves of one rule. Counting also keeps the id assertions
        // honest: a substring test for `id: 4` matches `id: 41` too.
        const frames = (id: bigint): number =>
          text.split("\n").filter((line) => line === `id: ${String(id)}`)
            .length;

        // The higher id was replayed, and its live copy — buffered
        // because it was emitted after this connection subscribed — was
        // withheld. One frame, not two. Without this the suite would
        // pass against a replay that recorded nothing and sent
        // everything twice.
        expect(text).toContain(HIGH);
        expect(frames(highId)).toBe(1);

        // The lower id committed after the replay's read, so the replay
        // cannot have sent it. It still reached the client, once, from
        // the live buffer rather than being discarded as already seen.
        expect(text).toContain(LOW);
        expect(frames(lowId)).toBe(1);
      } finally {
        // Unblocks whatever the body did not reach, in either order.
        openGate.resolve();
        heldLow.resolve();
        if (lowTx) await lowTx.catch(() => undefined);
        store.getAfter = realGetAfter;
      }
    });
  },
);
