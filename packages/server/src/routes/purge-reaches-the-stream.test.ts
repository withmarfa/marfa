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
 * The retention sweep is deliberately not among them, and that absence is a
 * decision rather than a gap: it runs a 60-day cutoff against a 7-day event
 * log, so every row it removes fell out of the window before it was touched
 * and no client can still be reading from a cursor that would carry the
 * event. Rule 11's prune is what removes those.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  collectItemEvents,
  readSse,
  runBulkActionAsync,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
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
