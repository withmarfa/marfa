import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import type { SseEvent } from "../../utils/sse.js";

/**
 * "A client names its own rows", on the half a queue depends on: a create the
 * server has already performed, arriving again, is acknowledged rather than
 * repeated.
 *
 * This is what makes an offline queue safe to drain. A client that sends a
 * create and loses the response cannot know whether the write landed, so it
 * resends — and because the id came from the client rather than the server,
 * the server can recognize its own work. Nothing is written, nothing is
 * published, and the stored row comes back with `acknowledged: true`.
 *
 * **The silent event is the half that matters.** A server that answered the
 * repeat correctly and published a second time would satisfy every assertion
 * about the response body, while every other device on the instance applies an
 * event for a write that did not happen. On a row it already holds that is
 * harmless; on one it has since edited locally it is a rollback nobody asked
 * for. So each case here waits for a sentinel written *after* the repeat, and
 * of the same kind as the frame it is ruling out: a sentinel that has arrived
 * is proof that anything published ahead of it has arrived too, since the
 * stream delivers both kinds in id order, so an empty result is an observation
 * rather than a quiet moment. A like sentinel keeps each case to one kind of
 * frame, so what it rules out is named by the same event it is counting.
 *
 * The `Idempotency-Key` header in `idempotency.test.ts` is a different
 * mechanism for the same problem, and the two are easy to confuse: one
 * collapses a retry by a header the caller invents, this one by the row id the
 * caller already minted.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "acknowledged",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Every frame naming this item, by event name. */
function framesForItem(events: SseEvent[], id: string): string[] {
  return events
    .filter((e) => (e.data as { item?: { id?: string } })?.item?.id === id)
    .map((e) => e.event);
}

/** Every frame naming this edge, by event name. */
function framesForEdge(events: SseEvent[], id: string): string[] {
  return events
    .filter((e) => (e.data as { edge?: { id?: string } })?.edge?.id === id)
    .map((e) => e.event);
}

