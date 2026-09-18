import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { detectSyncCapabilities, requireRule } from "./capabilities.js";
import type { SyncCapabilities } from "./capabilities.js";

/**
 * "A replay is what a live subscriber would have seen", applied to removals:
 * one reaches a client that was not connected when it happened.
 *
 * A client holds rows it can only drop when told to. Within the retention
 * window that telling is an event; beyond it, the client's re-import prunes
 * what the server no longer has. The events are the cheap path and the one
 * that keeps a running client correct, so a removal that never announces
 * itself leaves every connected client holding a row the server does not have
 * — an item in a list that 404s when opened, or an edge pointing at nothing.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "deletions",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeNote(body: string): Promise<string> {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { body },
  });
  expect(created.ok).toBe(true);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

describe("deletions reach the stream", () => {
  it("announces an edge removed by cascade, not only one removed by its own route", async (context) => {
    const source = await makeNote("cascade-source");
    const target = await makeNote("cascade-target");
    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    const edgeId = edge.data.edge.id;
    trackEdge(ctx, edgeId);

    // The edge is really there before the purge, so its `edge.deleted` below
    // is the cascade removing it rather than a report about something that
    // was already gone.
    const before = await client.listItemEdges(source);
    expect(before.ok).toBe(true);
    expect(
      JSON.stringify(before.data),
      "the edge under test is not attached to the item that is about to be purged",
    ).toContain(edgeId);

    const outcome = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      // Nothing here touches `/edges`. The edge goes away because its
      // endpoint does, which is a different code path from the delete route
      // and the one no other suite exercises against the stream.
      const deleted = await client.deleteItem(source);
      expect(deleted.ok).toBe(true);
      const purged = await client.purgeItem(source);
      expect(
        purged.ok,
        `the purge that should cascade did not happen: ${JSON.stringify(purged.error)}`,
      ).toBe(true);

      // Waits on the control, not on the rule. `item.deleted` for the
      // endpoint is the frame a working subscription must deliver whatever
      // the answer about the cascade is, so waiting on that turns "the edge
      // was never announced" into a named assertion below. Waiting on
      // `edge.deleted` itself would instead burn the runner's whole budget
      // and report `Test timed out`, which says nothing about the rule and
      // costs two minutes to say it.
      const seen = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.data as { item?: { id?: string } })?.item?.id === source ||
              (e.data as { edge?: { id?: string } })?.edge?.id === edgeId,
          ),
        `the endpoint's own removal to reach the stream (item ${source})`,
        context.signal,
      );
      // A cascaded edge event can land a beat after the endpoint's, and this
      // subscription is unfiltered, so an edge written now arrives whatever
      // the answer about the cascade is. Waiting for it settles the question
      // instead of guessing at how long a beat is: edges reach a subscriber
      // in publish order, so once this one is here a cascaded `edge.deleted`
      // that was going to come has come.
      const sentinelEdge = await client.createEdge({
        source_id: target,
        target_id: await makeNote("cascade-sentinel-target"),
        edge_type: "about",
      });
      expect(sentinelEdge.ok).toBe(true);
      trackEdge(ctx, sentinelEdge.data.edge.id);
      const rest = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.data as { edge?: { id?: string } })?.edge?.id ===
              sentinelEdge.data.edge.id,
          ),
        `the sentinel edge written after the purge (${sentinelEdge.data.edge.id})`,
        context.signal,
      );
      return [...seen.events, ...rest.events];
    });

    // The control. A stream carrying nothing about the endpoint either was
    // not delivering, and the assertion below would then be a statement about
    // the subscription rather than about the cascade.
    expect(
      outcome
        .filter(
          (e) => (e.data as { item?: { id?: string } })?.item?.id === source,
        )
        .map((e) => e.event),
      "the stream did not carry the endpoint's own removal, so it was not delivering",
    ).toContain("item.deleted");

    const cascaded = outcome.filter(
      (e) => (e.data as { edge?: { id?: string } })?.edge?.id === edgeId,
    );
    expect(
      cascaded.map((e) => e.event),
      "purging an endpoint removed the edge without announcing it, so a connected client keeps a dangling edge",
    ).toContain("edge.deleted");
  });

  it("announces a purge, so a client offline across it learns the row is gone", async (context) => {
    requireRule(caps, "itemPurgedEvent");

    const id = await makeNote("purge-announcement");

    const outcome = await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const deleted = await client.deleteItem(id);
      expect(deleted.ok).toBe(true);
      const purged = await client.purgeItem(id);
      expect(purged.ok).toBe(true);

      // Waits on the soft delete, which is this test's control and the frame
      // a working subscription must deliver either way. Waiting on
      // `item.purged` itself would report `Test timed out` two minutes later
      // on a server that does not emit it, in place of the assertion below
      // that names what is missing.
      const seen = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.event === "item.deleted" || e.event === "item.purged") &&
              (e.data as { item?: { id?: string } })?.item?.id === id,
          ),
        `the removal of ${id} to reach the stream`,
        context.signal,
      );
      // A purge announcement can land a beat after the delete's, so the wait
      // is on a row written after the purge rather than on a fixed window:
      // items reach a subscriber in publish order, and this one arrives
      // whether or not a purge is ever announced.
      const sentinel = await makeNote("purge-announcement-sentinel");
      const rest = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.data as { item?: { id?: string } })?.item?.id === sentinel,
          ),
        `the sentinel written after purging ${id} (${sentinel})`,
        context.signal,
      );
      return [...seen.events, ...rest.events];
    });

    const names = outcome
      .filter((e) => (e.data as { item?: { id?: string } })?.item?.id === id)
      .map((e) => e.event);

    // The soft delete is the control: both events describe this item, and a
    // stream carrying neither would make the purge assertion a statement
    // about the subscription rather than about the server.
    expect(
      names,
      "the stream did not carry this item's soft delete either, so it was not delivering",
    ).toContain("item.deleted");
    expect(
      names,
      "a hard delete was not announced, so a client that was offline across it keeps the row forever",
    ).toContain("item.purged");
  });
});
