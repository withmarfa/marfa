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
    // a caller told a row is not there by id and handed that same row in a
    // listing is the divergence a permission map exists to prevent.
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
    expect(byId.status).toBe(404);
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

  it("a key without reach on the item's type is answered as if the item, its edges and its backrefs were not there", async () => {
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
    expect(byId.status).toBe(404);
    expect(byId.error?.error.code).toBe("item_not_found");
    const edges = await scopedClient.listItemEdges(note.data.item.id);
    expect(edges.status).toBe(404);
    expect(edges.error?.error.code).toBe("item_not_found");
    const backrefs = await scopedClient.listItemBackrefs(note.data.item.id);
    expect(backrefs.status).toBe(404);
    expect(backrefs.error?.error.code).toBe("item_not_found");

    // The key reads its own map, which is where it learns why.
    const own = await scopedClient.getCurrentKey();
    expect(own.ok).toBe(true);
    expect(own.data.type_permissions).toEqual({ "core.bookmark": "read" });
  });

  // `items.purge` opens the door; the type map says which rows it destroys,
  // trashed ones included, as restore asks.
  it("a key that may only read a type cannot purge a trashed row of it", async () => {
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(true);
    trackItem(ctx, bookmark.data.item.id);
    expect((await client.deleteItem(note.data.item.id)).ok).toBe(true);
    expect((await client.deleteItem(bookmark.data.item.id)).ok).toBe(true);

    const keyResp = await client.createKey({
      label: "purge-bookmark-read-only",
      source: `${ctx.source}-purge-bookmark-read-only`,
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // Restore refuses this key the same row; purge must agree.
    const restore = await scopedClient.restoreItem(bookmark.data.item.id);
    expect(restore.status).toBe(403);
    expect(restore.error?.error.code).toBe("type_not_permitted");

    const purged = await scopedClient.purgeItem(bookmark.data.item.id);
    expect(purged.status).toBe(403);
    expect(purged.error?.error.code).toBe("type_not_permitted");

    // Still there: a key that may write the type brings it back.
    const restoredByOwner = await client.restoreItem(bookmark.data.item.id);
    expect(restoredByOwner.status).toBe(200);

    // The witness: the same key purges a trashed row of a type it writes.
    const purgedNote = await scopedClient.purgeItem(note.data.item.id);
    expect(purgedNote.status).toBe(200);
  });

  it("refuses a read-only key a purge of a live row, 403 type_not_permitted", async () => {
    const note = await client.createItem(createNote({ source: ctx.source }));
    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(note.ok && bookmark.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    trackItem(ctx, bookmark.data.item.id);

    const keyResp = await client.createKey({
      label: "purge-live-read-only",
      source: `${ctx.source}-purge-live-read-only`,
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const purged = await scopedClient.purgeItem(bookmark.data.item.id);
    expect(purged.status).toBe(403);
    expect(purged.error?.error.code).toBe("type_not_permitted");
    expect((await client.getItem(bookmark.data.item.id)).ok).toBe(true);

    // The witness: the same key, asked to purge a live row of a type it
    // writes, is let past the type gate and refused for the row's state.
    const own = await scopedClient.purgeItem(note.data.item.id);
    expect(own.status).toBe(400);
    expect(own.error?.error.code).toBe("invalid_transition");
  });

  it("answers 404 item_not_found to a purge of a row whose type the key cannot read", async () => {
    const live = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    const binned = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(live.ok && binned.ok && note.ok).toBe(true);
    for (const created of [live, binned, note]) {
      trackItem(ctx, created.data.item.id);
    }
    expect((await client.deleteItem(binned.data.item.id)).ok).toBe(true);
    expect((await client.deleteItem(note.data.item.id)).ok).toBe(true);

    const keyResp = await client.createKey({
      label: "purge-hidden-type",
      source: `${ctx.source}-purge-hidden-type`,
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    for (const [label, id] of [
      ["a live row", live.data.item.id],
      ["a trashed row", binned.data.item.id],
    ] as const) {
      const purged = await scopedClient.purgeItem(id);
      expect(
        [purged.status, purged.error?.error.code],
        `${label} of a type the key cannot read`,
      ).toEqual([404, "item_not_found"]);
    }
    expect((await client.getItem(live.data.item.id)).ok).toBe(true);
    expect(
      (await client.restoreItem(binned.data.item.id)).ok,
      "a refused purge destroyed the row",
    ).toBe(true);

    // The witness: the same key purges a trashed row of a type it reads.
    const purgedNote = await scopedClient.purgeItem(note.data.item.id);
    expect(purgedNote.status).toBe(200);
  });

  it("refuses a retype into a type the key may not write", async () => {
    const bookmark = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      properties: { url: "https://example.com/retype", body: "Kept" },
    });
    expect(bookmark.ok, JSON.stringify(bookmark.error)).toBe(true);
    trackItem(ctx, bookmark.data.item.id);
    const writable = await client.createItem({
      type: "core.bookmark",
      source: ctx.source,
      properties: { url: "https://example.com/retype-ok", body: "Kept" },
    });
    expect(writable.ok).toBe(true);
    trackItem(ctx, writable.data.item.id);

    const mint = async (
      label: string,
      type_permissions: Record<string, string>,
    ): Promise<MarfaClient> => {
      const minted = await client.createKey({
        label,
        source: `${ctx.source}-${label}`,
        type_permissions,
      });
      expect(minted.ok).toBe(true);
      trackKey(ctx, minted.data.id);
      return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    };
    const readsNotes = await mint("retype-reads-notes", {
      "core.bookmark": "write",
      "core.note": "read",
    });

    const refused = await readsNotes.updateItem(bookmark.data.item.id, {
      type: "core.note",
      retype: true,
      version: bookmark.data.item.version,
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    const kept = await client.getItem(bookmark.data.item.id);
    expect(kept.data.item.type).toBe("core.bookmark");
    expect(kept.data.item.version).toBe(bookmark.data.item.version);

    // The witness: a key that writes the destination moves a row the same
    // way, so the refusal above is the grant on the type entered.
    const writesNotes = await mint("retype-writes-notes", {
      "core.bookmark": "write",
      "core.note": "write",
    });
    const moved = await writesNotes.updateItem(writable.data.item.id, {
      type: "core.note",
      retype: true,
      version: writable.data.item.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.item.type).toBe("core.note");
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
