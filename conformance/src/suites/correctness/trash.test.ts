import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "trash"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("trash — soft delete and restore", () => {
  it("deleted item is hidden from default queries", async () => {
    const note = createNote({ source: ctx.source });
    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    let list = await client.listItems({ type: "core.note", limit: 100 });
    expect(list.ok).toBe(true);
    let found = list.data.data.find((i) => i.id === itemId);
    expect(found).toBeDefined();

    const del = await client.deleteItem(itemId);
    expect(del.ok).toBe(true);
    await expectMatchesSchema("DELETE", "/items/{id}", 200, del.data);

    list = await client.listItems({ type: "core.note", limit: 100 });
    found = list.data.data.find((i) => i.id === itemId);
    expect(found).toBeUndefined();

    const again = await client.deleteItem(itemId);
    expect(again.status).toBe(404);
    expect(again.error?.error.code).toBe("item_not_found");
  });

  it("deleted item returns 404 on direct get", async () => {
    const note = createNote({ source: ctx.source });
    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    await client.deleteItem(itemId);

    const fetched = await client.getItem(itemId);
    expect(fetched.status).toBe(404);
  });

  it("deleted item can be restored", async () => {
    const note = createNote({ source: ctx.source });
    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    expect((await client.deleteItem(itemId)).ok).toBe(true);
    const restored = await client.restoreItem(itemId);
    expect(restored.ok).toBe(true);
    await expectMatchesSchema(
      "POST",
      "/items/{id}/restore",
      200,
      restored.data,
    );
    expect(restored.data.item.id).toBe(itemId);

    const fetched = await client.getItem(itemId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.id).toBe(itemId);
  });

  it("restoring a non-deleted item returns error", async () => {
    const note = createNote({ source: ctx.source });
    const created = await client.createItem(note);
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);

    const restored = await client.restoreItem(itemId);
    expect(restored.status).toBe(400);
    expect(restored.error?.error.code).toBe("invalid_transition");
  });

  it("purges a trashed item, after which every read answers 404", async () => {
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect((await client.deleteItem(r.data.item.id)).ok).toBe(true);
    const purged = await client.purgeItem(r.data.item.id);
    expect(purged.ok).toBe(true);
    await expectMatchesSchema("POST", "/items/{id}/purge", 200, purged.data);
    const read = await client.getItem(r.data.item.id);
    expect(read.status).toBe(404);
    expect(read.error?.error.code).toBe("item_not_found");
    const restored = await client.restoreItem(r.data.item.id);
    expect(restored.status).toBe(404);
    expect(restored.error?.error.code).toBe("item_not_found");
    const again = await client.purgeItem(r.data.item.id);
    expect(again.status).toBe(404);
    expect(again.error?.error.code).toBe("item_not_found");
  });

  it("refuses to purge an item that is not trashed", async () => {
    // The same code the restore door beside it answers for the same class
    // of mistake: a lifecycle move the graph does not allow. The two doors
    // are the two halves of one question — what may happen to a row in the
    // state it is in — and a caller that sorted their refusals apart would
    // be sorting on which door it asked rather than on what was wrong.
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const purged = await client.purgeItem(r.data.item.id);
    expect(purged.status).toBe(400);
    expect(purged.error?.error.code).toBe("invalid_transition");
    const still = await client.getItem(r.data.item.id);
    expect(still.ok).toBe(true);
  });
});
