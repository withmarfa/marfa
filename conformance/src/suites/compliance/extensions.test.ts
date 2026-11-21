import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  MarfaClient,
  extensionsOf,
  type ItemExtension,
} from "../../client/api.js";
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
    expect(extensionsOf(r.data)["test-app"]).toEqual({
      score: 42,
      label: "important",
    });
  });

  it("reads all extensions", async () => {
    const r = await client.listItemExtensions(itemId);
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}/extensions", 200, r.data);
    expect(extensionsOf(r.data)["test-app"]).toEqual({
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
    expect(r.data.document).toEqual({ score: 42, label: "important" });
  });

  it("overwrites extension on second PUT", async () => {
    const put = await client.setItemExtension(itemId, "test-app", {
      score: 99,
    });
    expect(put.ok).toBe(true);
    const r = await client.getItemExtension(itemId, "test-app");
    expect(r.ok).toBe(true);
    expect(r.data.document).toEqual({ score: 99 });
    expect(r.data.document).not.toHaveProperty("label");
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
    expect(extensionsOf(r.data)["app-a"]).toEqual({ a: 1 });
    expect(extensionsOf(r.data)["app-b"]).toEqual({ b: 2 });
  });

  it("takes extension data of 102400 Unicode characters of compact JSON and refuses one more with 400 validation_error, leaving the namespace as it stood", async () => {
    // The compact JSON of {"v":"..."} is the text plus 8 characters.
    const overhead = 8;
    const limit = 102_400;
    for (const [unit, label] of [
      ["x", "one-byte"],
      ["\u20ac", "three-byte"],
      ["\u{1F600}", "astral"],
    ] as const) {
      const namespace = `limit-${label}`;
      const kept = await client.setItemExtension(itemId, namespace, {
        v: "kept",
      });
      expect(kept.ok, label).toBe(true);

      const over = await client.setItemExtension(itemId, namespace, {
        v: unit.repeat(limit - overhead + 1),
      });
      expect(over.status, label).toBe(400);
      expect(over.error?.error.code, label).toBe("validation_error");
      const unchanged = await client.getItemExtension(itemId, namespace);
      expect(unchanged.data.document, label).toEqual({ v: "kept" });

      const at = await client.setItemExtension(itemId, namespace, {
        v: unit.repeat(limit - overhead),
      });
      expect(at.status, label).toBe(200);
      const read = await client.getItemExtension(itemId, namespace);
      expect([...(read.data.document as { v: string }).v], label).toHaveLength(
        limit - overhead,
      );
    }
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
    expect(extensionsOf(removed.data)).not.toHaveProperty("to-delete");

    const r = await client.getItemExtension(itemId, "to-delete");
    expect(r.status).toBe(200);
    expect(r.data.document).toBeNull();
  });

  it("extensions persist on the item's metadata read", async () => {
    const put = await client.setItemExtension(itemId, "persist-test", {
      persisted: true,
    });
    expect(put.ok).toBe(true);
    const r = await client.getItem(itemId);
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

  it("answers a key only the namespaces its extension map reads, on the replace and delete doors as on the reads", async () => {
    const seen = `seen-${ctx.runId}`;
    const unseen = `unseen-${ctx.runId}`;
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.ok).toBe(true);
    const id = note.data.item.id;
    trackItem(ctx, id);
    expect((await client.setItemExtension(id, seen, { a: 1 })).ok).toBe(true);
    // The witness: the namespace the narrow key does not hold is on the
    // item, and a key that may read it is answered it.
    const full = await client.setItemExtension(id, unseen, { secret: 2 });
    expect(full.ok).toBe(true);
    expect(extensionsOf(full.data)[unseen]).toEqual({ secret: 2 });

    const keyResp = await client.createKey({
      label: "extensions-one-namespace",
      source: `${ctx.source}-extensions-one-namespace`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      extension_permissions: { [seen]: "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const replaced = await narrow.setItemExtension(id, seen, { a: 3 });
    expect(replaced.status).toBe(200);
    expect(extensionsOf(replaced.data)).toEqual({ [seen]: { a: 3 } });
    const listed = await narrow.listItemExtensions(id);
    expect(extensionsOf(listed.data)).toEqual({ [seen]: { a: 3 } });
    const item = await narrow.getItem(id);
    expect(item.data.metadata.extensions).toEqual({ [seen]: { a: 3 } });
    const bulk = await narrow.bulkGet([id], ["metadata", "extensions"]);
    expect(bulk.status).toBe(200);
    expect(JSON.stringify(bulk.data)).toContain(seen);
    expect(JSON.stringify(bulk.data)).not.toContain(unseen);
    const removed = await narrow.deleteItemExtension(id, seen);
    expect(removed.status).toBe(200);
    expect(extensionsOf(removed.data)).toEqual({});

    // Left out of the answers, and left alone on the item.
    const kept = await client.getItemExtension(id, unseen);
    expect(kept.data.document).toEqual({ secret: 2 });
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

  describe("a key's label", () => {
    let namespace: string;
    let minter: { id: string; client: MarfaClient };

    /** Every namespace door, and the readings that carry extensions, as
     *  `holder` is answered them for `namespace`. */
    async function expectRefused(holder: MarfaClient): Promise<void> {
      for (const r of [
        await holder.getItemExtension(itemId, namespace),
        await holder.setItemExtension(itemId, namespace, { taken: true }),
        await holder.deleteItemExtension(itemId, namespace),
      ]) {
        expect(r.status).toBe(403);
        expect(r.error?.error.code).toBe("forbidden");
        expect(r.error?.error.details?.grant).toMatchObject({
          kind: "extension",
          name: namespace,
        });
      }
      const listed = await holder.listItemExtensions(itemId);
      expect(listed.status).toBe(200);
      expect(extensionsOf(listed.data)).not.toHaveProperty(namespace);
      const item = await holder.getItem(itemId);
      expect(item.data.metadata.extensions).not.toHaveProperty(namespace);
      const kept = await client.getItemExtension(itemId, namespace);
      expect(kept.data.document).toEqual({ held: "by the map" });
    }

    beforeAll(async () => {
      namespace = `label-${ctx.runId}`;
      // The witness: the namespace is on the item, and a key whose
      // extension map reaches it reads it.
      const written = await client.setItemExtension(itemId, namespace, {
        held: "by the map",
      });
      expect(written.ok, JSON.stringify(written.error)).toBe(true);
      expect(extensionsOf(written.data)[namespace]).toEqual({
        held: "by the map",
      });

      const minted = await client.createKey({
        label: "extensions-label-minter",
        source: `${ctx.source}-extensions-label-minter`,
        permissions: ["keys.mint"],
        type_permissions: { "core.note": "write" },
        extension_permissions: {},
      });
      expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
      trackKey(ctx, minted.data.id);
      minter = {
        id: minted.data.id,
        client: new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key }),
      };
    });

    it("grants no namespace to a key relabeled with its name", async () => {
      const relabeled = await minter.client.updateKey(minter.id, {
        label: namespace,
      });
      expect(relabeled.status).toBe(200);
      expect(relabeled.data.label).toBe(namespace);
      await expectRefused(minter.client);
    });

    it("grants no namespace to a key minted with its name for a label", async () => {
      const child = await minter.client.createKey({
        label: namespace,
        source: `${ctx.source}-extensions-label-child`,
        type_permissions: { "core.note": "write" },
      });
      expect(child.status).toBe(201);
      trackKey(ctx, child.data.id);
      expect(child.data.label).toBe(namespace);
      expect(child.data.extension_permissions).toEqual({});
      await expectRefused(
        new MarfaClient({ baseUrl: apiUrl, apiKey: child.data.key }),
      );
    });
  });

  // Names a plain JavaScript object already answers to, so a map lookup that
  // is not confined to the map's own entries would find them in every map.
  describe.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "the namespace %s",
    (namespace) => {
      it("is reached only by a key whose extension map names it", async () => {
        const written = await client.setItemExtension(itemId, namespace, {
          held: "by the map",
        });
        expect(written.ok, JSON.stringify(written.error)).toBe(true);

        const mint = async (
          label: string,
          extensions: Record<string, "read" | "write">,
        ): Promise<MarfaClient> => {
          const minted = await client.createKey({
            label,
            source: `${ctx.source}-${label}`,
            type_permissions: { "core.note": "read" },
            extension_permissions: extensions,
          });
          expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
          trackKey(ctx, minted.data.id);
          return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
        };

        // The witness: a key whose map names the namespace is answered it.
        const named = await mint(`ext-own-named-${namespace}`, {
          [namespace]: "read",
        });
        const seen = await named.getItem(itemId);
        expect(seen.data.metadata.extensions?.[namespace]).toEqual({
          held: "by the map",
        });

        const unnamed = await mint(`ext-own-unnamed-${namespace}`, {});
        const item = await unnamed.getItem(itemId);
        expect(item.status).toBe(200);
        expect(
          Object.hasOwn(item.data.metadata.extensions ?? {}, namespace),
        ).toBe(false);
        const listed = await unnamed.listItemExtensions(itemId);
        expect(listed.status).toBe(200);
        expect(Object.hasOwn(extensionsOf(listed.data), namespace)).toBe(false);
        const read = await unnamed.getItemExtension(itemId, namespace);
        expect(read.status).toBe(403);
      });

      it("is not granted by a key whose extension map does not name it", async () => {
        const minted = await client.createKey({
          label: `ext-own-minter-${namespace}`,
          source: `${ctx.source}-ext-own-minter-${namespace}`,
          permissions: ["keys.mint"],
          type_permissions: { "core.note": "read" },
          extension_permissions: {},
        });
        expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
        trackKey(ctx, minted.data.id);
        const minter = new MarfaClient({
          baseUrl: apiUrl,
          apiKey: minted.data.key,
        });

        // The witness: a map naming the namespace is a grant the file's own
        // key may make.
        const granted = await client.createKey({
          label: `ext-own-granted-${namespace}`,
          source: `${ctx.source}-ext-own-granted-${namespace}`,
          type_permissions: { "core.note": "read" },
          extension_permissions: { [namespace]: "read" },
        });
        expect(granted.status).toBe(201);
        trackKey(ctx, granted.data.id);

        const child = await minter.createKey({
          label: `ext-own-child-${namespace}`,
          source: `${ctx.source}-ext-own-child-${namespace}`,
          type_permissions: { "core.note": "read" },
          extension_permissions: { [namespace]: "read" },
        });
        expect(child.status).toBe(403);
        expect(child.error?.error.code).toBe("forbidden");
      });
    },
  );

  it("answers every door on an item whose type the key does not hold as a missing item, as the item doors answer it", async () => {
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
    expect(ownRead.data.document).toEqual({ a: 1 });
    const ownList = await writer.listItemExtensions(noteId);
    expect(ownList.status).toBe(200);
    expect(extensionsOf(ownList.data)[ns]).toEqual({ a: 1 });
    expect((await writer.deleteItemExtension(noteId, ns)).status).toBe(200);

    for (const target of [bookmark.data.item, folder.data.item]) {
      const before = await client.getItem(target.id);
      expect(before.ok).toBe(true);

      // What the item doors answer this key for the same item.
      const itemRead = await writer.getItem(target.id);
      expect(itemRead.status).toBe(404);
      expect(itemRead.error?.error.code).toBe("item_not_found");
      const itemWrite = await writer.updateItem(target.id, {
        version: target.version,
        properties: { title: "not written" },
      });
      expect(itemWrite.status).toBe(404);
      expect(itemWrite.error?.error.code).toBe("item_not_found");

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

      // A refusal after the write would still have moved the item.
      const after = await client.getItem(target.id);
      expect(after.data.item.updated_at).toBe(before.data.item.updated_at);
      const held = await client.listItemExtensions(target.id);
      expect(extensionsOf(held.data)).not.toHaveProperty(ns);
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
    expect(folderRead.data.document).toBeNull();
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

    // The witness: the read doors admit the key on this item.
    const read = await reader.getItemExtension(noteId, ns);
    expect(read.status).toBe(200);
    expect(read.data.document).toEqual({ kept: 1 });
    expect((await reader.listItemExtensions(noteId)).status).toBe(200);

    for (const r of [
      await reader.setItemExtension(noteId, ns, { kept: 2 }),
      await reader.deleteItemExtension(noteId, ns),
    ]) {
      expect(r.status).toBe(403);
      expect(r.error?.error.code).toBe("type_not_permitted");
    }
    const after = await client.getItemExtension(noteId, ns);
    expect(after.data.document).toEqual({ kept: 1 });
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
    expect(extensionsOf(held.data)).not.toHaveProperty(ns);
  });
});

describe("an extension namespace's revision", () => {
  const seed = async (): Promise<string> => {
    const note = await client.createItem(createNote({ source: ctx.source }));
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    trackItem(ctx, note.data.item.id);
    return note.data.item.id;
  };
  const revisionOf = (
    page: { data: ItemExtension[] },
    namespace: string,
  ): string | undefined =>
    page.data.find((entry) => entry.namespace === namespace)?.revision;

  it("answers one revision for a namespace on every read and on the write answer, another once its document changes, and one fixed revision for an absent namespace", async () => {
    const id = await seed();
    const other = await seed();
    const absent = await client.getItemExtension(id, "rev");
    expect(absent.status).toBe(200);
    expect(absent.data.document).toBeNull();
    expect(typeof absent.data.revision).toBe("string");
    expect(absent.data.revision.length).toBeGreaterThan(0);
    const absentElsewhere = await client.getItemExtension(other, "elsewhere");
    expect(absentElsewhere.data.revision).toBe(absent.data.revision);

    const written = await client.setItemExtension(id, "rev", { a: 1 });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    await expectMatchesSchema(
      "PUT",
      "/items/{id}/extensions/{namespace}",
      200,
      written.data,
    );
    const first = revisionOf(written.data, "rev");
    expect(typeof first).toBe("string");
    expect(first).not.toBe(absent.data.revision);

    const read = await client.getItemExtension(id, "rev");
    await expectMatchesSchema(
      "GET",
      "/items/{id}/extensions/{namespace}",
      200,
      read.data,
    );
    expect(read.data.revision).toBe(first);
    const listed = await client.listItemExtensions(id);
    await expectMatchesSchema(
      "GET",
      "/items/{id}/extensions",
      200,
      listed.data,
    );
    expect(revisionOf(listed.data, "rev")).toBe(first);

    // The same document written again keeps its revision, on any item.
    const again = await client.setItemExtension(id, "rev", { a: 1 });
    expect(revisionOf(again.data, "rev")).toBe(first);
    const elsewhere = await client.setItemExtension(other, "rev", { a: 1 });
    expect(revisionOf(elsewhere.data, "rev")).toBe(first);

    const changed = await client.setItemExtension(id, "rev", { a: 2 });
    const second = revisionOf(changed.data, "rev");
    expect(second).not.toBe(first);
    expect(second).not.toBe(absent.data.revision);

    const removed = await client.deleteItemExtension(id, "rev");
    expect(removed.status).toBe(200);
    expect(revisionOf(removed.data, "rev")).toBeUndefined();
    const gone = await client.getItemExtension(id, "rev");
    expect(gone.data.revision).toBe(absent.data.revision);
  });

  it("refuses a replace naming a revision the namespace has moved on from with 409 version_conflict and the namespace as it stands, changing nothing", async () => {
    const id = await seed();
    await client.setItemExtension(id, "app", { mine: "read" });
    const read = await client.getItemExtension(id, "app");
    // Another writer changes the namespace after the reader read it.
    const between = await client.setItemExtension(id, "app", {
      theirs: "between",
    });
    expect(between.status).toBe(200);
    const now = revisionOf(between.data, "app");

    const stale = await client.setItemExtension(
      id,
      "app",
      { mine: "written" },
      read.data.revision,
    );
    expect(stale.status).toBe(409);
    expect(stale.headers.get("X-Error-Code")).toBe("version_conflict");
    expect(stale.error).toMatchObject({
      error: { code: "version_conflict" },
      current: {
        namespace: "app",
        document: { theirs: "between" },
        revision: now,
      },
    });
    await expectMatchesSchema(
      "PUT",
      "/items/{id}/extensions/{namespace}",
      409,
      stale.error,
    );
    const kept = await client.getItemExtension(id, "app");
    expect(kept.data.document).toEqual({ theirs: "between" });
  });

  it("replaces a namespace whose revision is the one named", async () => {
    const id = await seed();
    await client.setItemExtension(id, "app", { mine: "read" });
    const read = await client.getItemExtension(id, "app");
    // A change to another namespace and to the item's content does not stop it.
    await client.setItemExtension(id, "other-app", { theirs: 1 });
    const version = (await client.getItem(id)).data.item.version;
    const moved = await client.updateItem(id, {
      version,
      properties: { body: "changed since the read" },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    const replaced = await client.setItemExtension(
      id,
      "app",
      { mine: "written" },
      read.data.revision,
    );
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect(extensionsOf(replaced.data)["app"]).toEqual({ mine: "written" });
  });

  it("guards a create with the revision of the absent namespace, refused once another writer created it", async () => {
    const id = await seed();
    const absent = await client.getItemExtension(id, "app");
    expect(absent.data.document).toBeNull();
    const created = await client.setItemExtension(
      id,
      "app",
      { first: true },
      absent.data.revision,
    );
    expect(created.status, JSON.stringify(created.error)).toBe(200);

    // A second reader read the namespace absent too, before the create.
    const late = await client.setItemExtension(
      id,
      "app",
      { second: true },
      absent.data.revision,
    );
    expect(late.status).toBe(409);
    expect(late.error).toMatchObject({
      error: { code: "version_conflict" },
      current: { namespace: "app", document: { first: true } },
    });
    expect((await client.getItemExtension(id, "app")).data.document).toEqual({
      first: true,
    });
  });

  it("refuses a delete naming a revision the namespace has moved on from, and deletes on the current one", async () => {
    const id = await seed();
    await client.setItemExtension(id, "app", { v: 1 });
    const read = await client.getItemExtension(id, "app");
    const between = await client.setItemExtension(id, "app", { v: 2 });
    const now = revisionOf(between.data, "app");

    const stale = await client.deleteItemExtension(
      id,
      "app",
      read.data.revision,
    );
    expect(stale.status).toBe(409);
    expect(stale.headers.get("X-Error-Code")).toBe("version_conflict");
    expect(stale.error).toMatchObject({
      current: { namespace: "app", document: { v: 2 }, revision: now },
    });
    await expectMatchesSchema(
      "DELETE",
      "/items/{id}/extensions/{namespace}",
      409,
      stale.error,
    );
    expect((await client.getItemExtension(id, "app")).data.document).toEqual({
      v: 2,
    });

    const removed = await client.deleteItemExtension(id, "app", now);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    const gone = await client.getItemExtension(id, "app");
    expect(gone.data.document).toBeNull();

    // A namespace deleted since it was read is refused, with no document.
    const again = await client.deleteItemExtension(id, "app", now);
    expect(again.status).toBe(409);
    expect(again.error).toMatchObject({
      current: {
        namespace: "app",
        document: null,
        revision: gone.data.revision,
      },
    });
  });

  it("refuses a read revision that is not one Marfa answers with 400 validation_error naming read_revision, changing nothing", async () => {
    const id = await seed();
    await client.setItemExtension(id, "app", { kept: true });
    const read = await client.getItemExtension(id, "app");
    for (const query of [
      "read_revision=",
      "read_revision=not-a-revision",
      `read_revision=${read.data.revision.toUpperCase()}`,
      `read_revision=${read.data.revision}0`,
      `read_revision=${read.data.revision}&read_revision=${read.data.revision}`,
    ]) {
      for (const method of ["PUT", "DELETE"] as const) {
        const refused = await client.rawRequest(
          `/items/${id}/extensions/app?${query}`,
          {
            method,
            ...(method === "PUT" ? { body: { overwritten: true } } : {}),
          },
        );
        expect(refused.status, `${method} ${query}`).toBe(400);
        expect(refused.headers.get("X-Error-Code")).toBe("validation_error");
        expect(JSON.stringify(refused.error)).toContain("read_revision");
      }
    }
    expect((await client.getItemExtension(id, "app")).data.document).toEqual({
      kept: true,
    });
  });

  it("replaces and deletes a namespace as it stands when no revision is named", async () => {
    const id = await seed();
    await client.setItemExtension(id, "app", { v: 1 });
    await client.setItemExtension(id, "app", { v: 2 });
    const replaced = await client.setItemExtension(id, "app", { v: 3 });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect(extensionsOf(replaced.data)["app"]).toEqual({ v: 3 });
    const removed = await client.deleteItemExtension(id, "app");
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect((await client.getItemExtension(id, "app")).data.document).toBeNull();
  });

  it("answers a key reused with another read revision as another request, and replays the same request", async () => {
    const id = await seed();
    const absent = (await client.getItemExtension(id, "app")).data.revision;
    const key = `read-revision-${ctx.runId}-${randomUUID()}`;
    const send = (query: string) =>
      client.rawRequest<{ data: ItemExtension[] }>(
        `/items/${id}/extensions/app${query}`,
        {
          method: "PUT",
          headers: { "Idempotency-Key": key },
          body: { mine: true },
        },
      );
    const first = await send(`?read_revision=${absent}`);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const replayed = await send(`?read_revision=${absent}`);
    expect(replayed.status, JSON.stringify(replayed.error)).toBe(200);
    const other = await send("");
    expect(other.status).toBe(422);
    expect(other.headers.get("X-Error-Code")).toBe("idempotency_key_reused");
  });
});
