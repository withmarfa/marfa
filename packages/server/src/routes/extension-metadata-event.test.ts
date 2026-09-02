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
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";

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
function collectItemEvents(
  signal: AbortSignal,
  spaceId?: string,
): {
  events: ItemEventWithId[];
  done: Promise<void>;
} {
  const events: ItemEventWithId[] = [];
  const done = (async () => {
    try {
      // `spaceId` is the same filter `GET /events` applies for a scoped
      // viewer, so a frame published without one is invisible here too.
      for await (const event of subscribe({ signal, spaceId })) {
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
    //
    // This line passes vacuously on an absent or empty `metadata`, so it
    // is load-bearing only beside the tag assertion below — that one is
    // what proves a real metadata row arrived for the check to be about.
    expect(changes[0]?.metadata?.extensions.reader).toBeUndefined();
    expect(changes[0]?.metadata?.tags).toEqual(["kept"]);
  });
});

describe("the space a metadata.changed frame is delivered in", () => {
  /**
   * `GET /events` subscribes with the viewer's own `space_id`, so a frame
   * published without one — or with the wrong one — is dropped for every
   * real viewer while still being visible to a test that subscribes
   * unscoped. The two tests above subscribe unscoped under a platform
   * key, so they cannot see that difference at all. This one can.
   */
  it("reaches a viewer in the writing space and no viewer outside it", async () => {
    // Thrown rather than returned early. A skip here would report green
    // having proved nothing, and this is the one test covering the fence
    // every real viewer sits behind.
    const spaces = ctx.storage.spaces;
    if (!spaces) throw new Error("this test needs a space store");
    const spaceA = await spaces.create("ext-events-a");
    const spaceB = await spaces.create("ext-events-b");

    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "scoped" }, tags: ["kept"] },
      spaceA.id,
    );

    // A member in space A holding write on the namespace and nothing
    // else. The extension doors do not consult type permissions, so this
    // is the whole grant such a caller needs.
    const suffix = Math.random().toString(36).slice(2, 10);
    const memberKey = `marfa_k1_extspace_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `extspace-${suffix}`,
        source: `extspace-${suffix}`,
        role: "member",
        type_permissions: {},
        extension_permissions: { reader: "write" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(memberKey, TEST_API_KEY_SALT),
      spaceA.id,
    );

    const inA = new AbortController();
    const inB = new AbortController();
    const viewerA = collectItemEvents(inA.signal, spaceA.id);
    const viewerB = collectItemEvents(inB.signal, spaceB.id);
    await settle();

    const written = await request(
      ctx.app,
      "PUT",
      `/items/${item.id}/extensions/reader`,
      { key: memberKey, body: { offset: 7 } },
    );
    expect(written.status).toBe(200);
    const removed = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/extensions/reader`,
      { key: memberKey },
    );
    expect(removed.status).toBe(200);
    await settle();
    inA.abort();
    inB.abort();
    await viewerA.done;
    await viewerB.done;

    // Both doors, in the space that owns the row.
    expect(metadataEventsFor(viewerA.events, item.id)).toHaveLength(2);
    // And nothing at all next door. A publish carrying no space would
    // reach neither viewer, so the emptiness here is only meaningful
    // beside the count above.
    expect(metadataEventsFor(viewerB.events, item.id)).toHaveLength(0);
  });
});

describe("the reserved connection namespaces", () => {
  /**
   * Per-Connection runtime state is written by the machine, at dispatch
   * frequency, and the local integrations runtime writes the identical
   * blob straight through storage without publishing. Emitting here
   * would make the event depend on which substrate did the write, and
   * would put sync cursors and error tails on every `metadata.changed`
   * subscription that carries no type filter.
   */
  it("are written without announcing anything", async () => {
    // The gate admits only the connection's own runtime credential, so
    // the row has to be a real connection and the credential has to be
    // bound to it.
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const suffix = Math.random().toString(36).slice(2, 10);
    const runtimeKey = `marfa_k1_extruntime_${suffix}`;
    await ctx.storage.keys.createRuntimeCredential(
      {
        label: `extruntime-${suffix}`,
        source: `extruntime-${suffix}`,
        role: "member",
        type_permissions: {},
        connection_id: connection.id,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        item_source: runtimeCredentialItemSource({ name: "acme.fixture" }),
      },
      hashApiKey(runtimeKey, TEST_API_KEY_SALT),
      undefined,
    );

    const controller = new AbortController();
    const { events, done } = collectItemEvents(controller.signal);
    await settle();

    const res = await request(
      ctx.app,
      "PUT",
      `/items/${connection.id}/extensions/connection.runtime`,
      { key: runtimeKey, body: { cursor: "abc123" } },
    );
    // The write lands — this is silence, not refusal.
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    expect(metadataEventsFor(events, connection.id)).toHaveLength(0);
  });
});
