/**
 * A bulk action reaches no connection at all.
 *
 * `POST /items/bulk-actions` takes a filter, not a list, so a filter naming
 * `system.connection` addresses every connection in the space at once. A purge
 * of that match set would hard-delete every live grant outright, since
 * `bulkPurge` carries no soft-delete gate of its own, leaving the app's tokens
 * and stored consent behind with nothing listing them.
 *
 * The door's reserved-namespace narrowing is what stands in front of that, and
 * it closes on both axes at once. It admits a reserved type only for a
 * credential that may write it, and beyond the `system.activity` carve-out
 * `mayWriteReserved` admits only the operator tier — while the operator key's
 * own type map is empty, so the writable-type filter beside it narrows that
 * caller to nothing in turn. The two rules meet in the middle and no
 * credential the product mints falls between them, which the database itself
 * guarantees: `CHECK ((space_id IS NULL) = (is_operator = 1))` makes the
 * operator tier and a space binding mutually exclusive, so a wide map and
 * operator authority cannot coexist on one row.
 *
 * So the assertions are the outcome rather than the mechanism: the match set
 * is empty, and every connection is still standing afterwards, live and
 * revoked alike.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/**
 * A connection row in the context's space, written through the storage layer.
 *
 * `system.connection` is a reserved namespace, so no credential writes one and
 * the grant routes and the integrations runtime put these rows down through
 * the store directly. Seeding the same way is what a bulk action actually
 * meets; driving it through `POST /items` would only be watching the namespace
 * fence refuse a fixture.
 */
async function seedConnection(
  c: TestContext,
  status: "active" | "revoked",
): Promise<string> {
  const item = await c.storage.items.create(
    {
      type: "system.connection",
      properties: { kind: "app", status, granted_at: new Date().toISOString() },
    },
    c.spaceId,
  );
  return item.id;
}

describe("bulk actions spare every connection", () => {
  it("a transition naming connections matches none of them, under either credential", async () => {
    // The action's schema admits `active`, `archived` and `trashed`, so
    // `trashed` is the shape a caller can send. Both credentials are asked,
    // because they are narrowed by opposite halves of the same rule and a
    // regression in either half would reopen the door on its own.
    ctx = await createTestContext();
    const live = await seedConnection(ctx, "active");
    const tombstone = await seedConnection(ctx, "revoked");

    for (const [name, key] of [
      ["the working key", ctx.spaceKey],
      ["the operator key", ctx.operatorKey],
    ] as const) {
      const { result } = await runBulkActionAsync(
        ctx,
        {
          action: "transition",
          state: "trashed",
          filter: { type: "system.connection" },
        },
        key,
      );
      expect(result?.matched, name).toBe(0);
      expect(result?.succeeded, name).toBe(0);
      expect(result?.errors ?? [], name).toEqual([]);
    }

    // Both rows untouched on both axes: the lifecycle state and the status
    // the grant routes own.
    for (const id of [live, tombstone]) {
      const row = await ctx.storage.items.get(id);
      expect(row?.state).toBe("active");
    }
    expect((await ctx.storage.items.get(live))?.properties.status).toBe(
      "active",
    );
    expect((await ctx.storage.items.get(tombstone))?.properties.status).toBe(
      "revoked",
    );
  });

  it("a purge naming connections removes neither the live grant nor the revoked one", async () => {
    ctx = await createTestContext();
    const live = await seedConnection(ctx, "active");
    const tombstone = await seedConnection(ctx, "revoked");

    // An edge on the live grant: the edge deletes run on whatever the match
    // set holds, so it has to survive with the row.
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { title: "n", body: "holds the grant" },
      },
    });
    expect(note.status).toBe(201);
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.spaceKey,
      body: { source_id: noteId, target_id: live, edge_type: "references" },
    });
    expect(edge.status).toBe(201);
    const edgeId = ((await edge.json()) as { edge: { id: string } }).edge.id;

    const { result } = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { type: "system.connection" },
      },
      ctx.spaceKey,
    );
    expect(result?.matched).toBe(0);
    expect(result?.succeeded).toBe(0);

    // Nothing was destroyed, and the revoked row is asserted beside the live
    // one on purpose: a narrowing that spared only what it recognized as live
    // would still have hard-deleted this one.
    expect(await ctx.storage.items.get(live)).not.toBeNull();
    expect(await ctx.storage.items.get(tombstone)).not.toBeNull();
    expect(await ctx.storage.edges.get(edgeId)).not.toBeNull();

    // And the operator key is no way round it: purging is gated on
    // `space.item_purge`, which the instance tier does not hold.
    const asOperator = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { type: "system.connection" },
      },
      ctx.operatorKey,
    );
    expect(asOperator.initialStatus).toBe(403);
    expect(await ctx.storage.items.get(live)).not.toBeNull();
  });
});
