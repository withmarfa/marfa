import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
  trackFolder,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-types",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("custom edge-type registration", () => {
  it("registers a custom edge type and answers 201", async () => {
    const etId = `mock.register.${ctx.runId}`;
    const r = await client.registerEdgeType({
      id: etId,
      label: "Test edge type",
      description: "For edge-type compliance tests",
      cardinality: "many-to-many",
      source_type_constraints: ["core.note"],
      target_type_constraints: ["core.note"],
      cascade_on_delete: "orphan",
    });
    expect(r.status).toBe(201);
    trackEdgeType(ctx, etId);
    await expectMatchesSchema("POST", "/edge-types", 201, r.data);
    expect(r.data.edge_type.id).toBe(etId);
    expect(r.data.edge_type.cardinality).toBe("many-to-many");
  });

  it("lists the shipped edge types and a registered one", async () => {
    const etId = `mock.listed.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "one-to-many",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const r = await client.listEdgeTypes();
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/edge-types", 200, r.data);
    const ids = r.data.data.map((t) => t.id);
    // A copy of the registry rather than a read of it, because nothing
    // under `src/suites/` may import a workspace package.
    const SHIPPED = [
      "about",
      "parent-of",
      "in-thread",
      "attached-to",
      "authored-by",
      "derived-from",
      "supersedes",
      "references",
      "in-collection",
      "in-folder",
    ];
    for (const shipped of SHIPPED) {
      expect(ids).toContain(shipped);
    }
    // And no eleventh. `toContain` per name cannot see a shipped type nobody
    // listed here, so the list could fall behind the registry with nothing
    // red — and a type absent from this list is a type absent from every
    // fixture that reads it.
    //
    // Told apart by the namespace rather than by the run: a shipped edge
    // type is a bare kebab name, and a registered one is dotted
    // (`mock.listed.<run>`), so this holds the shipped set without having
    // to know which other cases in the run have registered what.
    expect(
      ids.filter((id) => !SHIPPED.includes(id) && !id.includes(".")),
    ).toEqual([]);
    const mine = r.data.data.find((t) => t.id === etId);
    expect(mine?.cardinality).toBe("one-to-many");
  });

  it("deletes a registered edge type and answers 404 for it afterwards", async () => {
    const etId = `mock.deleted.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const before = await client.listEdgeTypes();
    expect(before.ok).toBe(true);
    expect(before.data.data.map((t) => t.id)).toContain(etId);

    const removed = await client.deleteEdgeType(etId);
    expect(removed.ok).toBe(true);
    await expectMatchesSchema("DELETE", "/edge-types/{id}", 200, removed.data);
    const listed = await client.listEdgeTypes();
    expect(listed.ok).toBe(true);
    expect(listed.data.data.map((t) => t.id)).not.toContain(etId);
    const again = await client.deleteEdgeType(etId);
    expect(again.status).toBe(404);
    expect(again.error?.error.code).toBe("edge_type_not_found");
  });

  it("refuses to delete an edge type while edges of it exist, and orphans them on force", async () => {
    // The two registries answer one question one way. `DELETE
    // /types/{id}` refuses `409 type_in_use` while rows of the type
    // exist and takes `?force=true`; this door does the same for edges,
    // so a caller does not have to learn which registry it is talking to
    // before it can predict the answer.
    //
    // **Force orphans rather than cascades.** The edges stay and keep
    // naming a type the instance no longer holds, which is untidy and
    // recoverable; deleting rows nobody asked to delete is neither.
    //
    // Its own code rather than `type_in_use`, matching the
    // `edge_type_not_found` that sits beside `type_not_found`:
    // the doors agree in shape and differ in vocabulary, because an edge
    // type is not a type and a caller branching on the code should be
    // able to tell which registry refused it.
    const etId = `mock.dangling.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const a = await client.createItem(createNote({ source: ctx.source }));
    const b = await client.createItem(createNote({ source: ctx.source }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    trackItem(ctx, a.data.item.id);
    trackItem(ctx, b.data.item.id);

    const edge = await client.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: etId,
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const refused = await client.deleteEdgeType(etId);
    expect(refused.ok).toBe(false);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("edge_type_in_use");
    expect(refused.error?.error.details).toMatchObject({ edge_type: etId });

    // The refusal changed nothing: the registration is still there, so a
    // caller that fixes the edges can try again.
    const stillListed = await client.listEdgeTypes();
    expect(stillListed.data.data.map((t) => t.id)).toContain(etId);

    // `force` is the way through, and it orphans rather than cascades:
    // the edges are the caller's to deal with, and deleting rows nobody
    // asked to delete is the worse of the two surprises.
    const forced = await client.deleteEdgeType(etId, true);
    expect(forced.ok, JSON.stringify(forced.error)).toBe(true);
    expect(forced.status).toBe(200);

    const listed = await client.listEdgeTypes();
    expect(listed.data.data.map((t) => t.id)).not.toContain(etId);

    const orphan = await client.getEdge(edge.data.edge.id);
    expect(orphan.status).toBe(200);
    expect(orphan.data.edge.edge_type).toBe(etId);
  });

  it("deletes an edge type no edge names, without force", async () => {
    // The witness. The refusal above is the edges and not the door
    // having closed: a registration nothing uses goes on the first ask.
    const etId = `mock.unused.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const before = await client.listEdgeTypes();
    expect(before.ok).toBe(true);
    expect(before.data.data.map((t) => t.id)).toContain(etId);

    const removed = await client.deleteEdgeType(etId);
    expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
    expect(removed.status).toBe(200);

    const listed = await client.listEdgeTypes();
    expect(listed.data.data.map((t) => t.id)).not.toContain(etId);
  });

  it("refuses a delete to a key without schema.write, and declares the refusal", async () => {
    // The door gates on `schema.write`, so holding the wrong credential is
    // the one refusal a caller can arrange, and the document has to declare
    // it. `expectMatchesSchema` is the half that reddens if the declaration
    // goes: it throws when the served document declares no such status for
    // the door.
    const etId = `mock.no-schema-write.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const keyResp = await client.createKey({
      label: "edge-types-no-schema-write",
      source: `${ctx.source}-no-schema-write`,
      permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scopedClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const removed = await scopedClient.deleteEdgeType(etId);
    expect(removed.status).toBe(403);
    expect(removed.error?.error.code).toBe("forbidden");
    await expectMatchesSchema("DELETE", "/edge-types/{id}", 403, removed.error);
  });

  it("a key without metadata.edge_types:write cannot register an edge type", async () => {
    // A credential that writes every type: the registration door asks for the
    // metadata map, and content reach says nothing about the registry.
    const noSchemaResp = await client.createKey({
      label: "edge-types-no-schema",
      source: `${ctx.source}-no-schema`,
      permissions: [],
      type_permissions: { "*": "write" },
    });
    expect(noSchemaResp.ok).toBe(true);
    trackKey(ctx, noSchemaResp.data.id);

    const noSchemaClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: noSchemaResp.data.key,
    });

    const r = await noSchemaClient.registerEdgeType({
      id: `mock.no-schema.${ctx.runId}`,
      cardinality: "many-to-many",
    });
    expect(r.status).toBe(403);
    expect(r.error?.error.code).toBe("forbidden");
  });

  it("registers only the edge type ids the key's own edge map grants write on", async () => {
    const own = `mock.own-map.${ctx.runId}`;
    const other = `mock.other-map.${ctx.runId}`;
    const readOnly = `mock.read-map.${ctx.runId}`;
    const ownSecond = `mock.own-map-reversed.${ctx.runId}`;
    const minted = await client.createKey({
      label: "edge-types-own-map",
      source: `${ctx.source}-edge-own-map`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: {
        [own]: "write",
        [ownSecond]: "write",
        [readOnly]: "read",
      },
      metadata_permissions: { edge_types: "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    const mine = await scoped.registerEdgeType({
      id: own,
      cardinality: "many-to-many",
    });
    expect(mine.status).toBe(201);
    trackEdgeType(ctx, own);

    const reversed = await scoped.registerEdgeType({
      id: ownSecond,
      cardinality: "many-to-many",
      reverse_name: other,
    });
    expect(reversed.status).toBe(403);
    expect(reversed.error?.error.code).toBe("edge_permission_denied");
    expect(reversed.error?.error.details?.edge_type).toBe(other);

    for (const id of [other, readOnly]) {
      const refused = await scoped.registerEdgeType({
        id,
        cardinality: "many-to-many",
      });
      expect(refused.status, id).toBe(403);
      expect(refused.error?.error.code).toBe("edge_permission_denied");
      expect(refused.error?.error.details?.edge_type).toBe(id);
      await expectMatchesSchema("POST", "/edge-types", 403, refused.error);

      // The witness: the identifier itself registers, to a key whose map
      // reaches it.
      const registered = await client.registerEdgeType({
        id,
        cardinality: "many-to-many",
      });
      expect(registered.status).toBe(201);
      trackEdgeType(ctx, id);
    }
  });

  it("rejects a custom type whose id collides with a core edge type", async () => {
    const r = await client.registerEdgeType({
      id: "about",
      cardinality: "many-to-many",
    });
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("conflict");
  });

  it("refuses an edge property of an unknown type with the code a type's field gets", async () => {
    const asType = await client.registerType({
      id: `user.banana-field-${ctx.runId}`,
      fields: { ripeness: { type: "banana" as "string" } },
    });
    expect(asType.status).toBe(400);
    expect(asType.error?.error.code).toBe("invalid_schema");

    const r = await client.registerEdgeType({
      id: `mock.banana-prop.${ctx.runId}`,
      cardinality: "many-to-many",
      property_schema: { ripeness: { type: "banana" as "string" } },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe(asType.error?.error.code);
    const errors = r.error?.error.details?.errors as
      { field: string }[] | undefined;
    expect(errors?.map((e) => e.field)).toContain(
      "property_schema.ripeness.type",
    );

    // The witness: the same edge type with a known property type registers.
    const etId = `mock.number-prop.${ctx.runId}`;
    const known = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      property_schema: { ripeness: { type: "number" } },
    });
    expect(known.status).toBe(201);
    trackEdgeType(ctx, etId);
  });

  it("ships in-folder from any item to a system.folder, carrying its path", async () => {
    const r = await client.listEdgeTypes();
    expect(r.ok).toBe(true);
    const inFolder = r.data.data.find((t) => t.id === "in-folder") as
      | (Record<string, unknown> & {
          property_schema?: Record<string, unknown>;
        })
      | undefined;
    expect(inFolder).toMatchObject({
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["system.folder"],
      cascade_on_delete: "orphan",
      written_at: "source",
    });
    expect(inFolder?.reverse_name ?? null).toBeNull();
    expect(inFolder?.property_schema).toHaveProperty("path");
  });

  it("writes an in-folder edge from a key holding the source's type, the edge type and read on system.folder, and writing nothing of it", async () => {
    const made = await client.createFolder({ title: "placement" });
    expect(made.status).toBe(201);
    const folderId = made.data.item.id;
    trackFolder(ctx, folderId);

    const minted = await client.createKey({
      label: "placer",
      source: `${ctx.source}-placer`,
      type_permissions: { "core.note": "write", "system.folder": "read" },
      edge_permissions: { "in-folder": "write" },
    });
    expect(minted.status).toBe(201);
    trackKey(ctx, minted.data.id);
    const placer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const note = await placer.createItem(
      createNote({ source: `${ctx.source}-placer` }),
    );
    expect(note.status).toBe(201);
    trackItem(ctx, note.data.item.id);

    // Without read on the folder's type, the folder answers as missing.
    const blindMinted = await client.createKey({
      label: "blind-placer",
      source: `${ctx.source}-blind-placer`,
      type_permissions: { "core.note": "write" },
      edge_permissions: { "in-folder": "write" },
    });
    expect(blindMinted.status).toBe(201);
    trackKey(ctx, blindMinted.data.id);
    const blind = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: blindMinted.data.key,
    });
    const blindNote = await blind.createItem(
      createNote({ source: `${ctx.source}-blind-placer` }),
    );
    expect(blindNote.status).toBe(201);
    trackItem(ctx, blindNote.data.item.id);
    const unseen = await blind.createEdge({
      source_id: blindNote.data.item.id,
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "Notes/placed.md" },
    });
    expect(unseen.status).toBe(404);
    expect(unseen.error?.error.code).toBe("item_not_found");

    const edge = await placer.createEdge({
      source_id: note.data.item.id,
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "Notes/placed.md" },
    });
    expect(edge.status).toBe(201);
    trackEdge(ctx, edge.data.edge.id);
    expect(edge.data.edge.properties).toEqual({ path: "Notes/placed.md" });

    // The same key writes nothing of the folder row itself.
    const refusals = [
      await placer.createItem({
        type: "system.folder",
        properties: { title: "x" },
      }),
      await placer.updateItem(folderId, {
        version: 1,
        properties: { title: "x" },
      }),
      await placer.updateFolder(folderId, { version: 1, title: "x" }),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(r.error?.error.code).toBe("type_not_permitted");
    }

    // And the target is held to a folder.
    const other = await client.createItem(createNote({ source: ctx.source }));
    expect(other.status).toBe(201);
    trackItem(ctx, other.data.item.id);
    const misplaced = await placer.createEdge({
      source_id: note.data.item.id,
      target_id: other.data.item.id,
      edge_type: "in-folder",
      properties: { path: "Notes/placed.md" },
    });
    expect(misplaced.status).toBe(400);
    expect(misplaced.error?.error.code).toBe("edge_constraint_violation");
  });

  it("refuses an in-folder path that is missing or leaves the folder, and any other property, on every door that writes one", async () => {
    const made = await client.createFolder({ title: "paths" });
    expect(made.status).toBe(201);
    const folderId = made.data.item.id;
    trackFolder(ctx, folderId);
    const note = async (): Promise<string> => {
      const r = await client.createItem(createNote({ source: ctx.source }));
      expect(r.status).toBe(201);
      trackItem(ctx, r.data.item.id);
      return r.data.item.id;
    };
    const source = await note();

    for (const [properties, path] of [
      [undefined, "properties.path"],
      [{ path: "" }, "properties.path"],
      [{ path: "a".repeat(1025) }, "properties.path"],
      [{ path: "Notes/a\0.md" }, "properties.path"],
      [{ path: "/Notes/a.md" }, "properties.path"],
      [{ path: "C:/Notes/a.md" }, "properties.path"],
      [{ path: "Notes\\a.md" }, "properties.path"],
      [{ path: "Notes/../../a.md" }, "properties.path"],
      [{ path: "Notes/.." }, "properties.path"],
      [{ path: "a.md", weight: 1 }, "properties.weight"],
    ] as const) {
      const r = await client.createEdge({
        source_id: source,
        target_id: folderId,
        edge_type: "in-folder",
        ...(properties !== undefined && { properties }),
      });
      const label = JSON.stringify(properties)?.slice(0, 40);
      expect(r.status, label).toBe(400);
      expect(r.error?.error.code, label).toBe("validation_error");
      const details = r.error?.error.details as
        { errors?: { path: string }[] } | undefined;
      expect(details?.errors?.[0]?.path, label).toBe(path);
    }

    // The witness: a path that climbs and comes back inside is taken.
    const placed = await client.createEdge({
      source_id: source,
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "Notes/../Tickets/a.md" },
    });
    expect(placed.status).toBe(201);
    trackEdge(ctx, placed.data.edge.id);

    const moved = await client.updateEdge(placed.data.edge.id, {
      version: placed.data.edge.version,
      properties: { path: "../a.md" },
    });
    expect(moved.status).toBe(400);
    expect(moved.error?.error.code).toBe("validation_error");
    const upserted = await client.bulkEdges({
      atomic: false,
      edges: [
        {
          source_id: source,
          target_id: folderId,
          edge_type: "in-folder",
          properties: { path: "../a.md" },
        },
      ],
    });
    expect(upserted.status).toBe(200);
    expect(upserted.data.results[0]?.error?.code).toBe("validation_error");

    // An inline edge carries no properties, so no inline door writes one.
    const inline = [
      await client.rawRequest("/items", {
        method: "POST",
        body: {
          type: "core.note",
          source: ctx.source,
          properties: { body: "inline" },
          edges: { "in-folder": [folderId] },
        },
      }),
      await client.rawRequest(`/items/${await note()}`, {
        method: "PATCH",
        body: { version: 1, edges: { "in-folder": [folderId] } },
      }),
    ];
    for (const r of inline) {
      expect(r.status).toBe(400);
      expect(r.error?.error.code).toBe("validation_error");
    }
    const bulk = await client.bulkItems({
      atomic: false,
      items: [
        {
          type: "core.note",
          source: ctx.source,
          source_id: `in-folder-inline-${ctx.runId}`,
          properties: { body: "inline" },
          edges: { "in-folder": [folderId] },
        },
      ],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.data.results[0]?.error?.code).toBe("validation_error");
  });

  it("refuses a new placement in a revoked folder with edge_constraint_violation, and keeps the ones it held", async () => {
    const made = await client.createFolder({ title: "retired" });
    expect(made.status).toBe(201);
    const folderId = made.data.item.id;
    trackFolder(ctx, folderId);
    const note = async (): Promise<string> => {
      const r = await client.createItem(createNote({ source: ctx.source }));
      expect(r.status).toBe(201);
      trackItem(ctx, r.data.item.id);
      return r.data.item.id;
    };
    const held = await client.createEdge({
      source_id: await note(),
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "held.md" },
    });
    expect(held.status).toBe(201);
    trackEdge(ctx, held.data.edge.id);
    expect((await client.revokeFolder(folderId)).status).toBe(200);

    const refused = await client.createEdge({
      source_id: await note(),
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "new.md" },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("edge_constraint_violation");
    expect(
      (refused.error?.error.details as { constraint?: string } | undefined)
        ?.constraint,
    ).toBe("revoked");
    const bulk = await client.bulkEdges({
      atomic: false,
      edges: [
        {
          source_id: await note(),
          target_id: folderId,
          edge_type: "in-folder",
          properties: { path: "new.md" },
        },
      ],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.data.results[0]?.error?.code).toBe("edge_constraint_violation");

    expect((await client.getEdge(held.data.edge.id)).status).toBe(200);
  });

  it("says whether Marfa ships each edge type, on the list and on registration", async () => {
    const etId = `mock.shipped.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.status).toBe(201);
    trackEdgeType(ctx, etId);
    expect(reg.data.edge_type.shipped).toBe(false);

    const r = await client.listEdgeTypes();
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/edge-types", 200, r.data);
    const shipped = Object.fromEntries(
      r.data.data.map((t) => [t.id, t.shipped]),
    );
    expect(shipped["about"]).toBe(true);
    expect(shipped["in-folder"]).toBe(true);
    expect(shipped[etId]).toBe(false);
  });

  it("lists the reverse names the shipped edge types declare", async () => {
    const r = await client.listEdgeTypes();
    expect(r.ok).toBe(true);
    const reverse = Object.fromEntries(
      r.data.data
        .filter((t) => !t.id.includes("."))
        .map((t) => [t.id, t.reverse_name ?? null]),
    );
    expect(reverse["parent-of"]).toBe("child-of");
    expect(reverse["attached-to"]).toBe("has-attachment");
    // The witness: a shipped type that declares none answers none, so the
    // two above are declarations rather than a name every type is given.
    expect(reverse["references"]).toBeNull();
  });

  it("lists the end whose file writes each shipped edge type", async () => {
    const r = await client.listEdgeTypes();
    expect(r.ok).toBe(true);
    const writtenAt = Object.fromEntries(
      r.data.data
        .filter((t) => !t.id.includes("."))
        .map((t) => [t.id, t.written_at]),
    );
    // A child names its parent; everything else is written by its source,
    // an attachment included, which names what it was made for.
    expect(writtenAt["parent-of"]).toBe("target");
    expect(writtenAt["attached-to"]).toBe("source");
    expect(writtenAt["references"]).toBe("source");
  });

  it("registers an edge type with a reverse name and lists it", async () => {
    const etId = `mock.reversed.${ctx.runId}`;
    const reverse = `mock.reversed-by.${ctx.runId}`;
    const r = await client.registerEdgeType({
      id: etId,
      cardinality: "one-to-many",
      reverse_name: reverse,
    });
    expect(r.status).toBe(201);
    trackEdgeType(ctx, etId);
    await expectMatchesSchema("POST", "/edge-types", 201, r.data);
    expect(r.data.edge_type.reverse_name).toBe(reverse);

    const listed = await client.listEdgeTypes();
    await expectMatchesSchema("GET", "/edge-types", 200, listed.data);
    const mine = listed.data.data.find((t) => t.id === etId);
    expect(mine?.reverse_name).toBe(reverse);
  });

  it("refuses a reverse name another edge type already uses as a name", async () => {
    // A folder reads a frontmatter key as the edge type it names, so a name
    // held twice would say two things at once.
    const first = `mock.reverse-held.${ctx.runId}`;
    const held = `mock.held-by.${ctx.runId}`;
    const r = await client.registerEdgeType({
      id: first,
      cardinality: "many-to-many",
      reverse_name: held,
    });
    expect(r.status).toBe(201);
    trackEdgeType(ctx, first);

    const cases: Array<{ id: string; reverse_name?: string }> = [
      // A reverse name that is a shipped edge type's id.
      { id: `mock.rev-id.${ctx.runId}`, reverse_name: "about" },
      // A reverse name a shipped edge type already declares.
      { id: `mock.rev-shipped.${ctx.runId}`, reverse_name: "child-of" },
      // A reverse name a registered edge type already declares.
      { id: `mock.rev-registered.${ctx.runId}`, reverse_name: held },
      // An id that a registered edge type declares as its reverse name.
      { id: held },
      // A reverse name that is the type's own id.
      {
        id: `mock.rev-self.${ctx.runId}`,
        reverse_name: `mock.rev-self.${ctx.runId}`,
      },
    ];
    for (const body of cases) {
      const refused = await client.registerEdgeType({
        cardinality: "many-to-many",
        ...body,
      });
      expect(refused.status, JSON.stringify(body)).toBe(409);
      expect(refused.error?.error.code).toBe("conflict");
    }
  });

  it("registers an edge type written at its target, and refuses one with no name to write it under", async () => {
    const etId = `mock.written-at.${ctx.runId}`;
    const reverse = `mock.written-by.${ctx.runId}`;
    const r = await client.registerEdgeType({
      id: etId,
      cardinality: "one-to-many",
      reverse_name: reverse,
      written_at: "target",
    });
    expect(r.status).toBe(201);
    trackEdgeType(ctx, etId);
    expect(r.data.edge_type.written_at).toBe("target");

    // The default is the source, and says so.
    const plainId = `mock.written-default.${ctx.runId}`;
    const plain = await client.registerEdgeType({
      id: plainId,
      cardinality: "many-to-many",
    });
    expect(plain.status).toBe(201);
    trackEdgeType(ctx, plainId);
    expect(plain.data.edge_type.written_at).toBe("source");

    // The target's file can only write an edge under a name read from the
    // target, so a type written there must declare one.
    const nameless = await client.registerEdgeType({
      id: `mock.written-nameless.${ctx.runId}`,
      cardinality: "one-to-many",
      written_at: "target",
    });
    expect(nameless.status).toBe(400);
    expect(nameless.error?.error.code).toBe("validation_error");

    const elsewhere = await client.registerEdgeType({
      id: `mock.written-elsewhere.${ctx.runId}`,
      cardinality: "one-to-many",
      ...({ written_at: "middle" } as Record<string, unknown>),
    });
    expect(elsewhere.status).toBe(400);
  });

  it("refuses a reverse name that is not an edge type identifier", async () => {
    const r = await client.registerEdgeType({
      id: `mock.rev-shape.${ctx.runId}`,
      cardinality: "many-to-many",
      reverse_name: "Not A Name",
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("rejects registration that attempts `extends` on a core edge type (custom edges do not inherit)", async () => {
    const r = await client.registerEdgeType({
      id: `mock.extend.${ctx.runId}`,
      cardinality: "many-to-many",
      ...({ extends: "about" } as Record<string, unknown>),
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it('core-first resolution: edge_type="about" always routes to core semantics', async () => {
    const a = await client.createItem(createNote({ source: ctx.source }));
    expect(a.ok).toBe(true);
    trackItem(ctx, a.data.item.id);
    const b = await client.createItem(createNote({ source: ctx.source }));
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);
    const c = await client.createItem(createNote({ source: ctx.source }));
    expect(c.ok).toBe(true);
    trackItem(ctx, c.data.item.id);

    // The shipped registration is what answers for the name, and its
    // many-to-many cardinality is the observable: a custom `about` cannot
    // exist to shadow it, which the collision test above pins.
    const registry = await client.listEdgeTypes();
    expect(registry.ok).toBe(true);
    const about = registry.data.data.find((t) => t.id === "about");
    expect(about).toBeDefined();
    expect(about!.cardinality).toBe("many-to-many");
    expect(about!.source_type_constraints).toEqual(["*"]);
    expect(about!.target_type_constraints).toEqual(["*"]);

    const e1 = await client.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: "about",
    });
    expect(e1.ok).toBe(true);
    trackEdge(ctx, e1.data.edge.id);
    expect(e1.data.edge.edge_type).toBe("about");
    const e2 = await client.createEdge({
      source_id: a.data.item.id,
      target_id: c.data.item.id,
      edge_type: "about",
    });
    expect(e2.ok).toBe(true);
    trackEdge(ctx, e2.data.edge.id);
    expect(e2.data.edge.edge_type).toBe("about");
  });

  it("registered edge type is usable in POST /edges", async () => {
    const etId = `mock.usable.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: etId,
      cardinality: "many-to-many",
      cascade_on_delete: "orphan",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, etId);

    const a = await client.createItem(createNote({ source: ctx.source }));
    expect(a.ok).toBe(true);
    trackItem(ctx, a.data.item.id);
    const b = await client.createItem(createNote({ source: ctx.source }));
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);

    const e = await client.createEdge({
      source_id: a.data.item.id,
      target_id: b.data.item.id,
      edge_type: etId,
    });
    expect(e.ok).toBe(true);
    expect(e.data.edge.edge_type).toBe(etId);
    trackEdge(ctx, e.data.edge.id);
  });

  it("answers 404 when deleting an edge type that does not exist", async () => {
    const r = await client.deleteEdgeType(`mock.absent.${ctx.runId}`);
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("edge_type_not_found");
  });
});
