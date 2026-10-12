import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";
import type { SseEvent } from "../../utils/sse.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ client, ctx, apiUrl, apiKey } = await createTestContext(
    "sync",
    "authority-consumption",
  ));
});
afterAll(async () => {
  await cleanup(ctx);
});

async function item(
  type: "core.note" | "core.task",
  marker: string,
): Promise<string> {
  const res = await client.createItem({
    type,
    source: ctx.source,
    properties: type === "core.note" ? { body: marker } : { title: marker },
  });
  expect(res.ok).toBe(true);
  trackItem(ctx, res.data.item.id);
  return res.data.item.id;
}

function itemId(event: SseEvent): string | undefined {
  return (event.data as { item?: { id?: string } }).item?.id;
}

describe("replay authority consumption", () => {
  it("filters replay under current authority and delivers future events after widening", async (context) => {
    const minted = await client.createKey({
      label: "Replay authority viewer",
      source: `${ctx.source}-viewer`,
      type_permissions: { "core.note": "read" },
      edge_permissions: {},
      extension_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      permissions: [],
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const { eventId } = await baselineEventId(
      apiUrl,
      apiKey,
      () => item("core.note", "authority-seed"),
      context.signal,
    );
    const withheld = await item("core.task", "authority-withheld");
    const higher = await item("core.note", "authority-higher");
    // The same backlog under a wider key is the witness that the task
    // is replayable before its absence is attributed to narrow authority.
    const witness = await withStream(
      apiUrl,
      apiKey,
      { lastEventId: eventId },
      (stream) =>
        collectUntil(
          stream,
          (events) => events.some((event) => event.event === "stream_live"),
          "the wider replay's live marker",
          context.signal,
        ),
    );
    expect(witness.events.some((event) => itemId(event) === withheld)).toBe(
      true,
    );

    await withStream(
      apiUrl,
      minted.data.key,
      { lastEventId: eventId },
      async (stream) => {
        const replay = await collectUntil(
          stream,
          (events) => events.some((event) => event.event === "stream_live"),
          "the replay's live marker",
          context.signal,
        );
        expect(replay.events.some((event) => itemId(event) === higher)).toBe(
          true,
        );
        expect(replay.events.some((event) => itemId(event) === withheld)).toBe(
          false,
        );
        const live = replay.events.find(
          (event) => event.event === "stream_live",
        )!;
        const cursor = (live.data as { cursor: string }).cursor;
        const higherEvent = replay.events.find(
          (event) => itemId(event) === higher,
        )!;
        expect(BigInt(cursor) >= BigInt(higherEvent.id!)).toBe(true);
        expect(
          (
            await client.updateKey(minted.data.id, {
              type_permissions: { "core.note": "read", "core.task": "read" },
            })
          ).ok,
        ).toBe(true);
        const future = await item("core.task", "authority-future");
        const widened = await collectUntil(
          stream,
          (events) => events.some((event) => itemId(event) === future),
          "a new task after authority widened",
          context.signal,
        );
        expect(widened.events.some((event) => itemId(event) === withheld)).toBe(
          false,
        );
        const delivered = widened.events.find(
          (event) => itemId(event) === future,
        )!;
        expect(BigInt(delivered.id!) > BigInt(cursor)).toBe(true);
      },
    );
  });
});
