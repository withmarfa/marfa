/**
 * Integration provenance, and the two ways it used to collide.
 *
 * `(source, source_id)` is a natural key an integration re-syncs against,
 * and it was unique across the whole instance rather than per space. Two
 * spaces syncing the same integration against the same upstream record
 * are two corpora, not one, so the second space's write failed on a row
 * it cannot see, does not own, and has no way to reach.
 *
 * The second collision is with the user rather than another space: a
 * mirror they trashed refused every later re-sync, permanently, because
 * two dedup checks on the same write path disagreed about state.
 */
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

/** A credential standing in for one space's integration runtime.
 *  The real provenance prefix (`integration:`) is reserved to the install
 *  pipeline and refused by this route, which is a separate guard working
 *  as intended; the dedup behaviour under test does not depend on it. */
async function integrationKey(label: string, source: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.spaceKey,
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
    const a = await integrationKey("prov-a", "feed-a");
    const b = await integrationKey("prov-b", "feed-b");
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

  it("still refuses a genuine duplicate within one source and space", async () => {
    // The other direction. Loosening the index must not stop it deduping
    // what it exists to dedupe — a second create under the same natural
    // key resolves to the existing row rather than making a new one.
    const k = await integrationKey("prov-same", "feed-same");
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

describe("the same upstream record in two spaces", () => {
  it("is two corpora, not a collision", async () => {
    // The defect proper, driven at the storage layer because it is the
    // unique index that collides and the HTTP harness runs single-space.
    // Two spaces sync the same integration against the same upstream id:
    // the second space's write hit a unique violation on a row it cannot
    // see, does not own, and has no way to reach — surfacing as a 500,
    // because the create path's violation trap deliberately excludes this
    // index and its own pre-check had already filtered the row away.
    const shared = { source: "feed-shared", source_id: "upstream-shared" };
    const inA = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { title: "space A's copy", body: "x" },
        ...shared,
      },
      "space-a",
    );
    const inB = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { title: "space B's copy", body: "x" },
        ...shared,
      },
      "space-b",
    );
    expect(inB.id).not.toBe(inA.id);

    // Each space still resolves its own row by the natural key, which is
    // what makes the re-sync land on the right corpus.
    const backA = await ctx.storage.items.findBySourceId(
      shared.source,
      shared.source_id,
      "space-a",
    );
    const backB = await ctx.storage.items.findBySourceId(
      shared.source,
      shared.source_id,
      "space-b",
    );
    expect(backA?.id).toBe(inA.id);
    expect(backB?.id).toBe(inB.id);
  });

  it("still refuses a duplicate inside one space", async () => {
    const shared = { source: "feed-inner", source_id: "upstream-inner" };
    await ctx.storage.items.create(
      { type: "core.note", properties: { title: "one", body: "x" }, ...shared },
      "space-c",
    );
    await expect(
      ctx.storage.items.create(
        {
          type: "core.note",
          properties: { title: "two", body: "x" },
          ...shared,
        },
        "space-c",
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("dedupes a space-less caller against the null-space bucket, not every space", async () => {
    // The pre-check's space predicate used to be conditional, so a caller
    // with no space (the operator key) deduped
    // against every space's rows. A space-less write must not collide
    // with a row that belongs to a space.
    const shared = { source: "feed-nullspace", source_id: "upstream-null" };
    await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { title: "in a space", body: "x" },
        ...shared,
      },
      "space-d",
    );
    const spaceless = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { title: "no space", body: "x" },
        ...shared,
      },
      undefined,
    );
    // Two distinct rows: the space-less write did not collide with, or
    // resolve to, the row that belongs to a space.
    const inSpace = await ctx.storage.items.findBySourceId(
      shared.source,
      shared.source_id,
      "space-d",
    );
    expect(inSpace?.id).not.toBe(spaceless.id);
  });
});

describe("a mirror the user trashed", () => {
  it("accepts the next re-sync instead of refusing it forever", async () => {
    // The wedge. `findBySourceId` hides a trashed row, so the upsert door
    // saw "not found" and fell into create — whose own dedup pre-check
    // does not filter state, found the same row, and refused with a 409.
    // Nothing clears that: the row stays trashed, so every later sync
    // fails identically and the integration is stuck on one item.
    const k = await integrationKey("prov-trash", "feed-trash");
    const body = {
      type: "core.note",
      properties: { title: "mirrored upstream", body: "x" },
      source_id: "upstream-trashed",
    };
    const created = await request(ctx.app, "POST", "/items", { key: k, body });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { item: { id: string } }).item.id;

    const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.spaceKey,
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
    const stored = await ctx.storage.items.findBySourceIdIncludingTrashed(
      "feed-trash",
      "upstream-trashed",
      undefined,
    );
    expect(stored?.id).toBe(id);
    expect(stored?.state).toBe("trashed");
    expect(stored?.properties.title).toBe("mirrored upstream");
  });

  it("resumes ordinary updates once the user restores it", async () => {
    // The acknowledge is a hold, not a tombstone.
    const k = await integrationKey("prov-restore", "feed-restore");
    const body = {
      type: "core.note",
      properties: { title: "before", body: "x" },
      source_id: "upstream-restored",
    };
    const created = await request(ctx.app, "POST", "/items", { key: k, body });
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.spaceKey });
    await request(ctx.app, "POST", `/items/${id}/restore`, {
      key: ctx.spaceKey,
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
