import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackKey,
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

/**
 * How long one frame is waited for before the wait is called off.
 *
 * Well inside this project's 120s test budget, deliberately. Left to the
 * runner, a frame that never arrives reports as `Test timed out in
 * 120000ms` — which `vitest.shared.ts` names as the one failure shape that
 * gets investigated as real before anyone thinks to check the clock, and
 * which says nothing about what the stream did carry. Bounded here, the same
 * silence is an assertion that names the frame, the row and every event that
 * arrived instead.
 */
const FRAME_BUDGET_MS = 15_000;

/** Open a stream, run `act`, and collect until an event for `id` named `name` arrives. */
async function deliver(
  name: string,
  id: string,
  act: () => Promise<void>,
  signal: AbortSignal,
  subscriber: string = apiKey,
) {
  // One predicate for both the wait and the pick. Waiting on name-and-id and
  // then returning the first frame of that name alone hands the caller a
  // stranger's event whenever another row of the same kind is announced in
  // the same window, and every assertion below reads as a server fault.
  const matches = (e: SseEvent): boolean => {
    const data = e.data as { item?: { id?: string }; edge?: { id?: string } };
    return e.event === name && (data.item?.id === id || data.edge?.id === id);
  };
  const stream: EventStream = await openEventStream(apiUrl, subscriber);
  expect(stream.response.status).toBe(200);
  try {
    // Headers are in, which is not the same as the subscription being on the
    // publisher's list. A write that lands in the gap is published to nobody
    // and the wait below can then only end in the budget.
    // `baselineEventId` settles for the same reason and by the same margin.
    await new Promise((r) => setTimeout(r, 250));
    await act();
    try {
      const { events } = await collectUntil(
        stream,
        (events) => events.some(matches),
        `${name} for ${id}`,
        AbortSignal.any([signal, AbortSignal.timeout(FRAME_BUDGET_MS)]),
      );
      return events.find(matches);
    } catch (err) {
      throw new Error(
        `no ${name} frame arrived for ${id} within ${String(FRAME_BUDGET_MS)}ms — ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
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
      const data = events[0].data as { event_type: string; cursor: string };
      expect(data.event_type).toBe("stream_cursor");
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

  it("announces item.restored for a row the restore of its parent brings back", async ({
    signal,
  }) => {
    const parent = await seed("restored-parent");
    const child = await seed("restored-child");
    const edge = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(edge.ok).toBe(true);
    expect((await client.deleteItem(parent)).ok).toBe(true);
    const event = await deliver(
      "item.restored",
      child,
      async () => {
        expect((await client.restoreItem(parent)).ok).toBe(true);
      },
      signal,
    );
    const data = event?.data as { item: { id: string; state: string } };
    expect(data.item.id).toBe(child);
    expect(data.item.state).toBe("active");
  });

  it("announces item.restored for a row a transition out of the bin brings back, at any depth", async ({
    signal,
  }) => {
    const parent = await seed("moved-parent");
    const child = await seed("moved-child");
    const grandchild = await seed("moved-grandchild");
    for (const [source_id, target_id] of [
      [parent, child],
      [child, grandchild],
    ] as const) {
      const edge = await client.createEdge({
        source_id,
        target_id,
        edge_type: "parent-of",
      });
      expect(edge.ok).toBe(true);
    }
    expect((await client.deleteItem(parent)).ok).toBe(true);
    const event = await deliver(
      "item.restored",
      grandchild,
      async () => {
        expect((await client.transitionItem(parent, "active")).ok).toBe(true);
      },
      signal,
    );
    const data = event?.data as { item: { id: string; state: string } };
    expect(data.item.id).toBe(grandchild);
    expect(data.item.state).toBe("active");
  });

  it("announces edge.created for an edge a conflicted copy is given", async ({
    signal,
  }) => {
    const parent = await seed("copy-parent");
    const original = await seed("copy-original");
    const edge = await client.createEdge({
      source_id: parent,
      target_id: original,
      edge_type: "parent-of",
    });
    expect(edge.ok).toBe(true);
    const read = await client.getItem(original);
    const base = read.data.item.version;
    expect(
      (
        await client.updateItem(original, {
          properties: { body: "the winner's body" },
          version: base,
        })
      ).ok,
    ).toBe(true);
    let copy: string | undefined;
    const stream = await openEventStream(apiUrl, apiKey);
    try {
      await new Promise((r) => setTimeout(r, 250));
      const resolved = await client.rawRequest<{
        conflict_resolution?: { conflicted_copy_id?: string };
      }>(`/items/${original}?conflict=auto`, {
        method: "PATCH",
        body: { properties: { body: "the loser's body" }, version: base },
      });
      expect(resolved.ok).toBe(true);
      copy = resolved.data.conflict_resolution?.conflicted_copy_id;
      expect(copy).toBeTruthy();
      const { events } = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              e.event === "edge.created" &&
              (e.data as { edge?: { target_id?: string } }).edge?.target_id ===
                copy,
          ),
        `edge.created for the copy ${String(copy)}`,
        signal,
      );
      const created = events.find(
        (e) =>
          e.event === "edge.created" &&
          (e.data as { edge?: { target_id?: string } }).edge?.target_id ===
            copy,
      );
      const data = created?.data as {
        edge: { source_id: string; edge_type: string };
      };
      expect(data.edge.source_id).toBe(parent);
      expect(data.edge.edge_type).toBe("parent-of");
    } finally {
      await stream.close();
    }
  });

  it("announces a conflicted copy's link to its original between the copy's create and the original's update", async ({
    signal,
  }) => {
    const original = await seed("linked-original");
    const read = await client.getItem(original);
    const base = read.data.item.version;
    expect(
      (
        await client.updateItem(original, {
          properties: { body: "the winner's linked body" },
          version: base,
        })
      ).ok,
    ).toBe(true);
    const stream = await openEventStream(apiUrl, apiKey);
    try {
      await new Promise((r) => setTimeout(r, 250));
      const resolved = await client.rawRequest<{
        conflict_resolution?: { conflicted_copy_id?: string };
      }>(`/items/${original}?conflict=auto`, {
        method: "PATCH",
        body: {
          properties: { body: "the loser's linked body" },
          version: base,
        },
      });
      expect(resolved.ok).toBe(true);
      const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
      expect(copy).toBeTruthy();
      trackItem(ctx, copy!);
      const { events } = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              e.event === "item.updated" &&
              (e.data as { item?: { id?: string } }).item?.id === original,
          ),
        `item.updated for ${original}`,
        signal,
      );
      const order = events.flatMap((e) => {
        if (!/^(item|edge)\./.test(e.event)) return [];
        const data = e.data as {
          item?: { id: string };
          edge?: { source_id: string; edge_type: string; target_id: string };
        };
        if (data.edge !== undefined)
          return [
            `${e.event} ${data.edge.source_id} ${data.edge.edge_type} ${data.edge.target_id}`,
          ];
        const id = data.item?.id;
        if (id !== undefined && (id === copy || id === original))
          return [`${e.event} ${id}`];
        return [];
      });
      expect(order).toEqual([
        `item.created ${String(copy)}`,
        `edge.created ${String(copy)} derived-from ${original}`,
        `item.updated ${original}`,
      ]);
    } finally {
      await stream.close();
    }
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

  it("announces metadata.changed on an extension write under any namespace", async ({
    signal,
  }) => {
    // The extension doors published a carve-out: writes under a reserved
    // `connection.` root "stay silent". No such root exists — the reserved
    // set is `core`, `marfa` and `system`, matched exactly — and nothing
    // anywhere tests a namespace prefix, so the write was announced like any
    // other. The namespace here is the one the carve-out named, so
    // implementing the silence the document described reddens this.
    const id = await seed("extension-announced");
    const event = await deliver(
      "metadata.changed",
      id,
      async () => {
        const put = await client.setItemExtension(id, "connection.runtime", {
          probe: ctx.runId,
        });
        expect(put.ok).toBe(true);
      },
      signal,
    );
    const data = event?.data as {
      item: { id: string };
      metadata?: { extensions?: Record<string, unknown> };
    };
    expect(data.item.id).toBe(id);
    expect(data.metadata?.extensions?.["connection.runtime"]).toEqual({
      probe: ctx.runId,
    });
  });

  it("carries on a metadata.changed frame only the extension namespaces the subscriber may read", async ({
    signal,
  }) => {
    const seen = `stream-seen-${ctx.runId}`;
    const unseen = `stream-unseen-${ctx.runId}`;
    const id = await seed("extension-narrowed");
    expect((await client.setItemExtension(id, seen, { a: 1 })).ok).toBe(true);
    const keyResp = await client.createKey({
      label: "events-one-namespace",
      source: `${ctx.source}-events-one-namespace`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: { [seen]: "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const write = async () => {
      const put = await client.setItemExtension(id, unseen, { secret: 2 });
      expect(put.ok).toBe(true);
    };
    type Frame = { metadata?: { extensions?: Record<string, unknown> } };

    // The witness: a subscriber that may read the namespace is sent it.
    const full = await deliver("metadata.changed", id, write, signal);
    expect((full?.data as Frame).metadata?.extensions?.[unseen]).toEqual({
      secret: 2,
    });

    const narrow = await deliver(
      "metadata.changed",
      id,
      write,
      signal,
      keyResp.data.key,
    );
    expect((narrow?.data as Frame).metadata?.extensions).toEqual({
      [seen]: { a: 1 },
    });
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

  it("refuses a cursor that is not a decimal event id", async () => {
    // The witness: a cursor the log could have issued opens a stream.
    const fine = await openEventStream(apiUrl, apiKey, {
      lastEventId: "0",
      connectTimeoutMs: 30_000,
    });
    try {
      expect(fine.response.status).toBe(200);
    } finally {
      await fine.close();
    }
    for (const cursor of [
      "abc",
      "0x10",
      "-1",
      "+5",
      "007",
      "1.0",
      "9223372036854775808",
    ]) {
      const r = await fetch(`${apiUrl}/events`, {
        headers: { Authorization: `Bearer ${apiKey}`, "Last-Event-ID": cursor },
      });
      expect(r.status, `Last-Event-ID ${JSON.stringify(cursor)}`).toBe(400);
      const body = (await r.json()) as {
        error: { code: string; details?: { errors?: { path: string }[] } };
      };
      expect(body.error.code).toBe("validation_error");
      expect(body.error.details?.errors?.[0]?.path).toBe("Last-Event-ID");
    }
  });

  it("refuses a cursor past the log's head with a terminal cursor_ahead frame", async ({
    signal,
  }) => {
    const head = await baselineEventId(
      apiUrl,
      apiKey,
      () => seed("cursor-ahead-head"),
      signal,
    );
    // Far enough past the head that no other file's writes reach it while
    // this one runs.
    const ahead = String(BigInt(head.eventId) + 1_000_000_000_000n);
    await withStream(apiUrl, apiKey, { lastEventId: ahead }, async (stream) => {
      expect(stream.response.status).toBe(200);
      const { events } = await collectUntil(
        stream,
        (evts) => evts.some((e) => e.event === "cursor_ahead"),
        "a cursor_ahead frame",
        signal,
      );
      const frame = events.find((e) => e.event === "cursor_ahead");
      const data = frame?.data as {
        event_type: string;
        requested: string;
        head: string;
      };
      expect(data.event_type).toBe("cursor_ahead");
      expect(data.requested).toBe(ahead);
      expect(BigInt(data.head) >= BigInt(head.eventId)).toBe(true);
      expect(BigInt(data.head) < BigInt(ahead)).toBe(true);
      // No `id:`, so a reconnect without reading it is refused again
      // rather than resumed from somewhere else; and it is the last frame.
      expect(frame?.id).toBeUndefined();
      expect(events.some((e) => e.event === "stream_live")).toBe(false);
      const reader = stream.response.body?.getReader();
      expect((await reader?.read())?.done).toBe(true);
    });
  });

  it("refuses a subscription with no credential", async () => {
    const r = await fetch(`${apiUrl}/events`);
    expect(r.status).toBe(401);
  });
});
