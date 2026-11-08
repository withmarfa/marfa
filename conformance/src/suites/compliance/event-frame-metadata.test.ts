import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import type { SseEvent } from "../../utils/sse.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let narrowKey: string;
let seen: string;
let unseen: string;
let tags: string[];

const FRAME_BUDGET_MS = 15_000;

const ITEM_EVENTS = [
  "item.created",
  "item.updated",
  "item.state_changed",
  "item.deleted",
  "item.restored",
  "item.purged",
] as const;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "event-frame-metadata",
  ));
  seen = `frame-seen-${ctx.runId}`;
  unseen = `frame-unseen-${ctx.runId}`;
  tags = [`frame-a-${ctx.runId}`, `frame-b-${ctx.runId}`];
  const key = await client.createKey({
    label: "event-frame-metadata-narrow",
    source: `${ctx.source}-narrow`,
    permissions: [],
    type_permissions: { "core.note": "read" },
    extension_permissions: { [seen]: "read" },
  });
  expect(key.ok).toBe(true);
  trackKey(ctx, key.data.id);
  narrowKey = key.data.key;
});

afterAll(async () => {
  await cleanup(ctx);
});

async function seed(body: string): Promise<string> {
  const made = await client.createItem(
    createNote({ source: ctx.source, properties: { body } }),
  );
  expect(made.ok).toBe(true);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function lifecycle(): Promise<string> {
  const made = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { body: "frame-metadata" },
      tags,
    }),
  );
  expect(made.ok).toBe(true);
  const id = made.data.item.id;
  trackItem(ctx, id);
  expect((await client.setItemExtension(id, seen, { a: 1 })).ok).toBe(true);
  expect((await client.setItemExtension(id, unseen, { b: 2 })).ok).toBe(true);
  const read = await client.getItem(id);
  expect(
    (
      await client.updateItem(id, {
        properties: { body: "after the update" },
        version: read.data.item.version,
      })
    ).ok,
  ).toBe(true);
  expect((await client.transitionItem(id, "archived")).ok).toBe(true);
  expect((await client.deleteItem(id)).ok).toBe(true);
  expect((await client.restoreItem(id)).ok).toBe(true);
  expect((await client.deleteItem(id)).ok).toBe(true);
  expect((await client.purgeItem(id)).ok).toBe(true);
  return id;
}

function rowOf(event: SseEvent): string | undefined {
  return (event.data as { item?: { id?: string } }).item?.id;
}

function carried(events: SseEvent[], id: string) {
  return events
    .filter((event) => rowOf(event) === id)
    .filter((event) => (ITEM_EVENTS as readonly string[]).includes(event.event))
    .map((event) => ({
      event: event.event,
      metadata: (
        event.data as {
          metadata?: { tags?: string[]; extensions?: Record<string, unknown> };
        }
      ).metadata,
    }));
}

function expectCarried(
  frames: ReturnType<typeof carried>,
  namespaces: Record<string, unknown>,
) {
  expect(frames.map((frame) => frame.event)).toEqual([
    "item.created",
    "item.updated",
    "item.state_changed",
    "item.deleted",
    "item.restored",
    "item.deleted",
    "item.purged",
  ]);
  const [created, ...later] = frames;
  expect([...(created?.metadata?.tags ?? [])].sort()).toEqual([...tags].sort());
  expect(created?.metadata?.extensions).toEqual({});
  for (const frame of later) {
    expect([...(frame.metadata?.tags ?? [])].sort(), frame.event).toEqual(
      [...tags].sort(),
    );
    expect(frame.metadata?.extensions, frame.event).toEqual(namespaces);
  }
}

async function collectLifecycle(
  stream: Parameters<typeof collectUntil>[0],
  witness: string,
  signal: AbortSignal,
): Promise<SseEvent[]> {
  const { events } = await collectUntil(
    stream,
    (events) => events.some((event) => rowOf(event) === witness),
    `the witness ${witness}`,
    AbortSignal.any([signal, AbortSignal.timeout(FRAME_BUDGET_MS * 2)]),
  );
  return events;
}

describe("event frame metadata", () => {
  it("carries on every item event the tags and extensions the write left, only the namespaces the subscriber may read, on a live stream", async ({
    signal,
  }) => {
    const frames = await liveFrames(signal);
    expectCarried(carried(frames.full, frames.id), {
      [seen]: { a: 1 },
      [unseen]: { b: 2 },
    });
    // The full subscriber witnesses the namespace withheld from the narrow subscriber.
    expectCarried(carried(frames.narrow, frames.id), { [seen]: { a: 1 } });
  });

  it("carries the same metadata on an event a stream replays", async ({
    signal,
  }) => {
    const { eventId } = await baselineEventId(
      apiUrl,
      apiKey,
      () => seed("replay-marker"),
      signal,
    );
    const id = await lifecycle();
    const witness = await seed("replay-witness");
    for (const [key, namespaces] of [
      [apiKey, { [seen]: { a: 1 }, [unseen]: { b: 2 } }],
      [narrowKey, { [seen]: { a: 1 } }],
    ] as const) {
      const events = await withStream(
        apiUrl,
        key,
        { lastEventId: eventId },
        (stream) => collectLifecycle(stream, witness, signal),
      );
      expectCarried(carried(events, id), namespaces);
    }
  });
});

async function liveFrames(signal: AbortSignal) {
  return withStream(apiUrl, apiKey, {}, (full) =>
    withStream(apiUrl, narrowKey, {}, async (narrow) => {
      // Allow both subscriptions to join before the first write.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const id = await lifecycle();
      const witness = await seed("live-witness");
      const [fullEvents, narrowEvents] = await Promise.all([
        collectLifecycle(full, witness, signal),
        collectLifecycle(narrow, witness, signal),
      ]);
      return { id, full: fullEvents, narrow: narrowEvents };
    }),
  );
}
