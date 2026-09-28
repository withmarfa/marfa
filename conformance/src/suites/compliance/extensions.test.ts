import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackFolder,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "extensions",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const UNKNOWN_ITEM = "00000000-0000-7000-8000-000000000000";

describe("metadata extensions", () => {
  let itemId: string;

  beforeAll(async () => {
    const r = await client.createItem(createNote({ source: ctx.source }));
    expect(r.ok).toBe(true);
    itemId = r.data.item.id;
    trackItem(ctx, itemId);
  });

  it("writes extension data to a namespace", async () => {
    const r = await client.setItemExtension(itemId, "test-app", {
      score: 42,
      label: "important",
    });
    expect(r.ok).toBe(true);
    await expectMatchesSchema(
      "PUT",
      "/items/{id}/extensions/{namespace}",
      200,
      r.data,
    );
    expect(r.data.extensions["test-app"]).toEqual({
      score: 42,
      label: "important",
    });
  });

  it("reads all extensions", async () => {
    const r = await client.listItemExtensions(itemId);
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}/extensions", 200, r.data);
    expect(r.data.extensions["test-app"]).toEqual({
      score: 42,
      label: "important",
    });
  });

  it("reads a specific namespace", async () => {
    const r = await client.getItemExtension(itemId, "test-app");
    expect(r.ok).toBe(true);
    await expectMatchesSchema(
      "GET",
      "/items/{id}/extensions/{namespace}",
      200,
      r.data,
    );
    expect((r.data as unknown as { namespace: string }).namespace).toBe(
      "test-app",
    );
    expect(r.data.data).toEqual({ score: 42, label: "important" });
  });

  it("overwrites extension on second PUT", async () => {
    const put = await client.setItemExtension(itemId, "test-app", {
      score: 99,
    });
    expect(put.ok).toBe(true);
    const r = await client.getItemExtension(itemId, "test-app");
    expect(r.ok).toBe(true);
    expect(r.data.data).toEqual({ score: 99 });
    expect(r.data.data).not.toHaveProperty("label");
  });

  it("writes multiple namespaces independently", async () => {
    expect((await client.setItemExtension(itemId, "app-a", { a: 1 })).ok).toBe(
      true,
    );
    expect((await client.setItemExtension(itemId, "app-b", { b: 2 })).ok).toBe(
      true,
    );
    const r = await client.listItemExtensions(itemId);
    expect(r.ok).toBe(true);
    expect(r.data.extensions["app-a"]).toEqual({ a: 1 });
    expect(r.data.extensions["app-b"]).toEqual({ b: 2 });
  });

  it("deletes a namespace, after which its read answers 200 with null data", async () => {
    const put = await client.setItemExtension(itemId, "to-delete", {
      temp: true,
    });
    expect(put.ok).toBe(true);
    const removed = await client.deleteItemExtension(itemId, "to-delete");
    expect(removed.ok).toBe(true);
    await expectMatchesSchema(
      "DELETE",
      "/items/{id}/extensions/{namespace}",
      200,
      removed.data,
    );
    expect(removed.data.extensions).not.toHaveProperty("to-delete");

    const r = await client.getItemExtension(itemId, "to-delete");
    expect(r.status).toBe(200);
    expect(r.data.data).toBeNull();
  });

  it("extensions persist on the item's metadata read", async () => {
    const put = await client.setItemExtension(itemId, "persist-test", {
      persisted: true,
    });
    expect(put.ok).toBe(true);
    const r = await client.getMetadata(itemId);
    expect(r.ok).toBe(true);
    expect(r.data.metadata.extensions?.["persist-test"]).toEqual({
      persisted: true,
    });
  });

  it("answers 404 for an unknown item and 400 for a malformed id on every door", async () => {
    for (const r of [
      await client.listItemExtensions(UNKNOWN_ITEM),
      await client.getItemExtension(UNKNOWN_ITEM, "x"),
      await client.setItemExtension(UNKNOWN_ITEM, "x", { a: 1 }),
      await client.deleteItemExtension(UNKNOWN_ITEM, "x"),
    ]) {
      expect(r.status).toBe(404);
      expect(r.error?.error.code).toBe("item_not_found");
    }
    const malformed = await client.listItemExtensions("not-an-id");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("invalid_id");
  });

  it("refuses a key without reach on the namespace", async () => {
    // Write on the item's type and no extension map, so the namespace is
    // the only gate left to refuse it.
    const keyResp = await client.createKey({
      label: "extensions-narrow",
      source: `${ctx.source}-extensions-narrow`,
      permissions: [],
      type_permissions: { "core.note": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrowed = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const read = await narrowed.getItemExtension(itemId, "test-app");
    expect(read.status).toBe(403);
    expect(read.error?.error.code).toBe("forbidden");
    const write = await narrowed.setItemExtension(itemId, "test-app", { x: 1 });
    expect(write.status).toBe(403);
    expect(write.error?.error.code).toBe("forbidden");
    const remove = await narrowed.deleteItemExtension(itemId, "test-app");
    expect(remove.status).toBe(403);
    expect(remove.error?.error.code).toBe("forbidden");
  });

  it("refuses every door on an item whose type the key does not hold, as the item doors refuse it", async () => {
    const ns = "type-gated";
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(bookmark.ok).toBe(true);
    trackItem(ctx, bookmark.data.item.id);
    const folder = await client.createFolder({ title: "extension type gate" });
    expect(folder.status).toBe(201);
    trackFolder(ctx, folder.data.item.id);

    // Write on one type and on the namespace, and nothing else.
    const keyResp = await client.createKey({
      label: "extensions-note-writer",
      source: `${ctx.source}-extensions-note-writer`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      extension_permissions: { [ns]: "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const writer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // The witness: every door admits this key on the type it holds.
    const noteId = note.data.item.id;
    expect((await writer.setItemExtension(noteId, ns, { a: 1 })).status).toBe(
      200,
    );
    const ownRead = await writer.getItemExtension(noteId, ns);
    expect(ownRead.status).toBe(200);
    expect(ownRead.data.data).toEqual({ a: 1 });
    const ownList = await writer.listItemExtensions(noteId);
    expect(ownList.status).toBe(200);
    expect(ownList.data.extensions[ns]).toEqual({ a: 1 });
    expect((await writer.deleteItemExtension(noteId, ns)).status).toBe(200);

    for (const target of [bookmark.data.item, folder.data.item]) {
      const before = await client.getItem(target.id);
      expect(before.ok).toBe(true);

      // What the item doors answer this key for the same row.
      const itemRead = await writer.getItem(target.id);
      expect(itemRead.status).toBe(403);
      expect(itemRead.error?.error.code).toBe("type_not_permitted");
      const itemWrite = await writer.updateItem(target.id, {
        version: target.version,
        properties: { title: "not written" },
      });
      expect(itemWrite.status).toBe(403);
      expect(itemWrite.error?.error.code).toBe("type_not_permitted");

      for (const r of [
        await writer.listItemExtensions(target.id),
        await writer.getItemExtension(target.id, ns),
      ]) {
        expect(r.status).toBe(itemRead.status);
        expect(r.error?.error.code).toBe(itemRead.error?.error.code);
      }
      for (const r of [
        await writer.setItemExtension(target.id, ns, { a: 1 }),
        await writer.deleteItemExtension(target.id, ns),
      ]) {
        expect(r.status).toBe(itemWrite.status);
        expect(r.error?.error.code).toBe(itemWrite.error?.error.code);
      }

      // A refusal after the write would still have moved the row.
      const after = await client.getItem(target.id);
      expect(after.data.item.updated_at).toBe(before.data.item.updated_at);
      const held = await client.listItemExtensions(target.id);
      expect(held.data.extensions).not.toHaveProperty(ns);
    }

    // The read doors admit a key that may read the folder's type.
    const readerResp = await client.createKey({
      label: "extensions-folder-reader",
      source: `${ctx.source}-extensions-folder-reader`,
      permissions: [],
      type_permissions: { "system.folder": "read" },
      extension_permissions: { [ns]: "read" },
    });
    expect(readerResp.ok).toBe(true);
    trackKey(ctx, readerResp.data.id);
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: readerResp.data.key,
    });
    const folderRead = await reader.getItemExtension(folder.data.item.id, ns);
    expect(folderRead.status).toBe(200);
    expect(folderRead.data.data).toBeNull();
    expect((await reader.listItemExtensions(folder.data.item.id)).status).toBe(
      200,
    );
  });

  it("refuses a replace and a delete to a key that may read the item's type and not write it", async () => {
    const ns = "read-only-type";
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    const noteId = note.data.item.id;
    expect((await client.setItemExtension(noteId, ns, { kept: 1 })).ok).toBe(
      true,
    );

    // Write on the namespace, read on the type: only the type can refuse.
    const keyResp = await client.createKey({
      label: "extensions-note-reader",
      source: `${ctx.source}-extensions-note-reader`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: { [ns]: "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // The witness: the read doors admit the key on this row.
    const read = await reader.getItemExtension(noteId, ns);
    expect(read.status).toBe(200);
    expect(read.data.data).toEqual({ kept: 1 });
    expect((await reader.listItemExtensions(noteId)).status).toBe(200);

    for (const r of [
      await reader.setItemExtension(noteId, ns, { kept: 2 }),
      await reader.deleteItemExtension(noteId, ns),
    ]) {
      expect(r.status).toBe(403);
      expect(r.error?.error.code).toBe("type_not_permitted");
    }
    const after = await client.getItemExtension(noteId, ns);
    expect(after.data.data).toEqual({ kept: 1 });
  });

  it("refuses a folder's extensions to a key holding write on system.folder, as the item doors refuse the folder", async () => {
    const ns = "folder-writer";
    const keyResp = await client.createKey({
      label: "extensions-folder-writer",
      source: `${ctx.source}-extensions-folder-writer`,
      permissions: [],
      type_permissions: { "system.folder": "write" },
      extension_permissions: { [ns]: "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const folderWriter = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // The witness: the key writes the folder through the folder door.
    const folder = await folderWriter.createFolder({
      title: "extension fence",
    });
    expect(folder.status).toBe(201);
    trackFolder(ctx, folder.data.item.id);
    const folderId = folder.data.item.id;
    expect((await folderWriter.getItemExtension(folderId, ns)).status).toBe(
      200,
    );

    for (const r of [
      await folderWriter.setItemExtension(folderId, ns, { a: 1 }),
      await folderWriter.deleteItemExtension(folderId, ns),
    ]) {
      expect(r.status).toBe(403);
      expect(r.error?.error.code).toBe("type_not_permitted");
    }
    const after = await client.getItem(folderId);
    expect(after.data.item.updated_at).toBe(folder.data.item.updated_at);
    const held = await client.listItemExtensions(folderId);
    expect(held.data.extensions).not.toHaveProperty(ns);
  });
});
