/**
 * An extension write reaches another subscriber.
 *
 * The four metadata doors — `PUT` and `PATCH /items/{id}/metadata`, the
 * tag add and the tag remove — publish `metadata_changed`. The two
 * extension doors wrote the same metadata row and published nothing, so
 * an app that stored sidecar state through them changed a record no
 * second device was ever told about.
 *
 * The last case here is about the item the event carries rather than
 * the metadata: the doors read the item to authorize the request, and
 * that snapshot predates the write.
 *
 * **Asserted through a live subscriber rather than through the route's
 * return value.** The route already answered 200 with the new extensions
 * while nobody heard, which is precisely the shape a response-shaped
 * assertion cannot see. `subscribe` is what a second device actually is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ItemEventWithId } from "../pubsub.js";
import {
  createTestContext,
  request,
  collectItemEvents,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** An item carrying one tag, so the event can be checked for the whole
 *  metadata row rather than only the half the write touched. */
async function seedTaggedItem(): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: {
      type: "core.note",
      properties: { body: "extension-event" },
      tags: ["kept"],
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/** Events this test's own item produced. Sibling tests in the same worker
 *  publish onto the same emitter, so the item id is the filter. */
function metadataEventsFor(
  events: ItemEventWithId[],
  itemId: string,
): ItemEventWithId[] {
  return events.filter(
    (e) => e.type === "metadata_changed" && e.item.id === itemId,
  );
}

/** Old enough that no clock skew could produce it, so "the payload is
 *  not the pre-write value" has one possible answer. */
const PINNED = "2000-01-01T00:00:00.000Z";

/** Forces an item's `updated_at` through the dialect escape hatch. Every
 *  write path stamps `now`, so a contrived value is the only way to make
 *  the pre-write and post-write timestamps reliably distinguishable. */
async function forceUpdatedAt(itemId: string, iso: string): Promise<void> {
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  await s.__sqliteRun("UPDATE items SET updated_at = ? WHERE id = ?", [
    iso,
    itemId,
  ]);
}

describe("metadata.changed on an extension write", () => {
  it("is observed by a second subscriber when an extension is replaced", async () => {
    const itemId = await seedTaggedItem();
    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${itemId}/extensions/reader`,
      { key: ctx.spaceKey, body: { offset: 1234 } },
    );
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const changes = metadataEventsFor(events, itemId);
    expect(changes).toHaveLength(1);
    // The written payload rides the event. A subscriber that had to
    // re-fetch the namespace would defeat the point of emitting one.
    expect(changes[0]?.metadata?.extensions.reader).toEqual({ offset: 1234 });
    // And the rest of the metadata row with it, so this event is the same
    // shape the four tag and metadata doors already publish rather than a
    // second, thinner one a consumer would have to special-case.
    expect(changes[0]?.metadata?.tags).toEqual(["kept"]);
  });

  it("is observed by a second subscriber when an extension is deleted", async () => {
    const itemId = await seedTaggedItem();
    const seeded = await request(
      ctx.app,
      "PUT",
      `/items/${itemId}/extensions/reader`,
      { key: ctx.spaceKey, body: { offset: 1234 } },
    );
    expect(seeded.status).toBe(200);

    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${itemId}/extensions/reader`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const changes = metadataEventsFor(events, itemId);
    expect(changes).toHaveLength(1);
    // A removal is as observable as a write. The namespace is gone from
    // the payload, which is how a subscriber learns to drop its copy.
    //
    // This line passes vacuously on an absent or empty `metadata`, so it
    // is load-bearing only beside the tag assertion below — that one is
    // what proves a real metadata row arrived for the check to be about.
    expect(changes[0]?.metadata?.extensions.reader).toBeUndefined();
    expect(changes[0]?.metadata?.tags).toEqual(["kept"]);
  });
});

describe("the item the event carries is the item after the write", () => {
  /**
   * Every metadata door reads the item first, to authorize against it,
   * and that read happens before the write. Publishing that snapshot
   * tells a subscriber the item last changed before the change it is
   * being told about, so a second device merging the frame over its own
   * copy records a modification time the server has already passed —
   * and a later catch-up from that time asks for work already done.
   *
   * One case rather than six: `itemAfterMetadataWrite` is the same
   * helper on all four tag doors and both extension doors.
   *
   * The item is pinned to a contrived past timestamp first, so "the
   * payload is not the pre-write value" is a stable question rather than
   * a race against millisecond resolution.
   */
  it("publishes the modification time the write produced, not the one it read", async () => {
    const itemId = await seedTaggedItem();
    await forceUpdatedAt(itemId, PINNED);

    const before = await ctx.storage.items.get(itemId);
    expect(before?.updated_at).toBe(PINNED);

    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${itemId}/extensions/reader`,
      { key: ctx.spaceKey, body: { offset: 99 } },
    );
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const changes = metadataEventsFor(events, itemId);
    expect(changes).toHaveLength(1);

    const stored = await ctx.storage.items.get(itemId);
    // The write moved it, so the two candidate answers are distinct and
    // the assertion below is deciding between them rather than passing
    // on a coincidence.
    expect(stored?.updated_at).not.toBe(PINNED);
    expect(changes[0]?.item.updated_at).toBe(stored?.updated_at);
    expect(changes[0]?.item.updated_at).not.toBe(PINNED);
  });
});
