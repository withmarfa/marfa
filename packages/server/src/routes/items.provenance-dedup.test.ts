/**
 * Connector provenance, and the two ways it used to collide.
 *
 * `(source, source_id)` is a natural key a connector re-syncs against. The
 * first collision is with another connector: the index was instance-wide,
 * so two credentials that happened to share a `source_id` collided even
 * though neither had seen the other's upstream.
 *
 * The second is with the owner: a mirror they trashed refused every later
 * re-sync, permanently, because two dedup checks on the same write path
 * disagreed about state.
 */
import { NaturalKeyHeld } from "../storage/interface.js";
import { itemWrites } from "../storage/item-writes.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A credential standing in for a connector. */
async function connectorKey(label: string, source: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label,
      source,
      type_permissions: { "*": "write" },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

describe("provenance dedup is scoped, not instance-wide", () => {
  it("lets two credentials hold the same source_id under different sources", async () => {
    // The narrower property the old index did get right, pinned so the
    // widening below cannot quietly take it away.
    const a = await connectorKey("prov-a", "feed-a");
    const b = await connectorKey("prov-b", "feed-b");
    const body = {
      type: "core.note",
      properties: { title: "same upstream id", body: "x" },
      source_id: "upstream-1",
    };
    const first = await request(ctx.app, "POST", "/items", { key: a, body });
    expect(first.status).toBe(201);
    const second = await request(ctx.app, "POST", "/items", { key: b, body });
    expect(second.status).toBe(201);
  });

  it("still refuses a genuine duplicate within one source", async () => {
    // The other direction. Loosening the index must not stop it deduping
    // what it exists to dedupe — a second create under the same natural
    // key resolves to the existing row rather than making a new one.
    const k = await connectorKey("prov-same", "feed-same");
    const body = {
      type: "core.note",
      properties: { title: "first", body: "x" },
      source_id: "upstream-dup",
    };
    const first = await request(ctx.app, "POST", "/items", { key: k, body });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { item: { id: string } }).item.id;

    const again = await request(ctx.app, "POST", "/items", {
      key: k,
      body: { ...body, properties: { title: "second", body: "x" } },
    });
    // 200, not 201: the natural key resolved the existing row and updated
    // it in place, which is the idempotent re-sync contract.
    expect(again.status).toBe(200);
    const againId = ((await again.json()) as { item: { id: string } }).item.id;
    expect(againId).toBe(firstId);
  });
});

describe("the same upstream record", () => {
  it("refuses a duplicate at the store, as a refusal no door answers", async () => {
    const shared = { source: "feed-inner", source_id: "upstream-inner" };
    await itemWrites(ctx.storage).create({
      writer: null,
      type: "core.note",
      properties: { title: "one", body: "x" },
      ...shared,
    });
    await expect(
      itemWrites(ctx.storage).create({
        writer: null,
        type: "core.note",
        properties: { title: "two", body: "x" },
        ...shared,
      }),
    ).rejects.toBeInstanceOf(NaturalKeyHeld);
  });
});

describe("a mirror the user trashed", () => {
  it("accepts the next re-sync instead of refusing it forever", async () => {
    // The wedge: an upsert that does not see a trashed row falls into
    // create, which finds the same row and refuses with a 409. Nothing
    // clears that: the row stays trashed, so every later sync fails
    // identically and the connector is stuck on one item.
    const k = await connectorKey("prov-trash", "feed-trash");
    const body = {
      type: "core.note",
      properties: { title: "mirrored upstream", body: "x" },
      source_id: "upstream-trashed",
    };
    const created = await request(ctx.app, "POST", "/items", { key: k, body });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { item: { id: string } }).item.id;

    const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.workingKey,
    });
    expect(trashed.status).toBe(200);

    const resync = await request(ctx.app, "POST", "/items", {
      key: k,
      body: { ...body, properties: { title: "changed upstream", body: "x" } },
    });
    expect(resync.status).toBe(200);
    const payload = (await resync.json()) as {
      item: { id: string; state: string; properties: { title: string } };
      acknowledged?: boolean;
    };
    // Acknowledged, and deliberately nothing written: the deletion is the
    // user's and stands, so the row is neither revived nor rewritten.
    expect(payload.acknowledged).toBe(true);
    expect(payload.item.id).toBe(id);
    expect(payload.item.state).toBe("trashed");
    expect(payload.item.properties.title).toBe("mirrored upstream");

    // And it is still trashed in storage, so the acknowledge did not
    // quietly write through a different path. Read through the store
    // rather than the API because a trashed row is deliberately a 404
    // there, which would not distinguish "untouched" from "hard deleted".
    const stored = await ctx.storage.items.findBySourceId(
      "feed-trash",
      "upstream-trashed",
    );
    expect(stored?.id).toBe(id);
    expect(stored?.state).toBe("trashed");
    expect(stored?.properties.title).toBe("mirrored upstream");
  });

  it("resumes ordinary updates once the user restores it", async () => {
    // The acknowledge is a hold, not a purge.
    const k = await connectorKey("prov-restore", "feed-restore");
    const body = {
      type: "core.note",
      properties: { title: "before", body: "x" },
      source_id: "upstream-restored",
    };
    const created = await request(ctx.app, "POST", "/items", { key: k, body });
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.workingKey });
    await request(ctx.app, "POST", `/items/${id}/restore`, {
      key: ctx.workingKey,
    });

    const resync = await request(ctx.app, "POST", "/items", {
      key: k,
      body: { ...body, properties: { title: "after", body: "x" } },
    });
    expect(resync.status).toBe(200);
    const payload = (await resync.json()) as {
      item: { id: string; properties: { title: string } };
      acknowledged?: boolean;
    };
    expect(payload.acknowledged).toBeUndefined();
    expect(payload.item.id).toBe(id);
    expect(payload.item.properties.title).toBe("after");
  });
});
