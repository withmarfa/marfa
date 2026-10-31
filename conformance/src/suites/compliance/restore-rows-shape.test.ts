import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { listTarGzEntries } from "../../utils/archive.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A real round trip on throwaway servers: the archive is exported from one
 * instance and restored into a fresh one, and what the second instance holds
 * is compared with what the first held. A row whose type is gone, or whose
 * type has since gained a required field, is the instance's own, and the way
 * to make one is the HTTP API alone: a forced delete, and a replacement.
 */
let origin: FreshServer;
let destination: FreshServer;
let third: FreshServer;
beforeEach(async () => {
  [origin, destination, third] = await Promise.all([
    bootFreshServer("rows-shape-origin"),
    bootFreshServer("rows-shape-destination"),
    bootFreshServer("rows-shape-third"),
  ]);
}, 3 * FRESH_SERVER_TIMEOUT_MS);
afterEach(async () => {
  await Promise.all([origin?.stop(), destination?.stop(), third?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

const working = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
const owner = (server: FreshServer) =>
  new MarfaClient({ baseUrl: server.apiUrl, ownerCookie: server.ownerCookie });

/** Everything a reader of `ids` can learn from an instance, by id. */
async function held(client: MarfaClient, ids: string[]) {
  const rows = [];
  for (const id of ids) {
    const read = await client.getItem(id);
    expect(read.status, `${id}: ${JSON.stringify(read.error)}`).toBe(200);
    const history = await client.getVersions(id);
    expect(history.status, JSON.stringify(history.error)).toBe(200);
    rows.push({ item: read.data.item, metadata: read.data.metadata, history });
  }
  return rows.map(({ item, metadata, history }) => ({
    item,
    metadata,
    versions: history.data.data.map((snapshot) => ({
      ...snapshot,
      writer: undefined,
    })),
  }));
}

async function archiveOf(client: MarfaClient) {
  const exported = await client.exportArchive({ state: "any" });
  expect(
    exported.status,
    Buffer.from(exported.data).toString().slice(0, 500),
  ).toBe(200);
  return exported.data;
}

describe("a restore of rows whose type no longer shapes them", () => {
  it("restores an item of a force-deleted type as the archive holds it, writable for tags, extensions and lifecycle, and restores its own export again", async () => {
    const source = working(origin);
    const type = "user.vanished";
    const fields = {
      name: { type: "string" as const, required: true },
      link: { type: "string" as const },
    };
    expect(
      (await source.registerType({ id: type, version: 3, fields })).status,
    ).toBe(201);
    const orphan = await source.createItem({
      type,
      properties: { name: "kept", link: "https://example.test/vanished" },
      source_id: "natural-key-1",
      tags: ["from-origin"],
    });
    expect(orphan.status, JSON.stringify(orphan.error)).toBe(201);
    const id = orphan.data.item.id;
    const note = await source.createItem({
      type: "core.note",
      properties: { body: "beside the orphan" },
    });
    expect(note.status).toBe(201);
    expect(
      (
        await source.updateItem(id, {
          version: 1,
          properties: { name: "kept, then edited" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await source.setItemExtension(id, "orphan.notes", { a: 1 })).ok,
    ).toBe(true);
    expect(
      (
        await source.createEdge({
          source_id: id,
          target_id: note.data.item.id,
          edge_type: "references",
        })
      ).status,
    ).toBe(201);
    expect((await source.deleteType(type, true)).status).toBe(200);

    // The witness: the type is gone from the instance, from its export, and
    // from the writes that need it, and the item stays.
    const exported = await archiveOf(source);
    const members = listTarGzEntries(exported);
    expect(
      members.find((m) => m.name === "types.ndjson")!.body.toString(),
    ).not.toContain(type);
    expect(
      members.find((m) => m.name === "items.ndjson")!.body.toString(),
    ).toContain(id);
    expect((await source.getType(type)).status).toBe(404);

    const restored = await owner(destination).restoreArchive(exported);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({
      imported: 2,
      edges_imported: 1,
      types_registered: 0,
    });

    const ids = [id, note.data.item.id];
    const before = await held(source, ids);
    const reader = working(destination);
    expect(await held(reader, ids)).toEqual(before);
    expect((await reader.getType(type)).status).toBe(404);
    expect((await reader.listItemEdges(id)).data.data).toEqual(
      (await source.listItemEdges(id)).data.data,
    );

    // Reads, listing and search serve the orphan as they serve it on the
    // instance that deleted its type (`types/orphan-read`).
    for (const client of [source, reader]) {
      const read = await client.getItem(id);
      expect(read.status, "item").toBe(200);
      expect(read.data.item.type, "item").toBe(type);
      const versions = await client.getVersions(id);
      expect(versions.status, "versions").toBe(200);
      expect(versions.data.data.length, "versions").toBe(1);
      const edges = await client.listItemEdges(id);
      expect(edges.status, "edges").toBe(200);
      expect(
        edges.data.data.map((edge) => edge.target_id),
        "edges",
      ).toEqual([note.data.item.id]);
      expect(
        (await client.search("edited")).data.data.map((r) => r.item.id),
        "search",
      ).toEqual([id]);
      expect(
        (await client.listItems({})).data.data.map((row) => row.id),
        "listing",
      ).toContain(id);
    }

    // The row is the orphan an ordinary forced delete leaves
    // (`types/orphan-write`, `types/orphan-kept-writable`).
    const patched = await reader.updateItem(id, {
      version: 2,
      properties: { name: "changed" },
    });
    expect(patched.status).toBe(400);
    expect(patched.error?.error.code).toBe("unknown_type");
    expect((await reader.addTags(id, ["on-destination"])).status).toBe(200);
    expect(
      (await reader.setItemExtension(id, "orphan.more", { b: 2 })).status,
    ).toBe(200);
    expect((await reader.transitionItem(id, "archived")).status).toBe(200);
    expect((await reader.transitionItem(id, "active")).status).toBe(200);
    expect((await reader.deleteItem(id)).status).toBe(200);
    expect((await reader.getItem(id)).status).toBe(404);
    expect((await reader.restoreItem(id)).status).toBe(200);
    const created = await reader.createItem({
      type,
      properties: { name: "n" },
    });
    expect(created.status).toBe(400);
    expect(created.error?.error.code).toBe("unknown_type");

    // A second generation: what was restored exports and restores again.
    const second = await archiveOf(reader);
    const restoredAgain = await owner(third).restoreArchive(second);
    expect(restoredAgain.status, JSON.stringify(restoredAgain.error)).toBe(200);
    expect(restoredAgain.data).toMatchObject({
      imported: 2,
      edges_imported: 1,
    });
    expect(await held(working(third), ids)).toEqual(await held(reader, ids));
  }, 180_000);

  it("restores an item that lacks a field its type now requires, as the archive holds it, and still holds an ordinary write to the type", async () => {
    const source = working(origin);
    const type = "user.gained";
    expect(
      (
        await source.registerType({
          id: type,
          version: 1,
          fields: { name: { type: "string" as const } },
        })
      ).status,
    ).toBe(201);
    const early = await source.createItem({
      type,
      properties: { name: "written before the field" },
      tags: ["early"],
    });
    expect(early.status, JSON.stringify(early.error)).toBe(201);
    expect(early.data.item.schema_version).toBe(1);
    const replaced = await source.replaceType(type, {
      version: 2,
      fields: {
        name: { type: "string" as const },
        owner: { type: "string" as const, required: true },
      },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);

    // The witness: an ordinary write to the type now needs the field.
    const refused = await source.createItem({
      type,
      properties: { name: "written after the field" },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    const late = await source.createItem({
      type,
      properties: { name: "written after the field", owner: "me" },
    });
    expect(late.status, JSON.stringify(late.error)).toBe(201);

    const ids = [early.data.item.id, late.data.item.id];
    const exported = await archiveOf(source);
    const restored = await owner(destination).restoreArchive(exported);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ imported: 2, types_registered: 1 });

    const reader = working(destination);
    const read = await held(reader, ids);
    expect(read).toEqual(await held(source, ids));
    expect(read[0]!.item.properties).toEqual({
      name: "written before the field",
    });
    expect(read[0]!.item.schema_version).toBe(1);

    // The type is the one the archive registered, and it holds ordinary
    // writes to the field as before.
    expect((await reader.getType(type)).data).toMatchObject({ version: 2 });
    const again = await reader.createItem({
      type,
      properties: { name: "missing the field" },
    });
    expect(again.status).toBe(400);
    expect(again.error?.error.code).toBe("invalid_properties");
    const edit = await reader.updateItem(ids[0]!, {
      version: 1,
      properties: { name: "edited, still without the field" },
    });
    expect(edit.status).toBe(400);
    expect(edit.error?.error.code).toBe("invalid_properties");

    const second = await archiveOf(reader);
    const restoredAgain = await owner(third).restoreArchive(second);
    expect(restoredAgain.status, JSON.stringify(restoredAgain.error)).toBe(200);
    expect(await held(working(third), ids)).toEqual(read);
  }, 180_000);

  it("restores an item of a platform type that this build no longer ships as an orphan", async () => {
    const source = working(origin);
    const retired = "core.retired_thing";
    expect(
      (
        await source.registerType({
          id: "user.retired_thing",
          fields: { name: { type: "string" as const, required: true } },
        })
      ).status,
    ).toBe(201);
    const made = await source.createItem({
      type: "user.retired_thing",
      properties: { name: "held by a retired type" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const id = made.data.item.id;

    // No door registers a platform type: the stored file is edited so the
    // type is a platform row that the build does not ship, which is what an
    // instance is left with when a build retires a type its items still hold.
    await origin.restart(() => {
      withInstanceDatabase(origin.sqlitePath, (db) => {
        db.prepare(
          "UPDATE types SET id = ?1, origin = 'platform', family = 'core', schema = json_set(schema, '$.id', ?1) WHERE id = 'user.retired_thing'",
        ).run(retired);
        db.prepare(
          "UPDATE items SET type = ? WHERE type = 'user.retired_thing'",
        ).run(retired);
      });
    });
    const manager = new MarfaClient({
      baseUrl: origin.apiUrl,
      apiKey: origin.managementKey,
    });
    const listed = await manager.listRetiredPlatformTypes();
    expect(listed.data.data.find((row) => row.id === retired)).toMatchObject({
      item_count: 1,
    });
    const exported = await archiveOf(working(origin));
    // The archive carries the instance's own registrations, not this one.
    expect(
      listTarGzEntries(exported)
        .find((m) => m.name === "types.ndjson")!
        .body.toString(),
    ).not.toContain(retired);

    const restored = await owner(destination).restoreArchive(exported);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ imported: 1 });
    const reader = working(destination);
    expect(await held(reader, [id])).toEqual(await held(working(origin), [id]));
    const unknown = await reader.updateItem(id, {
      version: 1,
      properties: { name: "changed" },
    });
    expect(unknown.error?.error.code).toBe("unknown_type");
  }, 180_000);
});
