/**
 * A purge tells the stream the row is gone.
 *
 * Trashing an item announces `item.deleted`, and a client that hears it
 * knows the row is recoverable. The purge behind it announced nothing, so
 * the same client held a trashed row forever: no later event corrects it,
 * because the row is absent rather than changed, and only a full re-import
 * would have found out. A device that was offline across the purge never
 * learned it happened at all.
 *
 * **The subscriber is the only place this shows.** Every purge door already
 * answered 200 while publishing nothing about the item, and the cascade's
 * edge events say nothing about the item they hung off — an item with no
 * edges cascades nothing and was therefore completely silent.
 *
 * **Two doors, because a purge has two ways in.** The single-item route and
 * the bulk action share no code, so covering one proves nothing about the
 * other; the bulk door is the one whose silence costs the most, because it
 * removes thousands of rows per call.
 *
 * **The retention sweeps announce too.** `trash_retention_days` and
 * `event_log_retention_hours` are set independently, so a sweep can purge a
 * row inside the window a device resumes from, and a device that never hears
 * of it keeps the row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  collectEdgeEvents,
  collectItemEvents,
  readSse,
  runBulkActionAsync,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
import { RevokedGrantPurger, TrashPurger } from "../storage/retention.js";
import { itemWrites } from "../storage/item-writes.js";
import type { ItemEventWithId } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this `publish` appends nothing, and the replay case below would
  // have no rows to read — passing for a reason unrelated to the property.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/**
 * Watch the item stream across `act` and return what it heard.
 *
 * `settle` on both sides rather than an awaited arrival: every assertion
 * below is partly a count, and "exactly one, and nothing else" cannot be
 * awaited. Each door publishes before it answers, so the collector attached
 * here has the frame by the time `act` resolves.
 */
async function itemEventsDuring(
  act: () => Promise<void>,
): Promise<ItemEventWithId[]> {
  const controller = new AbortController();
  const { events, done } = collectItemEvents(controller.signal);
  await settle();
  await act();
  await settle();
  controller.abort();
  await done;
  return events;
}

function maxBigInt(values: bigint[]): bigint {
  return values.reduce((a, b) => (a > b ? a : b), 0n);
}

/** The highest event-log id written so far — a client's cursor. */
async function currentCursor(): Promise<bigint> {
  let cursor = 0n;
  for (;;) {
    const rows = await ctx.storage.eventLog.getAfter(cursor, 200);
    if (rows.length === 0) return cursor;
    cursor = maxBigInt(rows.map((r) => r.id));
  }
}

