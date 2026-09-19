import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import {
  openEventStream,
  type EventStream,
  type SseEvent,
} from "../../utils/sse.js";
import {
  baselineEventId,
  collectUntil,
  withStream,
} from "../../utils/stream.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "events-contract",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function seed(body: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

/** Open a stream, run `act`, and collect until an event for `id` named `name` arrives. */
async function deliver(
  name: string,
  id: string,
  act: () => Promise<void>,
  signal: AbortSignal,
) {
  // One predicate for both the wait and the pick. Waiting on name-and-id and
  // then returning the first frame of that name alone hands the caller a
  // stranger's event whenever another row of the same kind is announced in
  // the same window, and every assertion below reads as a server fault.
  const matches = (e: SseEvent): boolean => {
    const data = e.data as { item?: { id?: string }; edge?: { id?: string } };
    return e.event === name && (data.item?.id === id || data.edge?.id === id);
  };
  const stream: EventStream = await openEventStream(apiUrl, apiKey);
  expect(stream.response.status).toBe(200);
  try {
    await act();
    const { events } = await collectUntil(
      stream,
      (events) => events.some(matches),
      `${name} for ${id}`,
      signal,
    );
    return events.find(matches);
  } finally {
    await stream.close();
  }
}

describe("event stream contract", () => {
  it("opens with a stream_cursor frame naming the log head", async ({
    signal,
  }) => {
    // The head is only observable by causing an event and reading the id the
    // server gave it, which is what this helper does; the cursor the next
    // subscription announces is then a value with something to disagree with.
    const head = await baselineEventId(
      apiUrl,
      apiKey,
      () => seed("cursor-head"),
      signal,
    );

    const stream = await openEventStream(apiUrl, apiKey, {
      connectTimeoutMs: 30_000,
    });
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    try {
      const { events } = await collectUntil(
        stream,
        (events) => events.length > 0,
        "the subscription's first typed frame",
        signal,
      );
      expect(events[0].event).toBe("stream_cursor");
      const data = events[0].data as { type: string; cursor: string };
      expect(data.type).toBe("stream_cursor");
      expect(data.cursor).toBe(head.eventId);
      expect(events[0].id).toBeUndefined();
    } finally {
      await stream.close();
    }
  });

  it("withholds edge events under edges=none and announces them under edges=all", async ({
    signal,
  }) => {
    const a = await seed("edges-filter-a");

    // A target of its own per mode, so the second write is a create rather
    // than a repeat of an edge the first already made.
    const edgeAnnounced = async (mode: string): Promise<boolean> => {
      const b = await seed(`edges-filter-${mode}-target`);
      return withStream(
        apiUrl,
        apiKey,
        { query: [["edges", mode]] },
        async (stream) => {
          // Let the subscription settle before the write, or the event it is
          // meant to observe is published to nobody.
          await new Promise((r) => setTimeout(r, 250));
          const edge = await client.createEdge({
            source_id: a,
            target_id: b,
            edge_type: "references",
          });
          expect(edge.ok).toBe(true);
          trackEdge(ctx, edge.data.edge.id);

          // The sentinel is an item, announced under either value of `edges`,
          // and the server draws every frame's id from one counter: a sentinel
          // written after the edge therefore carries a higher id, so its
          // arrival proves an edge frame for the write before it is not merely
          // late. No edge sentinel exists here, because under `edges=none` it
          // could not arrive either.
          const sentinel = await seed(`edges-${mode}-sentinel`);
          const { events } = await collectUntil(
            stream,
            (evts) =>
              evts.some(
                (e) =>
                  (e.data as { item?: { id?: string } }).item?.id === sentinel,
              ),
            `the ${mode} sentinel item ${sentinel}`,
            signal,
          );
          return events.some(
            (e) =>
              (e.data as { edge?: { id?: string } }).edge?.id ===
              edge.data.edge.id,
          );
        },
      );
    };

    expect(await edgeAnnounced("none")).toBe(false);
    expect(await edgeAnnounced("all")).toBe(true);
  });

  it("announces item.restored when a trashed item comes back", async ({
    signal,
  }) => {
    const id = await seed("restored");
    expect((await client.deleteItem(id)).ok).toBe(true);
    const event = await deliver(
      "item.restored",
      id,
      async () => {
        expect((await client.restoreItem(id)).ok).toBe(true);
      },
      signal,
    );
    const data = event?.data as { item: { id: string; state: string } };
    expect(data.item.id).toBe(id);
    expect(data.item.state).toBe("active");
  });

  it("announces item.state_changed on a lifecycle transition", async ({
    signal,
  }) => {
    const id = await seed("archived");
    const event = await deliver(
      "item.state_changed",
      id,
      async () => {
        expect((await client.transitionItem(id, "archived")).ok).toBe(true);
      },
      signal,
    );
    const data = event?.data as { item: { id: string; state: string } };
    expect(data.item.state).toBe("archived");
  });

  it("announces metadata.changed on a tag write", async ({ signal }) => {
    const id = await seed("tagged");
    const event = await deliver(
      "metadata.changed",
      id,
      async () => {
        expect((await client.addTags(id, [`evt-${ctx.runId}`])).ok).toBe(true);
      },
      signal,
    );
    const data = event?.data as {
      item: { id: string };
      metadata?: { tags: string[] };
    };
    expect(data.item.id).toBe(id);
    expect(data.metadata?.tags).toContain(`evt-${ctx.runId}`);
  });

  it("announces edge.updated when an edge's properties change", async ({
    signal,
  }) => {
    const a = await seed("edge-a");
    const b = await seed("edge-b");
    const edge = await client.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
      properties: { note: "before" },
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
    const event = await deliver(
      "edge.updated",
      edge.data.edge.id,
      async () => {
        expect(
          (
            await client.updateEdge(edge.data.edge.id, {
              properties: { note: "after" },
              version: edge.data.edge.version,
            })
          ).ok,
        ).toBe(true);
      },
      signal,
    );
    const data = event?.data as {
      edge: { id: string; properties: Record<string, unknown> };
    };
    expect(data.edge.id).toBe(edge.data.edge.id);
    expect(data.edge.properties.note).toBe("after");
  });

  it("refuses a wildcard type filter, a type outside the grammar, an unknown edges value and more than ten types", async () => {
    const bearer = { Authorization: `Bearer ${apiKey}` };
    const wildcard = await fetch(`${apiUrl}/events?type=*`, {
      headers: bearer,
    });
    expect(wildcard.status).toBe(400);
    expect(
      ((await wildcard.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");

    const malformed = await fetch(`${apiUrl}/events?type=Not-A-Type!`, {
      headers: bearer,
    });
    expect(malformed.status).toBe(400);
    expect(
      ((await malformed.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");

    const edges = await fetch(`${apiUrl}/events?edges=bogus`, {
      headers: bearer,
    });
    expect(edges.status).toBe(400);
    expect(
      ((await edges.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");

    const eleven = Array.from({ length: 11 }, (_, i) => `core.note${i}`).join(
      ",",
    );
    const tooMany = await fetch(`${apiUrl}/events?type=${eleven}`, {
      headers: bearer,
    });
    expect(tooMany.status).toBe(400);
    expect(
      ((await tooMany.json()) as { error: { code: string } }).error.code,
    ).toBe("validation_error");
  });

  it("refuses a subscription with no credential", async () => {
    const r = await fetch(`${apiUrl}/events`);
    expect(r.status).toBe(401);
  });
});
