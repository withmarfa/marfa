/**
 * The bulk doors narrow a live connection out rather than moving it.
 *
 * `POST /items/bulk-actions` takes a filter, not a list, and a filter naming
 * `system.connection` matches every connection in the space. A purge would
 * hard-delete every live grant outright, since `bulkPurge` carries no
 * soft-delete gate of its own. A transition out of `active` is refused by
 * the lifecycle table for a `system.*` type in any case; the refusal here
 * is defence in depth and decides which answer the caller reads. Both skip
 * a live connection with a `connection_live` entry naming the door that
 * retires it properly, act on the rest, and a skipped row is not a chunk
 * failure, so what did purge is still announced.
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

async function seedConnection(
  c: TestContext,
  status: "active" | "revoked",
): Promise<string> {
  const res = await request(c.app, "POST", "/items", {
    key: c.adminKey,
    body: {
      type: "system.connection",
      properties: { kind: "app", status, granted_at: new Date().toISOString() },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("bulk actions spare a live connection", () => {
  it("a bulk transition out of active skips the live grant with an entry naming the grant routes", async () => {
    // The action's schema admits `active`, `archived` and `trashed`, so
    // `trashed` is the shape a caller can send. The live row is narrowed
    // out before the store's own transition rules get to answer, so the
    // entry names the door that retires a grant rather than a lifecycle
    // complaint about a system type.
    ctx = await createTestContext();
    const live = await seedConnection(ctx, "active");
    const tombstone = await seedConnection(ctx, "revoked");

    const { result } = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "trashed",
        filter: { type: "system.connection" },
      },
      ctx.adminKey,
    );
    const liveEntry = result?.errors?.find((e) => e.id === live);
    expect(liveEntry?.code).toBe("connection_live");
    expect(liveEntry?.message).toContain(`/auth/grants/${live}`);
    // The tombstone reaches the store, which refuses the lifecycle move for
    // a system type: a different entry, and the row unchanged on both axes.
    const tombstoneEntry = result?.errors?.find((e) => e.id === tombstone);
    expect(tombstoneEntry).toBeDefined();
    expect(tombstoneEntry?.code).not.toBe("connection_live");
    const tombstoneRow = await ctx.storage.items.get(tombstone);
    expect(tombstoneRow?.state).toBe("active");
    expect(tombstoneRow?.properties.status).toBe("revoked");
    const row = await ctx.storage.items.get(live);
    expect(row?.state).toBe("active");
    expect(row?.properties.status).toBe("active");
  });

  it("a bulk purge skips the live grant, its edges included, and removes the revoked one", async () => {
    ctx = await createTestContext();
    const live = await seedConnection(ctx, "active");
    const tombstone = await seedConnection(ctx, "revoked");
    // An edge on the live grant: the edge deletes run on the narrowed ids
    // too, so it has to survive with the row.
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { title: "n", body: "holds the grant" },
      },
    });
    expect(note.status).toBe(201);
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
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
      ctx.adminKey,
    );
    expect(result?.errors?.map((e) => e.id)).toEqual([live]);
    expect(result?.errors?.[0]?.code).toBe("connection_live");
    expect(await ctx.storage.items.get(live)).not.toBeNull();
    expect(await ctx.storage.items.get(tombstone)).toBeNull();
    // The edge deletes run on the narrowed ids too, so the live grant's
    // edge is still there.
    expect(await ctx.storage.edges.get(edgeId)).not.toBeNull();
    // A narrowed row is not a chunk failure: what did purge is counted, and
    // announced.
    expect(result?.succeeded).toBe(1);
  });
});