describe("a purge reaches the stream", () => {
  it("the single-item door announces the item it removed", async () => {
    const doomed = await note("purge-announced");
    await request(ctx.app, "DELETE", `/items/${doomed}`, {
      key: ctx.workingKey,
    });

    // No edges anywhere near it. The cascade's edge events are what this
    // door already published, and an item with none of them was silent
    // outright — which is the case the edge suite cannot reach.
    const heard = await itemEventsDuring(async () => {
      const res = await request(ctx.app, "POST", `/items/${doomed}/purge`, {
        key: ctx.workingKey,
      });
      expect(res.status).toBe(200);
    });

    const mine = heard.filter((e) => e.item.id === doomed);
    expect(mine.map((e) => e.type)).toEqual(["purged"]);
    // The whole row, not a stub: a subscriber deciding what to drop reads
    // the type off the payload, and a bare id tells it nothing.
    expect(mine[0]?.item.type).toBe("core.note");
  });

  it("the bulk door announces every item it removed", async () => {
    const tag = `purged-${Math.random().toString(36).slice(2, 8)}`;
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "bulk-purge-announced" },
        tags: [tag],
      },
    });
    expect(seed.status).toBe(201);
    const doomed = ((await seed.json()) as { item: { id: string } }).item.id;
    await request(ctx.app, "DELETE", `/items/${doomed}`, {
      key: ctx.workingKey,
    });

    const heard = await itemEventsDuring(async () => {
      const run = await runBulkActionAsync(
        ctx,
        {
          action: "purge",
          confirm: "PURGE",
          filter: { tags: [tag], state: "trashed" },
        },
        ctx.workingKey,
      );
      expect(run.result?.succeeded).toBe(1);
    });

    expect(
      heard.filter((e) => e.item.id === doomed).map((e) => e.type),
    ).toEqual(["purged"]);
  });

  it("reaches a client that was away, under the name it publishes", async () => {
    const doomed = await note("purge-replayed");
    await request(ctx.app, "DELETE", `/items/${doomed}`, {
      key: ctx.workingKey,
    });

    // Where the client's cursor stood when it went away.
    const cursor = await currentCursor();

    const res = await request(ctx.app, "POST", `/items/${doomed}/purge`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);

    const stream = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(stream.status).toBe(200);
    const { text } = await readSse(stream, {
      until: (t) => t.includes(doomed) && t.includes("item.purged"),
    });
    // The wire name, because that is what a client matches on and it is
    // derived rather than written down: a union member added without a
    // mapping would replay under a name nobody subscribes to.
    expect(text).toContain("event: item.purged");
  });

  describe("the trash sweep", () => {
    const DAY = 86_400_000;

    /** A sweep run a week after the row entered the bin, against a retention
     *  of one day. */
    function sweepLater(): Promise<number> {
      return new TrashPurger(
        ctx.storage,
        1,
        () => new Date(Date.now() + 7 * DAY),
      ).runOnce();
    }

    it("announces the item and each edge it removed, as the doors do", async () => {
      const doomed = await note("sweep-announced");
      const other = await note("sweep-neighbor");
      const edgeRes = await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: { source_id: other, target_id: doomed, edge_type: "references" },
      });
      expect(edgeRes.status).toBe(201);
      const edgeId = ((await edgeRes.json()) as { edge: { id: string } }).edge
        .id;
      await request(ctx.app, "DELETE", `/items/${doomed}`, {
        key: ctx.workingKey,
      });

      const itemController = new AbortController();
      const items = collectItemEvents(itemController.signal);
      const edgeController = new AbortController();
      const edges = collectEdgeEvents(edgeController.signal);
      await settle();
      expect(await sweepLater()).toBe(1);
      await settle();
      itemController.abort();
      edgeController.abort();
      await Promise.all([items.done, edges.done]);

      const heardItems = items.events.filter((e) => e.item.id === doomed);
      expect(heardItems.map((e) => e.type)).toEqual(["purged"]);
      expect(heardItems[0]?.item.type).toBe("core.note");
      expect(
        edges.events.map((e) => [e.type, e.edge.id, e.purgedWith]),
      ).toEqual([["edge_deleted", edgeId, doomed]]);
    });

    it("reaches a client that was away across it", async () => {
      const doomed = await note("sweep-replayed");
      await request(ctx.app, "DELETE", `/items/${doomed}`, {
        key: ctx.workingKey,
      });
      const cursor = await currentCursor();

      expect(await sweepLater()).toBe(1);

      const stream = await request(ctx.app, "GET", "/events", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      expect(stream.status).toBe(200);
      const { text } = await readSse(stream, {
        until: (t) => t.includes(doomed) && t.includes("item.purged"),
      });
      expect(text).toContain("event: item.purged");
    });

    it("leaves a row inside its window unannounced, and in the bin", async () => {
      const kept = await note("sweep-kept");
      await request(ctx.app, "DELETE", `/items/${kept}`, {
        key: ctx.workingKey,
      });
      const cursor = await currentCursor();

      const purged = await new TrashPurger(ctx.storage, 60).runOnce();

      expect(purged).toBe(0);
      expect(await currentCursor()).toBe(cursor);
      expect(await ctx.storage.items.getIncludingTrashed(kept)).not.toBeNull();
    });
  });

  it("the revoked-grant sweep announces the grant row it removed", async () => {
    const grant = await itemWrites(ctx.storage).create({
      type: "system.connection",
      properties: {
        kind: "app",
        status: "revoked",
        granted_at: "2019-01-01T00:00:00.000Z",
        revoked_at: "2020-01-01T00:00:00.000Z",
        client_id: "swept-client",
      },
    });
    const cursor = await currentCursor();

    expect(await new RevokedGrantPurger(ctx.storage, 90).runOnce()).toBe(1);

    const logged = await ctx.storage.eventLog.getAfter(cursor, 200);
    expect(
      logged
        .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
        .map((frame) => [
          frame.event_type,
          (frame.item as { id: string } | undefined)?.id,
        ]),
    ).toEqual([["item.purged", grant.id]]);
  });

  it("is a name a webhook may subscribe to", async () => {
    // The runtime vocabulary is a closed set. A published event nobody can
    // subscribe to reaches the stream and stops there.
    const res = await request(ctx.app, "POST", "/webhooks", {
      key: ctx.workingKey,
      body: {
        url: "https://example.com/purged",
        events: ["item.purged"],
      },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});
