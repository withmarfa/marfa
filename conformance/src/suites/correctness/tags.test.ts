import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "tags"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("tags", () => {
  it("creates an item with tags and returns them correctly", async () => {
    const note = createNote({
      source: ctx.source,
      tags: ["work", "starred"],
    });

    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    const itemId = r.data.item.id;
    trackItem(ctx, itemId);

    const fetched = await client.getItem(itemId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.metadata.tags).toContain("work");
    expect(fetched.data.metadata.tags).toContain("starred");
  });

  it("updates tags via metadata PATCH", async () => {
    const note = createNote({
      source: ctx.source,
      tags: ["initial"],
    });

    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    const itemId = r.data.item.id;
    trackItem(ctx, itemId);

    // The server merges tags as a set union, so the initial tag survives.
    const updated = await client.updateMetadata(itemId, {
      tags: ["updated", "new-tag"],
    });
    expect(updated.ok).toBe(true);
    await expectMatchesSchema(
      "PATCH",
      "/items/{id}/metadata",
      200,
      updated.data,
    );
    // The whole set, not three memberships: a merge that added a tag nobody
    // asked for would satisfy three `toContain` checks.
    expect([...updated.data.metadata.tags].sort()).toEqual([
      "initial",
      "new-tag",
      "updated",
    ]);
  });

  it("filters items by tag in queries", async () => {
    const uniqueTag = `tag-test-${generateId().slice(0, 8)}`;

    const tagged = createNote({
      source: ctx.source,
      tags: [uniqueTag],
    });
    const r1 = await client.createItem(tagged);
    expect(r1.ok).toBe(true);
    trackItem(ctx, r1.data.item.id);

    const untagged = createNote({ source: ctx.source });
    const r2 = await client.createItem(untagged);
    expect(r2.ok).toBe(true);
    trackItem(ctx, r2.data.item.id);

    const list = await client.listItems({ tags: [uniqueTag] });
    expect(list.ok).toBe(true);

    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(r1.data.item.id);
    expect(ids).not.toContain(r2.data.item.id);
  });

  it("tags persist across getItem calls", async () => {
    const r = await client.createItem(
      createNote({ source: ctx.source, tags: ["persist-test"] }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.metadata.tags).toContain("persist-test");
  });

  it("refuses a metadata patch whose tags are not an array, and answers 404 for an unknown item", async () => {
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    const malformed = await client.rawRequest(
      `/items/${r.data.item.id}/metadata`,
      { method: "PATCH", body: { tags: "x" } },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");

    const unknown = "00000000-0000-7000-8000-000000000000";
    const patched = await client.updateMetadata(unknown, { tags: ["x"] });
    expect(patched.status).toBe(404);
    expect(patched.error?.error.code).toBe("item_not_found");
    const removed = await client.removeTag(unknown, "x");
    expect(removed.status).toBe(404);
    expect(removed.error?.error.code).toBe("item_not_found");
  });

  it("accepts empty tags array", async () => {
    const note = createNote({
      source: ctx.source,
      tags: [],
    });

    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.metadata.tags).toEqual([]);
  });
});

describe("favorite reserved tag", () => {
  it("favorite persists when added via metadata PATCH", async () => {
    const r = await client.createItem(
      createNote({ source: ctx.source, tags: ["env:test"] }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const patched = await client.updateMetadata(r.data.item.id, {
      tags: ["favorite"],
    });
    expect(patched.ok).toBe(true);
    expect(patched.data.metadata.tags).toContain("favorite");
    expect(patched.data.metadata.tags).toContain("env:test");
  });

  it("filtering by tags=[favorite] returns tagged items and excludes others", async () => {
    const tagged = await client.createItem(
      createNote({ source: ctx.source, tags: ["env:test", "favorite"] }),
    );
    expect(tagged.ok).toBe(true);
    trackItem(ctx, tagged.data.item.id);

    const untagged = await client.createItem(
      createNote({ source: ctx.source, tags: ["env:test"] }),
    );
    expect(untagged.ok).toBe(true);
    trackItem(ctx, untagged.data.item.id);

    const list = await client.listItems({
      tags: ["favorite"],
      source: ctx.source,
    });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(tagged.data.item.id);
    expect(ids).not.toContain(untagged.data.item.id);
  });

  it("favorite can be removed via DELETE /items/:id/tags/favorite", async () => {
    const r = await client.createItem(
      createNote({ source: ctx.source, tags: ["env:test", "favorite"] }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const kept = await client.createItem(
      createNote({ source: ctx.source, tags: ["favorite"] }),
    );
    expect(kept.ok).toBe(true);
    trackItem(ctx, kept.data.item.id);

    const removed = await client.removeTag(r.data.item.id, "favorite");
    expect(removed.ok).toBe(true);
    await expectMatchesSchema(
      "DELETE",
      "/items/{id}/tags/{tag}",
      200,
      removed.data,
    );
    expect(removed.data.metadata.tags).not.toContain("favorite");
    expect(removed.data.metadata.tags).toContain("env:test");

    const list = await client.listItems({
      tags: ["favorite"],
      source: ctx.source,
    });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(kept.data.item.id);
    expect(ids).not.toContain(r.data.item.id);
  });

  it("favorite is not a separate metadata field — it lives in tags", async () => {
    const r = await client.createItem(
      createNote({ source: ctx.source, tags: ["favorite"] }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.metadata.tags).toContain("favorite");
    expect(
      (fetched.data.metadata as unknown as Record<string, unknown>).favorite,
    ).toBeUndefined();
    expect(
      (fetched.data.item as unknown as Record<string, unknown>).favorite,
    ).toBeUndefined();
  });
});