describe("a repeated create is acknowledged", () => {
  it("answers an item repeat with the stored row and announces nothing", async (context) => {
    const id = uuidv7();
    const sentinelBody = `acknowledged-item-sentinel-${ctx.runId}`;

    const outcome = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));

      const first = await client.createItem({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-item-first" },
      });
      expect(
        first.ok,
        `a client-minted id was refused: ${JSON.stringify(first.error)}`,
      ).toBe(true);
      trackItem(ctx, id);
      expect(first.status).toBe(201);
      expect(first.data.acknowledged).toBeUndefined();

      // The queue resending a create whose response it never saw. The body
      // differs deliberately: a server that answered the repeat by performing
      // the write again would return this one and step the version, which no
      // assertion about the id alone could tell from a correct acknowledgment.
      const repeat = await client.createItem({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-item-second" },
      });

      // Written after the repeat, and the reason the silence below is a
      // finding. The stream delivers in publish order, so once this arrives
      // any event the repeat published has already arrived.
      const sentinel = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: sentinelBody },
      });
      expect(sentinel.ok).toBe(true);
      trackItem(ctx, sentinel.data.item.id);

      const seen = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.data as { item?: { id?: string } })?.item?.id ===
              sentinel.data.item.id,
          ),
        `item.created for the sentinel written after the repeat (${sentinel.data.item.id})`,
        context.signal,
      );
      return { repeat, events: seen.events };
    });

    expect(
      outcome.repeat.status,
      `a resent create was not acknowledged: ${JSON.stringify(outcome.repeat.error)}`,
    ).toBe(200);
    expect(
      outcome.repeat.data.acknowledged,
      "the repeat did not report itself as an acknowledgment, so a client cannot tell a collapsed retry from a create that happened twice",
    ).toBe(true);

    expect(
      outcome.repeat.data.item.id,
      "a resent create under the same minted id produced a different row",
    ).toBe(id);
    expect(
      outcome.repeat.data.item.properties.body,
      "the repeat performed the write again instead of returning the row it already held",
    ).toBe("acknowledged-item-first");

    // The control for the assertion below: the first create did reach the
    // subscriber, so an absence afterwards is about the repeat rather than
    // about a stream that was never delivering.
    expect(
      framesForItem(outcome.events, id),
      "the first create never reached the subscriber, so this stream says nothing about what the repeat did or did not announce",
    ).toContain("item.created");

    expect(
      framesForItem(outcome.events, id),
      "a repeat that wrote nothing was announced anyway, so every other device applies an event for a write that did not happen",
    ).toEqual(["item.created"]);

    const stored = await client.getItem(id);
    expect(stored.ok).toBe(true);
    expect(stored.data.item.properties.body).toBe("acknowledged-item-first");
    expect(
      stored.data.item.version,
      "the repeat moved the version, so a client reconciling against its own pending write sees a step it cannot account for",
    ).toBe(outcome.repeat.data.item.version);
  });

  it("refuses an item repeat whose body names a different type", async () => {
    const id = uuidv7();
    const first = await client.createItem({
      id,
      type: "core.note",
      source: ctx.source,
      properties: { body: "acknowledged-type-mismatch" },
    });
    expect(first.ok).toBe(true);
    trackItem(ctx, id);

    // A draining queue hits exactly this when a corpus has been re-typed
    // under it. Answering 200 would hand back a row of a type the caller did
    // not ask for, and the client would then hold it under the wrong schema.
    const mismatched = await client.createItem({
      id,
      type: "core.task",
      source: ctx.source,
      properties: { title: "acknowledged-type-mismatch" },
    });
    expect(
      mismatched.status,
      "a repeat naming a different type was not refused, so a write can silently re-type the row it lands on",
    ).toBe(409);
    // One code for a reused id, wherever it happens — this door, the edge
    // door, and a bulk entry the id fallback resolved — and `details`
    // says what differed. A client sorts a refusal by its code, and one
    // that depended on which door was asked would not sort.
    expect(mismatched.error?.error.code).toBe("id_reused");
    expect(mismatched.error?.error.details?.differs).toEqual(["type"]);

    const stored = await client.getItem(id);
    expect(stored.ok).toBe(true);
    expect(
      stored.data.item.type,
      "the refused repeat re-typed the row anyway",
    ).toBe("core.note");
  });

  it("acknowledges an item repeat whatever version it names, and writes nothing", async () => {
    const id = uuidv7();
    const first = await client.createItem({
      id,
      type: "core.note",
      source: ctx.source,
      properties: { body: "acknowledged-version-first" },
    });
    expect(first.status).toBe(201);
    trackItem(ctx, id);

    for (const version of [0, 1, 7]) {
      const repeat = await client.createItem({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: `acknowledged-version-${String(version)}` },
        version,
      });
      expect(
        repeat.status,
        `a repeat naming version ${String(version)}: ${JSON.stringify(repeat.error)}`,
      ).toBe(200);
      expect(repeat.data.acknowledged, String(version)).toBe(true);
      expect(repeat.data.item.version, String(version)).toBe(1);
      expect(repeat.data.item.properties.body, String(version)).toBe(
        "acknowledged-version-first",
      );
    }
    const stored = await client.getItem(id);
    expect(stored.data.item.version).toBe(1);
    expect(stored.data.item.properties.body).toBe("acknowledged-version-first");
    expect((await client.getVersions(id)).data.data).toHaveLength(0);

    // The witness: the same version 0 on a natural key that resolves a live
    // row is looked at and refused, so the acknowledgments above are not a
    // door that ignores the field everywhere.
    const sourceId = `acknowledged-live-${ctx.runId}`;
    const live = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { body: "acknowledged-live" },
    });
    expect(live.status).toBe(201);
    trackItem(ctx, live.data.item.id);
    const refused = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { body: "acknowledged-live-again" },
      version: 0,
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("ancestor_unavailable");
  });

  it("acknowledges a create naming the natural key of a row in the bin whatever version it names, and writes nothing", async () => {
    const sourceId = `acknowledged-trashed-${ctx.runId}`;
    const first = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { body: "acknowledged-trashed-first" },
    });
    expect(first.status).toBe(201);
    const id = first.data.item.id;
    trackItem(ctx, id);
    expect((await client.deleteItem(id)).ok).toBe(true);

    for (const version of [0, 1, 999]) {
      const repeat = await client.createItem({
        type: "core.note",
        source: ctx.source,
        source_id: sourceId,
        properties: { body: `acknowledged-trashed-${String(version)}` },
        version,
      });
      expect(
        repeat.status,
        `a create naming version ${String(version)}: ${JSON.stringify(repeat.error)}`,
      ).toBe(200);
      expect(repeat.data.acknowledged, String(version)).toBe(true);
      expect(repeat.data.item.id, String(version)).toBe(id);
      expect(repeat.data.item.state, String(version)).toBe("trashed");
      expect(repeat.data.item.version, String(version)).toBe(1);
    }

    // Restored, the row is what the first create wrote: the bin kept it, and
    // none of the three creates reached it.
    const restored = await client.restoreItem(id);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.item.version).toBe(1);
    expect(restored.data.item.properties.body).toBe(
      "acknowledged-trashed-first",
    );
    expect((await client.getVersions(id)).data.data).toHaveLength(0);

    // The witness: the same version 0 on the key once the row is live again
    // is looked at and refused.
    const live = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { body: "acknowledged-trashed-live" },
      version: 0,
    });
    expect(live.status).toBe(409);
    expect(live.error?.error.code).toBe("ancestor_unavailable");
  });

  it("answers an edge repeat with the stored row and announces nothing", async (context) => {
    const [source, target, spare] = await Promise.all([
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-edge-source" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-edge-target" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-edge-sentinel-target" },
      }),
    ]);
    expect(source.ok && target.ok && spare.ok).toBe(true);
    trackItem(ctx, source.data.item.id);
    trackItem(ctx, target.data.item.id);
    trackItem(ctx, spare.data.item.id);

    const id = uuidv7();
    const body = {
      id,
      source_id: source.data.item.id,
      target_id: target.data.item.id,
      edge_type: "about",
    };

    const outcome = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));

      const first = await client.createEdge(body);
      expect(
        first.ok,
        `a client-minted edge id was refused: ${JSON.stringify(first.error)}`,
      ).toBe(true);
      trackEdge(ctx, id);
      expect(first.data.acknowledged).toBeUndefined();

      const repeat = await client.createEdge(body);

      // The sentinel, as above, an edge here: the stream delivers both
      // kinds in id order, so an item would order against the repeat's
      // edge too, and an edge keeps the case to one kind of frame.
      const sentinel = await client.createEdge({
        source_id: source.data.item.id,
        target_id: spare.data.item.id,
        edge_type: "about",
      });
      expect(sentinel.ok).toBe(true);
      trackEdge(ctx, sentinel.data.edge.id);

      const seen = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.data as { edge?: { id?: string } })?.edge?.id ===
              sentinel.data.edge.id,
          ),
        `edge.created for the sentinel written after the edge repeat (${sentinel.data.edge.id})`,
        context.signal,
      );
      return { repeat, events: seen.events };
    });

    expect(
      outcome.repeat.status,
      `a resent edge create was not acknowledged: ${JSON.stringify(outcome.repeat.error)}`,
    ).toBe(200);
    expect(
      outcome.repeat.data.acknowledged,
      "the edge repeat did not report itself as an acknowledgment",
    ).toBe(true);
    expect(outcome.repeat.data.edge.id).toBe(id);

    expect(
      framesForEdge(outcome.events, id),
      "the first edge create never reached the subscriber, so this stream says nothing about what the repeat announced",
    ).toContain("edge.created");
    expect(
      framesForEdge(outcome.events, id),
      "an edge repeat that wrote nothing was announced anyway, so a client applies a create for an edge it already holds",
    ).toEqual(["edge.created"]);
  });

  it("answers an edge repeat naming other properties with the stored row, unchanged and unannounced", async (context) => {
    const made = await Promise.all(
      ["source", "target", "sentinel-target"].map((label) =>
        client.createItem({
          type: "core.note",
          source: ctx.source,
          properties: { body: `acknowledged-edge-row-${label}` },
        }),
      ),
    );
    for (const r of made) {
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }
    const [source, target, spare] = made.map((r) => r.data.item.id) as [
      string,
      string,
      string,
    ];

    const id = uuidv7();
    const outcome = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));

      const first = await client.createEdge({
        id,
        source_id: source,
        target_id: target,
        edge_type: "about",
        properties: { note: "first" },
      });
      expect(first.status).toBe(201);
      trackEdge(ctx, id);

      const repeat = await client.createEdge({
        id,
        source_id: source,
        target_id: target,
        edge_type: "about",
        properties: { note: "second" },
      });

      const sentinel = await client.createEdge({
        source_id: source,
        target_id: spare,
        edge_type: "about",
      });
      expect(sentinel.ok).toBe(true);
      trackEdge(ctx, sentinel.data.edge.id);

      const seen = await collectUntil(
        stream,
        (events) => framesForEdge(events, sentinel.data.edge.id).length > 0,
        `edge.created for the sentinel written after the edge repeat (${sentinel.data.edge.id})`,
        context.signal,
      );
      return { first, repeat, events: seen.events };
    });

    expect(outcome.repeat.status).toBe(200);
    expect(outcome.repeat.data.acknowledged).toBe(true);
    expect(
      outcome.repeat.data.edge,
      "the repeat did not return the row the first create stored",
    ).toEqual(outcome.first.data.edge);

    const stored = await client.getEdge(id);
    expect(stored.data.edge).toEqual(outcome.first.data.edge);
    expect(stored.data.edge.version).toBe(1);

    expect(framesForEdge(outcome.events, id)).toEqual(["edge.created"]);
  });

  it("refuses an edge id that names a different triple", async () => {
    const [a, b, c] = await Promise.all([
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-edge-collision-a" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-edge-collision-b" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "acknowledged-edge-collision-c" },
      }),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    for (const r of [a, b, c]) trackItem(ctx, r.data.item.id);

    const id = uuidv7();
    const first = await client.createEdge({
      id,
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: "about",
    });
    expect(first.ok).toBe(true);
    trackEdge(ctx, id);

    // Same id, different target. Acknowledging this would hand the caller an
    // edge pointing somewhere it never asked for, under an id it believes it
    // owns — the one outcome worse than a refusal, because nothing later
    // corrects it.
    const collision = await client.createEdge({
      id,
      source_id: a.data.item.id,
      target_id: c.data.item.id,
      edge_type: "about",
    });
    expect(
      collision.status,
      "an id naming a different edge was treated as a repeat, so the caller now holds an edge pointing somewhere it did not ask for",
    ).toBe(409);
    // The same code the item door answers for the same mistake, and
    // `details` names the member of the triple that differed rather than
    // leaving the caller to compare three.
    expect(collision.error?.error.code).toBe("id_reused");
    expect(collision.error?.error.details?.differs).toEqual(["target_id"]);

    const stored = await client.listItemEdges(a.data.item.id);
    expect(stored.ok).toBe(true);
    expect(
      JSON.stringify(stored.data),
      "the refused create landed anyway",
    ).not.toContain(c.data.item.id);
  });
});
