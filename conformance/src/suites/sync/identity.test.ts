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

/**
 * "A client names its own rows": an id is minted by the client and the row
 * keeps it.
 *
 * A durable client renders a row before the write leaves the device, so the id
 * it drew has to be the id the server stores. The regression is not that the
 * create fails — it succeeds either way — but that the event coming back
 * afterwards names a different row. The client then has the item twice: once
 * under the id it minted, once under the id the event brought, and no later
 * event reconciles them because from the server's side there is only ever one
 * row. It shows up as a duplicate in a list that no refresh clears.
 *
 * The event is therefore the assertion, not the create response. A server
 * could echo the requested id in the response and store its own.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "identity",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("client-minted ids", () => {
  it("keeps the id a client mints for an item, on the row and on the event", async (context) => {
    const id = uuidv7();
    // Carries this run's id, because the stream carries every write on the
    // server. A fixed literal lets concurrent runs pick up each other's
    // frames, and the assertion below then reports a client-minted id that was
    // not kept — a defect message for what is only a collision.
    const marker = `identity-item-${ctx.runId}`;

    const events = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const created = await client.createItem({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: marker },
      });
      expect(
        created.ok,
        `a client-minted id was refused: ${JSON.stringify(created.error)}`,
      ).toBe(true);
      trackItem(ctx, created.data.item.id);
      expect(created.data.item.id).toBe(id);

      const seen = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              e.event === "item.created" &&
              (e.data as { item?: { properties?: { body?: string } } })?.item
                ?.properties?.body === marker,
          ),
        `item.created for the client-minted item ${id}`,
        context.signal,
      );
      return seen.events;
    });

    // Matched on the body rather than the id, so a server that stored its own
    // id still produces a frame this assertion can catch. Matching on the id
    // would simply never find the event and report a timeout, which reads as
    // a stream problem rather than as the defect it is.
    const announced = events.find(
      (e) =>
        (e.data as { item?: { properties?: { body?: string } } })?.item
          ?.properties?.body === marker,
    );
    expect(announced).toBeDefined();
    expect(
      (announced!.data as { item: { id: string } }).item.id,
      "the event announced a different id from the one the client minted, so the client now holds the row twice",
    ).toBe(id);

    const fetched = await client.getItem(id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.id).toBe(id);
  });

  it("keeps the id a client mints for an edge", async (context) => {
    const [source, target] = await Promise.all([
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "identity-edge-source" },
      }),
      client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: "identity-edge-target" },
      }),
    ]);
    expect(source.ok && target.ok).toBe(true);
    trackItem(ctx, source.data.item.id);
    trackItem(ctx, target.data.item.id);

    const id = uuidv7();
    const events = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const created = await client.createEdge({
        id,
        source_id: source.data.item.id,
        target_id: target.data.item.id,
        edge_type: "about",
      });
      expect(
        created.ok,
        `a client-minted edge id was refused: ${JSON.stringify(created.error)}`,
      ).toBe(true);
      trackEdge(ctx, created.data.edge.id);
      expect(created.data.edge.id).toBe(id);

      const seen = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              e.event === "edge.created" &&
              (e.data as { edge?: { source_id?: string } })?.edge?.source_id ===
                source.data.item.id,
          ),
        `edge.created for the client-minted edge ${id}`,
        context.signal,
      );
      return seen.events;
    });

    const announced = events.find(
      (e) =>
        (e.data as { edge?: { source_id?: string } })?.edge?.source_id ===
        source.data.item.id,
    );
    expect(announced).toBeDefined();
    expect(
      (announced!.data as { edge: { id: string } }).edge.id,
      "the event announced a different edge id from the one the client minted, so a replayed create duplicates the edge on the device that made it",
    ).toBe(id);
  });
});
