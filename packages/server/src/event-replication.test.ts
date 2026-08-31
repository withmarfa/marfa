/**
 * Tests for cross-process event replication, against a real Postgres:
 * the properties under test — pg_notify round-trips, hydration from
 * event_log, self-announcement skipping — live in the database and the
 * emitter, not in this module's control flow.
 *
 * The two-process shape cannot be tested inside one process (the emitter
 * is a module singleton, so a second "process" here would share it and
 * prove nothing). Instead each seam is pinned on the real path it takes:
 * the announcement over a genuine second connection's LISTEN, and the
 * handler driven directly with foreign and own origins.
 */
import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { cloneTemplate } from "./storage/pg/test-template.js";
import type { PgDb } from "./storage/pg/connection.js";
import { createPgStorage } from "./storage/pg/index.js";
import {
  createPgEventNotifier,
  handleAnnouncement,
  eventFromRow,
  EVENT_CHANNEL,
  PROCESS_ORIGIN,
} from "./event-replication.js";
import {
  initEventLog,
  publish,
  subscribe,
  emitWake,
  __resetCycleDetectionForTests,
  type ItemEventWithId,
} from "./pubsub.js";
import type { Item } from "@withmarfa/shared";

const isPg = process.env.DB_DIALECT === "pg";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function makeItem(id: string): Item {
  const now = new Date().toISOString();
  return {
    id,
    type: "core.note",
    state: "active",
    tier: "library",
    properties: { title: "replication probe" },
    created_at: now,
    updated_at: now,
    version: 1,
    source: "test",
    schema_version: 1,
  } as unknown as Item;
}

describe.skipIf(!isPg)("event replication over pg_notify", () => {
  it("announces a published event on the channel with its event_log id", async () => {
    const clone = await cloneTemplate();
    let storage: Awaited<ReturnType<typeof createPgStorage>> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const listenerClient = postgres(clone.url, { max: 2, onnotice: () => {} });
    try {
      storage = await createPgStorage(clone.url, { authMode: "keys" });
      // `pgDb` is typed `unknown` on the Storage interface for dialect
      // portability; this suite is PG-gated, so the cast is the truth.
      initEventLog(storage.eventLog, {
        notifyRemote: createPgEventNotifier(storage.pgDb as PgDb),
      });

      const received: string[] = [];
      await listenerClient.listen(EVENT_CHANNEL, (raw) => {
        received.push(raw);
      });

      const eventId = await publish({
        type: "created",
        item: makeItem("01976f00-0000-7000-8000-00000000aaaa"),
      });
      expect(eventId).toBeDefined();

      // Generous relative to a healthy notify round trip because this
      // machine also hosts the CI pool; the 30s test timeout stays the
      // hard stop.
      while (received.length === 0) {
        await sleep(50);
      }
      expect(received.length).toBe(1);
      const announcement = JSON.parse(received[0] ?? "{}") as {
        i: string;
        o: string;
      };
      expect(announcement.i).toBe(String(eventId));
      expect(announcement.o).toBe(PROCESS_ORIGIN);
    } finally {
      __resetCycleDetectionForTests();
      await listenerClient.end();
      await storage?.close();
      await clone.drop();
    }
  }, 30_000);

  it("hydrates a foreign announcement from event_log and re-emits it marked remote", async () => {
    const clone = await cloneTemplate();
    let storage: Awaited<ReturnType<typeof createPgStorage>> | null = null;
    try {
      storage = await createPgStorage(clone.url, { authMode: "keys" });
      const item = makeItem("01976f00-0000-7000-8000-00000000bbbb");
      const eventId = await storage.eventLog.append({
        event_type: "created",
        item_id: item.id,
        space_id: undefined,
        payload: JSON.stringify({ type: "item.created", item }),
        originating_connection_id: null,
        hop_count: 0,
      });

      const collected: ItemEventWithId[] = [];
      const iterator = subscribe();
      const collector = (async () => {
        for await (const event of iterator) {
          collected.push(event);
          break;
        }
      })();

      await handleAnnouncement(
        JSON.stringify({ i: String(eventId), o: "another-process" }),
        storage.eventLog,
      );
      await collector;

      expect(collected.length).toBe(1);
      const event = collected[0];
      expect(event?.remote).toBe(true);
      expect(event?.eventId).toBe(eventId);
      expect(event?.type).toBe("created");
      expect(event?.item.id).toBe(item.id);
    } finally {
      await storage?.close();
      await clone.drop();
    }
  }, 30_000);

  it("skips its own announcements: the local emit already served this process", async () => {
    const clone = await cloneTemplate();
    let storage: Awaited<ReturnType<typeof createPgStorage>> | null = null;
    try {
      storage = await createPgStorage(clone.url, { authMode: "keys" });
      const item = makeItem("01976f00-0000-7000-8000-00000000cccc");
      const eventId = await storage.eventLog.append({
        event_type: "created",
        item_id: item.id,
        payload: JSON.stringify({ type: "item.created", item }),
      });

      // The collector exits on a wake sentinel rather than by
      // iterator.return(): a generator suspended on an event that never
      // arrives does not unwind on return() until something emits, which
      // is the same hazard the reactive bridges solve the same way.
      let emitted = 0;
      const iterator = subscribe();
      const collector = (async () => {
        for await (const event of iterator) {
          if (event.item.id === "test-wake") break;
          emitted += 1;
        }
      })();

      await handleAnnouncement(
        JSON.stringify({ i: String(eventId), o: PROCESS_ORIGIN }),
        storage.eventLog,
      );
      await sleep(200);
      emitWake({
        type: "updated",
        item: makeItem("test-wake"),
        originatingConnectionId: null,
        hopCount: 0,
      });
      await collector;
      expect(emitted).toBe(0);
    } finally {
      await storage?.close();
      await clone.drop();
    }
  }, 30_000);
});

describe("eventFromRow", () => {
  const base = {
    id: 7n,
    space_id: null,
    originating_connection_id: null,
    hop_count: 0,
  };

  it("rebuilds an item event", () => {
    const item = makeItem("01976f00-0000-7000-8000-00000000dddd");
    const event = eventFromRow({
      ...base,
      event_type: "updated",
      payload: JSON.stringify({ type: "item.updated", item }),
    });
    expect(event?.type).toBe("updated");
    expect(event && "item" in event && event.item.id).toBe(item.id);
    expect(event?.eventId).toBe(7n);
  });

  it("rebuilds an edge event", () => {
    const edge = { id: "edge-1", type: "references" } as never;
    const event = eventFromRow({
      ...base,
      event_type: "edge_created",
      payload: JSON.stringify({ type: "edge.created", edge }),
    });
    expect(event?.type).toBe("edge_created");
  });

  it("returns null for an unrecognized event type rather than guessing", () => {
    expect(
      eventFromRow({
        ...base,
        event_type: "someday_new_kind",
        payload: "{}",
      }),
    ).toBeNull();
  });
});
