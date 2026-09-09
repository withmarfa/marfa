/**
 * What a promotion tells a client that was not watching.
 *
 * The door mints a copy and joins it back to the mirror, and it used to
 * announce only the join. A subscriber was handed an `edge.created` naming a
 * `source_id` it had never heard of and could not resolve, and a client
 * rebuilding from the log never learned the row existed at all short of a
 * full re-import.
 *
 * Asserted on the event log rather than on a live subscriber, deliberately
 * and for the reason `conflict-sibling-reaches-the-log.test.ts` states: the
 * emitter is what a listener happens to be attached to, the log is what a
 * client that was offline reads. It is also the only place the two halves
 * are in one ordered sequence, and the order is the substance here — an
 * edge behind the item it belongs to, which is what makes the edge
 * resolvable.
 *
 * Runs against whichever dialect the suite is running.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog, __resetCycleDetectionForTests } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // `createTestContext` does not wire the log — the server's bootstrap does.
  // Without this every assertion below reads an empty log whatever the door
  // did, and passes for a reason that has nothing to do with the property.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetCycleDetectionForTests();
  await ctx.cleanup();
});

interface LogRow {
  id: bigint;
  event_type: string;
  item_id: string | null;
  edge_id: string | null;
  payload: string;
  enable_fanout: boolean;
}

async function logCursor(): Promise<bigint> {
  const rows = (await ctx.storage.eventLog.getAfter(0n, 100_000)) as LogRow[];
  return rows.reduce((max, r) => (r.id > max ? r.id : max), 0n);
}

async function logSince(cursor: bigint): Promise<LogRow[]> {
  return await ctx.storage.eventLog.getAfter(cursor, 100_000);
}

async function promoteAMirror(): Promise<{
  rows: LogRow[];
  mirrorId: string;
  promotedId: string;
}> {
  const mirror = await ctx.storage.items.create(
    {
      type: "core.note",
      properties: { body: "upstream copy" },
      source: "integration:promote-announcement",
      source_id: `mirror-${String(Date.now())}-${String(Math.random())}`,
    },
    // The space the promoting credential works in. A mirror written with no
    // space lands in the space-less bucket, where the door cannot resolve it.
    ctx.spaceId,
  );
  const cursor = await logCursor();
  const res = await request(ctx.app, "POST", `/items/${mirror.id}/promote`, {
    key: ctx.spaceKey,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const promotedId = ((await res.json()) as { item: { id: string } }).item.id;
  return { rows: await logSince(cursor), mirrorId: mirror.id, promotedId };
}

describe("a promotion's announcement", () => {
  it("puts the copy in the log, ahead of the edge that joins it back", async () => {
    const { rows, promotedId } = await promoteAMirror();

    const created = rows.find(
      (r) => r.event_type === "created" && r.item_id === promotedId,
    );
    const edge = rows.find((r) => r.event_type === "edge_created");
    expect(
      created,
      JSON.stringify(rows.map((r) => r.event_type)),
    ).toBeDefined();
    expect(edge).toBeDefined();

    // The ordering is the property, not a tidiness preference: an edge
    // arriving first names a source the reader cannot resolve.
    expect(created!.id < edge!.id).toBe(true);
  });

  it("carries the copy's metadata, as every other create announcement does", async () => {
    const { rows, promotedId } = await promoteAMirror();
    const created = rows.find(
      (r) => r.event_type === "created" && r.item_id === promotedId,
    );
    expect(created).toBeDefined();

    // `publish` omits the key entirely when the event carries no metadata,
    // so an event without it is not "metadata: null" on the wire — the
    // webhook sends null and the integration envelope sends nothing, and a
    // handler reading `payload.metadata.tags` throws on this event alone
    // while being safe on every other create.
    const payload = JSON.parse(created!.payload) as {
      type: string;
      metadata?: { item_id: string; tags: string[]; extensions: unknown };
    };
    expect(payload.type).toBe("item.created");
    expect(payload.metadata).toBeDefined();
    expect(payload.metadata?.item_id).toBe(promotedId);
    // A promotion copies properties and no tags, so the copy's metadata
    // layer is empty — which is a value the announcement has to carry
    // rather than a reason to omit it.
    expect(payload.metadata?.tags).toEqual([]);
  });

  it("does not push the copy back out through the integrations watching", async () => {
    const { rows, promotedId } = await promoteAMirror();
    const created = rows.find(
      (r) => r.event_type === "created" && r.item_id === promotedId,
    );
    expect(created).toBeDefined();

    // The mirror is an integration's reflection of an upstream record. Fan
    // this out and every bidirectional connection targeting the type writes
    // the copy upstream as a NEW record, so the thing the mirror already
    // reflects exists twice — the duplication the mirror-and-promote split
    // exists to prevent. Dispatch suppresses only the originating
    // connection, and a person promoting has none, so nothing else stops it.
    //
    // Fan-out governs neither the log nor the stream, so declining it costs
    // nothing this announcement is for: the row below is the announcement,
    // and it is here.
    expect(created?.enable_fanout).toBe(false);
  });
});
