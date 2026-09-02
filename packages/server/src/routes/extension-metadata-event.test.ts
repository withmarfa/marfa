/**
 * An extension write reaches another subscriber.
 *
 * The four metadata doors — `PUT` and `PATCH /items/{id}/metadata`, the
 * tag add and the tag remove — publish `metadata_changed`. The two
 * extension doors wrote the same metadata row and published nothing, so
 * an app that stored sidecar state through them changed a record no
 * second device was ever told about.
 *
 * **Asserted through a live subscriber rather than through the route's
 * return value.** The route already answered 200 with the new extensions
 * while nobody heard, which is precisely the shape a response-shaped
 * assertion cannot see. `subscribe` is what a second device actually is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subscribe } from "../pubsub.js";
import type { ItemEventWithId } from "../pubsub.js";
import { createTestContext, request } from "../test-utils.js";
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
    key: ctx.adminKey,
    body: {
      type: "core.note",
      properties: { body: "extension-event" },
      tags: ["kept"],
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/**
 * Collect item events until the abort fires.
 *
 * The generator is started and given a moment to attach before the write,
 * so the subscription is genuinely listening rather than racing it — a
 * listener registered after the publish hears nothing, and the test would
 * then pass or fail on scheduling.
 */
function collectItemEvents(signal: AbortSignal): {
  events: ItemEventWithId[];
  done: Promise<void>;
} {
  const events: ItemEventWithId[] = [];
  const done = (async () => {
    try {
      for await (const event of subscribe({ signal })) {
        events.push(event);
      }
    } catch {
      // The abort ends the generator; nothing to report.
    }
  })();
  return { events, done };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
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
      { key: ctx.adminKey, body: { offset: 1234 } },
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
    expect(changes[0]?.item.type).toBe("core.note");
  });

  it("is observed by a second subscriber when an extension is deleted", async () => {
    const itemId = await seedTaggedItem();
    const seeded = await request(
      ctx.app,
      "PUT",
      `/items/${itemId}/extensions/reader`,
      { key: ctx.adminKey, body: { offset: 1234 } },
    );
    expect(seeded.status).toBe(200);

    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${itemId}/extensions/reader`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    const changes = metadataEventsFor(events, itemId);
    expect(changes).toHaveLength(1);
    // A removal is as observable as a write. The namespace is gone from
    // the payload, which is how a subscriber learns to drop its copy.
    expect(changes[0]?.metadata?.extensions.reader).toBeUndefined();
    expect(changes[0]?.metadata?.tags).toEqual(["kept"]);
  });
});
