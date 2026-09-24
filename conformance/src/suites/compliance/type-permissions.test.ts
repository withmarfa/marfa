import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote, createBookmark } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-permissions",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("type-scoped permissions", () => {
  it("scoped key can create items of permitted type", async () => {
    const keyResp = await client.createKey({
      label: "bookmark-only-write",
      source: `${ctx.source}-${"bookmark-only-write"}`,
      type_permissions: { "core.bookmark": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const bookmark = createBookmark();
    const r = await scopedClient.createItem(bookmark);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
  });

  it("scoped key cannot create items of non-permitted type", async () => {
    const keyResp = await client.createKey({
      label: "bookmark-only-write-2",
      source: `${ctx.source}-${"bookmark-only-write-2"}`,
      type_permissions: { "core.bookmark": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const note = createNote();
    const r = await scopedClient.createItem(note);
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("type_not_permitted");
    expect(r.error?.error.code).toBe("type_not_permitted");
  });

  it("wildcard pattern matches all types in namespace", async () => {
    const keyResp = await client.createKey({
      label: "core-wildcard",
      source: `${ctx.source}-${"core-wildcard"}`,
      type_permissions: { "core.*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const note = createNote();
    const r1 = await scopedClient.createItem(note);
    expect(r1.ok).toBe(true);
    trackItem(ctx, r1.data.item.id);

    const bookmark = createBookmark();
    const r2 = await scopedClient.createItem(bookmark);
    expect(r2.ok).toBe(true);
    trackItem(ctx, r2.data.item.id);
  });

  it("none permission denies access to specific type", async () => {
    const keyResp = await client.createKey({
      label: "bookmark-none",
      source: `${ctx.source}-${"bookmark-none"}`,
      type_permissions: { "core.bookmark": "none", "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // `none` overrides the `*` wildcard for this specific type.
    const bookmark = createBookmark();
    const r = await scopedClient.createItem(bookmark);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("type_not_permitted");
  });

  it("none permission hides the type from a listing, not only from a write", async () => {
    // A `none` entry has to reach the list filter, not only the write gate:
    // a caller refused a row by id and handed that same row in a listing is
    // the divergence a permission map exists to prevent.
    const seededNote = await client.createItem(
      createNote({ source: ctx.source }),
    );
    expect(seededNote.ok).toBe(true);
    trackItem(ctx, seededNote.data.item.id);

    const seededBookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(seededBookmark.ok).toBe(true);
    trackItem(ctx, seededBookmark.data.item.id);

    const keyResp = await client.createKey({
      label: "bookmark-none-list",
      source: `${ctx.source}-${"bookmark-none-list"}`,
      type_permissions: { "core.bookmark": "none", "*": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // Asserted before the refusal, so an empty page cannot satisfy the
    // negative below. A listing that returned nothing at all would pass
    // "the bookmark is absent" while proving the opposite of the point.
    const listed = await scopedClient.listItems({
      source: ctx.source,
      limit: 100,
    });
    expect(listed.ok).toBe(true);
    const ids = listed.data.data.map((item) => item.id);
    expect(ids).toContain(seededNote.data.item.id);

    expect(ids).not.toContain(seededBookmark.data.item.id);

    // And the by-id read agrees with the listing, which is the property
    // under test rather than either half on its own.
    const byId = await scopedClient.getItem(seededBookmark.data.item.id);
    expect(byId.ok).toBe(false);
    expect(byId.status).toBe(403);
  });

  it("read-only key cannot create items", async () => {
    const keyResp = await client.createKey({
      label: "read-only",
      source: `${ctx.source}-${"read-only"}`,
      type_permissions: { "core.bookmark": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const bookmark = createBookmark();
    const r = await scopedClient.createItem(bookmark);
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("type_not_permitted");
  });

  it("key response includes type_permissions", async () => {
    const keyResp = await client.createKey({
      label: "check-response",
      source: `${ctx.source}-${"check-response"}`,
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    expect(keyResp.data.type_permissions).toBeDefined();
    expect(keyResp.data.type_permissions["core.note"]).toBe("write");
    expect(keyResp.data.type_permissions["core.bookmark"]).toBe("read");
  });

  // DELETE /items/:id runs the type-permission gate before the cascade
  // delete, so a scoped read-only key cannot destroy items of the permitted
  // type.
  it("read-only scoped key cannot DELETE items of that type", async () => {
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const keyResp = await client.createKey({
      label: "note-read-only-delete",
      source: `${ctx.source}-note-read-only-delete`,
      type_permissions: { "core.note": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);

    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const readBack = await scopedClient.getItem(note.data.item.id);
    expect(readBack.ok).toBe(true);

    // The gate fires before the cascade delete, not after: a read-only key
    // must not be able to destroy the items it may read.
    const del = await scopedClient.deleteItem(note.data.item.id);
    expect(del.ok).toBe(false);
    expect(del.status).toBe(403);
    expect(del.error?.error.code).toBe("type_not_permitted");

    const trashed = await client.deleteItem(note.data.item.id);
    expect(trashed.ok).toBe(true);

    // Once trashed, the row is invisible to the scoped key before the type
    // gate is reached.
    const delTrashed = await scopedClient.deleteItem(note.data.item.id);
    expect(delTrashed.status).toBe(404);
    expect(delTrashed.error?.error.code).toBe("item_not_found");
  });

  it("a key without reach on the item's type is refused its edges and backrefs", async () => {
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const keyResp = await client.createKey({
      label: "bookmark-only-read",
      source: `${ctx.source}-bookmark-only-read`,
      type_permissions: { "core.bookmark": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const byId = await scopedClient.getItem(note.data.item.id);
    expect(byId.status).toBe(403);
    expect(byId.error?.error.code).toBe("type_not_permitted");
    const edges = await scopedClient.listItemEdges(note.data.item.id);
    expect(edges.status).toBe(403);
    expect(edges.error?.error.code).toBe("type_not_permitted");
    const backrefs = await scopedClient.listItemBackrefs(note.data.item.id);
    expect(backrefs.status).toBe(403);
    expect(backrefs.error?.error.code).toBe("type_not_permitted");
  });

  it("a key without items.purge cannot purge", async () => {
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    expect((await client.deleteItem(note.data.item.id)).ok).toBe(true);

    const keyResp = await client.createKey({
      label: "no-purge",
      source: `${ctx.source}-no-purge`,
      permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const purged = await scopedClient.purgeItem(note.data.item.id);
    expect(purged.status).toBe(403);
    expect(purged.error?.error.code).toBe("forbidden");
    expect(purged.error?.error.details?.required_scope).toBe("items.purge");
  });
});
