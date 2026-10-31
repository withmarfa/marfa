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
      label: "Test edge type",
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
      "derived-from",
      "excerpt-of",
      "comments-on",
      "supersedes",
      "references",
      "in-collection",
      "in-folder",
    ];
    for (const shipped of SHIPPED) {
      expect(ids).toContain(shipped);
    }
    // And no other. `toContain` per name cannot see a shipped type nobody
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
      label: "Test edge type",
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
      label: "Test edge type",
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
      label: "Test edge type",
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
      label: "Test edge type",
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

  it("deletes only the edge types whose id and reverse name the key's own edge map grants write on", async () => {
    const own = `mock.own-delete.${ctx.runId}`;
    const other = `mock.other-delete.${ctx.runId}`;
    const ownReversed = `mock.own-delete-reversed.${ctx.runId}`;
    const otherReverse = `mock.other-delete-from.${ctx.runId}`;
    for (const body of [
      { id: own, label: "Own", cardinality: "many-to-many" as const },
      { id: other, label: "Other", cardinality: "many-to-many" as const },
      {
        id: ownReversed,
        label: "Own reversed",
        cardinality: "many-to-many" as const,
        reverse_name: otherReverse,
      },
    ]) {
      expect((await client.registerEdgeType(body)).status).toBe(201);
      trackEdgeType(ctx, body.id);
    }
    const minted = await client.createKey({
      label: "edge-types-delete-own-map",
      source: `${ctx.source}-edge-delete-own-map`,
      permissions: ["schema.write"],
      type_permissions: { "core.note": "write" },
      edge_permissions: { [own]: "write", [ownReversed]: "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const listed = async () =>
      (await client.listEdgeTypes()).data.data.map((t) => t.id);

    for (const [id, refusedName] of [
      [other, other],
      [ownReversed, otherReverse],
    ] as const) {
      for (const force of [false, true]) {
        const refused = await scoped.deleteEdgeType(id, force);
        expect(refused.status, `${id} force=${String(force)}`).toBe(403);
        expect(refused.error?.error.code).toBe("edge_permission_denied");
        expect(refused.error?.error.details?.edge_type).toBe(refusedName);
        await expectMatchesSchema(
          "DELETE",
          "/edge-types/{id}",
          403,
          refused.error,
        );
      }
      expect(await listed()).toContain(id);

      // The witness: the same edge type is deleted by a key whose map
      // reaches both its names.
      expect((await client.deleteEdgeType(id)).status).toBe(200);
      expect(await listed()).not.toContain(id);
    }

    // The scoped key deletes the edge type its own map reaches.
    expect((await scoped.deleteEdgeType(own)).status).toBe(200);
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
      label: "Test edge type",
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
      label: "Test edge type",
      id: own,
      cardinality: "many-to-many",
    });
    expect(mine.status).toBe(201);
    trackEdgeType(ctx, own);

    const reversed = await scoped.registerEdgeType({
      label: "Test edge type",
      id: ownSecond,
      cardinality: "many-to-many",
      reverse_name: other,
    });
    expect(reversed.status).toBe(403);
    expect(reversed.error?.error.code).toBe("edge_permission_denied");
    expect(reversed.error?.error.details?.edge_type).toBe(other);

    for (const id of [other, readOnly]) {
      const refused = await scoped.registerEdgeType({
        label: "Test edge type",
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
        label: "Test edge type",
        id,
        cardinality: "many-to-many",
      });
      expect(registered.status).toBe(201);
      trackEdgeType(ctx, id);
    }
  });

  it("names the edge namespace wildcard an app can be granted when a key may not register a new edge type", async () => {
    const id = `user.needs-namespace-${ctx.runId}`;
    const minted = await client.createKey({
      label: "edge-types-namespace",
      source: `${ctx.source}-edge-namespace`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: { "attached-to": "write" },
      metadata_permissions: { edge_types: "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const refused = await scoped.registerEdgeType({
      label: "Test edge type",
      id,
      cardinality: "many-to-many",
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("edge_permission_denied");
    expect(refused.error?.error.details).toMatchObject({
      edge_type: id,
      required_scope: "edge.user.*:write",
    });
  });

  it("rejects a custom type whose id collides with a core edge type", async () => {
    const r = await client.registerEdgeType({
      label: "Test edge type",
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
      label: "Test edge type",
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
      label: "Test edge type",
      id: etId,
      cardinality: "many-to-many",
      property_schema: { ripeness: { type: "number" } },
    });
    expect(known.status).toBe(201);
    trackEdgeType(ctx, etId);
  });

  it("refuses a key the edge type or one of its properties does not define, naming each path", async () => {
    const id = `mock.unread-key.${ctx.runId}`;
    const refused = await client.registerEdgeType({
      id,
      label: "Test edge type",
      cardinality: "many-to-many",
      cascade: "orphan",
      property_schema: {
        rank: { type: "number", minimum: 0, maximum: 5 },
        note: { type: "string", maxLength: 10 },
      },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    const errors = refused.error?.error.details?.errors as
      { field: string }[] | undefined;
    expect(errors?.map((e) => e.field)).toEqual([
      "cascade",
      "property_schema.rank.minimum",
      "property_schema.rank.maximum",
      "property_schema.note.maxLength",
    ]);
    const listed = await client.listEdgeTypes();
    expect(listed.data.data.map((t) => t.id)).not.toContain(id);

    // The witness: the same edge type without those keys registers.
    const mended = await client.registerEdgeType({
      label: "Test edge type",
      id,
      cardinality: "many-to-many",
      cascade_on_delete: "orphan",
      property_schema: { rank: { type: "number" }, note: { type: "string" } },
    });
    expect(mended.status).toBe(201);
    trackEdgeType(ctx, id);
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
      written_at: "none",
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
      [{ path: "Notes/../Tickets/a.md" }, "properties.path"],
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

    // The witness: the same path without the `..` is taken.
    const placed = await client.createEdge({
      source_id: source,
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "Notes/Tickets/a.md" },
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

  it("names the property an in-folder refusal rests on, on an edge update, a bulk entry and an inline edge", async () => {
    const made = await client.createFolder({ title: "named" });
    expect(made.status).toBe(201);
    const folderId = made.data.item.id;
    trackFolder(ctx, folderId);
    const note = async (): Promise<string> => {
      const r = await client.createItem(createNote({ source: ctx.source }));
      expect(r.status).toBe(201);
      trackItem(ctx, r.data.item.id);
      return r.data.item.id;
    };
    const refusedAt = (
      error: { code?: string; details?: unknown } | undefined,
      path: string,
      label: string,
    ) => {
      expect(error?.code, label).toBe("validation_error");
      const details = error?.details as
        { errors?: { path: string }[] } | undefined;
      expect(
        details?.errors?.map((e) => e.path),
        label,
      ).toEqual([path]);
    };
    const source = await note();
    const placed = await client.createEdge({
      source_id: source,
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "kept.md" },
    });
    expect(placed.status).toBe(201);
    trackEdge(ctx, placed.data.edge.id);
    const { id, version } = placed.data.edge;

    // A move is judged on the properties as they would stand: the stored
    // path survives a merge that names another property, and is replaced by
    // one that names the path.
    for (const [properties, path] of [
      [{ weight: 1 }, "properties.weight"],
      [{ path: "../a.md" }, "properties.path"],
      [{ path: "" }, "properties.path"],
    ] as const) {
      const r = await client.updateEdge(id, { version, properties });
      expect(r.status, JSON.stringify(properties)).toBe(400);
      refusedAt(r.error?.error, path, `PATCH ${JSON.stringify(properties)}`);
    }
    const unchanged = await client.getEdge(id);
    expect(unchanged.data.edge.properties).toEqual({ path: "kept.md" });
    expect(unchanged.data.edge.version).toBe(version);

    // A bulk entry for a triple an edge holds merges, and one for a new
    // triple creates, so each is judged on its own properties.
    const entry = (src: string, properties?: Record<string, unknown>) => ({
      source_id: src,
      target_id: folderId,
      edge_type: "in-folder",
      ...(properties !== undefined && { properties }),
    });
    const fresh = await note();
    const best = await client.bulkEdges({
      atomic: false,
      edges: [
        entry(source, { weight: 1 }),
        entry(source, { path: "../a.md" }),
        entry(fresh, { path: "../a.md" }),
        entry(fresh),
      ],
    });
    expect(best.status).toBe(200);
    expect(best.data.counts).toMatchObject({ created: 0, errored: 4 });
    const [merged, replaced, created, missing] = best.data.results;
    refusedAt(merged?.error, "properties.weight", "bulk merge adds a property");
    refusedAt(replaced?.error, "properties.path", "bulk merge replaces path");
    refusedAt(created?.error, "properties.path", "bulk create climbs out");
    refusedAt(missing?.error, "properties.path", "bulk create names no path");

    const rolled = await client.bulkEdges({
      atomic: true,
      edges: [entry(fresh, { path: "ok.md" }), entry(source, { weight: 1 })],
    });
    expect(rolled.status).toBe(400);
    expect(rolled.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rolled.error?.error.details).toMatchObject({
      index: 1,
      code: "validation_error",
    });
    refusedAt(
      rolled.error?.error.details as { code?: string; details?: unknown },
      "properties.weight",
      "atomic bulk",
    );
    const after = await client.listItemEdges(fresh, { edge_type: "in-folder" });
    expect(after.data.data).toEqual([]);

    // An inline edge carries no properties, so the path is what it lacks.
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
    for (const [i, r] of inline.entries()) {
      expect(r.status, `inline ${String(i)}`).toBe(400);
      refusedAt(r.error?.error, "properties.path", `inline ${String(i)}`);
    }

    // The witness: a path that stays inside the folder moves the edge on.
    const moved = await client.updateEdge(id, {
      version,
      properties: { path: "moved.md" },
    });
    expect(moved.status).toBe(200);
    expect(moved.data.edge.properties).toEqual({ path: "moved.md" });
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
      label: "Test edge type",
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

  it("says which edge types refuse a cycle and which refuse nesting, on the list and on registration", async () => {
    const etId = `mock.acyclic.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      label: "Test edge type",
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.status).toBe(201);
    trackEdgeType(ctx, etId);
    expect(reg.data.edge_type.acyclic).toBe(false);
    expect(reg.data.edge_type.flat).toBe(false);

    const r = await client.listEdgeTypes();
    expect(r.ok).toBe(true);
    await expectMatchesSchema("GET", "/edge-types", 200, r.data);
    const listed = Object.fromEntries(
      r.data.data.map((t) => [t.id, { acyclic: t.acyclic, flat: t.flat }]),
    );
    expect(listed["parent-of"]).toEqual({ acyclic: true, flat: false });
    expect(listed["supersedes"]).toEqual({ acyclic: true, flat: false });
    expect(listed["in-collection"]).toEqual({ acyclic: false, flat: true });
    expect(listed["references"]).toEqual({ acyclic: false, flat: false });
    expect(listed[etId]).toEqual({ acyclic: false, flat: false });
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

  it("lists a label and a reverse label on every shipped edge type", async () => {
    const r = await client.listEdgeTypes();
    expect(r.ok).toBe(true);
    const names = Object.fromEntries(
      r.data.data
        .filter((t) => !t.id.includes("."))
        .map((t) => [t.id, [t.label, t.reverse_label]]),
    );
    expect(names).toEqual({
      about: ["About", "Subject of"],
      "attached-to": ["Attached to", "Attachments"],
      "comments-on": ["Comment on", "Comments"],
      "derived-from": ["Derived from", "Basis for"],
      "excerpt-of": ["Excerpt of", "Excerpts"],
      "in-collection": ["In collection", "Contents"],
      "in-folder": ["In folder", "Folder contents"],
      "in-thread": ["In thread", "Messages"],
      "parent-of": ["Children", "Parent"],
      references: ["References", "Referenced by"],
      supersedes: ["Supersedes", "Superseded by"],
    });
  });

  it("lists the reverse label a registration names, and the label where it names none", async () => {
    const named = `mock.labelled.${ctx.runId}`;
    const alone = `mock.labelled-alone.${ctx.runId}`;
    const first = await client.registerEdgeType({
      id: named,
      label: "Mentees",
      reverse_label: "Mentor",
      cardinality: "one-to-many",
    });
    expect(first.status).toBe(201);
    trackEdgeType(ctx, named);
    await expectMatchesSchema("POST", "/edge-types", 201, first.data);
    expect(first.data.edge_type.reverse_label).toBe("Mentor");
    const second = await client.registerEdgeType({
      id: alone,
      label: "Related to",
      cardinality: "many-to-many",
    });
    expect(second.status).toBe(201);
    trackEdgeType(ctx, alone);
    expect(second.data.edge_type.reverse_label).toBe("Related to");

    const listed = await client.listEdgeTypes();
    await expectMatchesSchema("GET", "/edge-types", 200, listed.data);
    const row = (id: string) => listed.data.data.find((t) => t.id === id);
    expect([row(named)?.label, row(named)?.reverse_label]).toEqual([
      "Mentees",
      "Mentor",
    ]);
    expect([row(alone)?.label, row(alone)?.reverse_label]).toEqual([
      "Related to",
      "Related to",
    ]);
  });

  it("makes the label of a registered edge type from its identifier when it names none or an empty one", async () => {
    const bare = `mock.${ctx.runId}.pair-link`;
    const empty = `mock.${ctx.runId}.empty_label`;
    const first = await client.registerEdgeType({
      id: bare,
      cardinality: "many-to-many",
    });
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    trackEdgeType(ctx, bare);
    await expectMatchesSchema("POST", "/edge-types", 201, first.data);
    expect([
      first.data.edge_type.label,
      first.data.edge_type.reverse_label,
    ]).toEqual(["Pair Link", "Pair Link"]);
    const second = await client.registerEdgeType({
      id: empty,
      label: "",
      cardinality: "many-to-many",
    });
    expect(second.status, JSON.stringify(second.error)).toBe(201);
    trackEdgeType(ctx, empty);
    expect(second.data.edge_type.label).toBe("Empty Label");

    const listed = (await client.listEdgeTypes()).data.data;
    expect(listed.find((t) => t.id === bare)?.label).toBe("Pair Link");
    expect(listed.find((t) => t.id === empty)?.label).toBe("Empty Label");
  });

  it("keeps the label a registration names", async () => {
    const id = `mock.${ctx.runId}.pair-link-named`;
    const named = await client.registerEdgeType({
      id,
      label: "Partners",
      cardinality: "many-to-many",
    });
    expect(named.status, JSON.stringify(named.error)).toBe(201);
    trackEdgeType(ctx, id);
    expect(named.data.edge_type.label).toBe("Partners");
    const row = (await client.listEdgeTypes()).data.data.find(
      (t) => t.id === id,
    );
    expect(row?.label).toBe("Partners");
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
    expect(writtenAt["comments-on"]).toBe("source");
    expect(writtenAt["references"]).toBe("source");
    // No file writes the placement of a file, so the edge names no end.
    expect(writtenAt["in-folder"]).toBe("none");
  });

  it("registers an edge type with a reverse name and lists it", async () => {
    const etId = `mock.reversed.${ctx.runId}`;
    const reverse = `mock.reversed-by.${ctx.runId}`;
    const r = await client.registerEdgeType({
      label: "Test edge type",
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
      label: "Test edge type",
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
        label: "Test edge type",
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
      label: "Test edge type",
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
      label: "Test edge type",
      id: plainId,
      cardinality: "many-to-many",
    });
    expect(plain.status).toBe(201);
    trackEdgeType(ctx, plainId);
    expect(plain.data.edge_type.written_at).toBe("source");

    // An edge no file writes names no end, and needs no name to write it under.
    const noneId = `mock.written-none.${ctx.runId}`;
    const none = await client.registerEdgeType({
      label: "Test edge type",
      id: noneId,
      cardinality: "many-to-many",
      written_at: "none",
    });
    expect(none.status, JSON.stringify(none.error)).toBe(201);
    trackEdgeType(ctx, noneId);
    expect(none.data.edge_type.written_at).toBe("none");
    const listedNone = await client.listEdgeTypes();
    expect(listedNone.data.data.find((t) => t.id === noneId)?.written_at).toBe(
      "none",
    );
    const bogus = await client.registerEdgeType({
      label: "Test edge type",
      id: `mock.written-bogus.${ctx.runId}`,
      cardinality: "many-to-many",
      written_at: "nowhere" as never,
    });
    expect(bogus.status).toBe(400);

    // The target's file can only write an edge under a name read from the
    // target, so a type written there must declare one.
    const nameless = await client.registerEdgeType({
      label: "Test edge type",
      id: `mock.written-nameless.${ctx.runId}`,
      cardinality: "one-to-many",
      written_at: "target",
    });
    expect(nameless.status).toBe(400);
    expect(nameless.error?.error.code).toBe("validation_error");

    const elsewhere = await client.registerEdgeType({
      label: "Test edge type",
      id: `mock.written-elsewhere.${ctx.runId}`,
      cardinality: "one-to-many",
      ...({ written_at: "middle" } as Record<string, unknown>),
    });
    expect(elsewhere.status).toBe(400);
  });

  it("refuses an id that is not an edge type identifier with 400 validation_error, and registers one that is", async () => {
    for (const id of [
      "",
      "Bad Id",
      "MY-EDGE",
      "-",
      "../-",
      "mock..name",
      "mock.1name",
      "app.two-segments",
    ]) {
      const r = await client.registerEdgeType({
        label: "Test edge type",
        id,
        cardinality: "many-to-many",
      });
      expect(r.status, JSON.stringify(id)).toBe(400);
      expect(r.error?.error.code, JSON.stringify(id)).toBe("validation_error");
    }
    const listed = await client.listEdgeTypes();
    expect(listed.data.data.map((t) => t.id)).not.toContain("Bad Id");

    // The witnesses: the kebab form a shipped type has, and the dotted form.
    for (const id of [`mock-kebab-${ctx.runId}`, `mock.dotted.${ctx.runId}`]) {
      const r = await client.registerEdgeType({
        label: "Test edge type",
        id,
        cardinality: "many-to-many",
      });
      expect(r.status, id).toBe(201);
      trackEdgeType(ctx, id);
    }
  });

  it("refuses an id a registered edge type already holds with 409 conflict, and keeps the first", async () => {
    const etId = `mock.twice.${ctx.runId}`;
    const first = await client.registerEdgeType({
      label: "Test edge type",
      id: etId,
      cardinality: "one-to-one",
    });
    expect(first.status).toBe(201);
    trackEdgeType(ctx, etId);

    const second = await client.registerEdgeType({
      label: "Test edge type",
      id: etId,
      cardinality: "many-to-many",
    });
    expect(second.status).toBe(409);
    expect(second.error?.error.code).toBe("conflict");
    const listed = await client.listEdgeTypes();
    const held = listed.data.data.filter((t) => t.id === etId);
    expect(held.map((t) => t.cardinality)).toEqual(["one-to-one"]);
  });

  it("refuses a type constraint naming an unknown role with 400 validation_error, and takes a known one", async () => {
    for (const [field, constraints] of [
      ["source_type_constraints", ["role:no-such-role"]],
      ["target_type_constraints", ["core.note", "role:no-such-role"]],
    ] as const) {
      const r = await client.registerEdgeType({
        label: "Test edge type",
        id: `mock.badrole.${ctx.runId}`,
        cardinality: "many-to-many",
        [field]: constraints,
      });
      expect(r.status, field).toBe(400);
      expect(r.error?.error.code, field).toBe("validation_error");
    }
    const listed = await client.listEdgeTypes();
    expect(listed.data.data.map((t) => t.id)).not.toContain(
      `mock.badrole.${ctx.runId}`,
    );

    const etId = `mock.goodrole.${ctx.runId}`;
    const known = await client.registerEdgeType({
      label: "Test edge type",
      id: etId,
      cardinality: "many-to-many",
      target_type_constraints: ["role:container"],
    });
    expect(known.status).toBe(201);
    trackEdgeType(ctx, etId);
    expect(known.data.edge_type.target_type_constraints).toEqual([
      "role:container",
    ]);
  });

  it("refuses an edge property of type thumbnail, as its type, its items type or its format, with 400 validation_error", async () => {
    for (const [name, property] of [
      ["type", { type: "thumbnail" }],
      ["items_type", { type: "array", items_type: "thumbnail" }],
      ["format", { type: "string", format: "thumbnail" }],
    ] as const) {
      const r = await client.registerEdgeType({
        label: "Test edge type",
        id: `mock.thumb.${ctx.runId}`,
        cardinality: "many-to-many",
        property_schema: { picture: property },
      });
      expect(r.status, name).toBe(400);
      expect(r.error?.error.code, name).toBe("validation_error");
    }

    // The witness: the same property with the types an edge may carry.
    const etId = `mock.nothumb.${ctx.runId}`;
    const ok = await client.registerEdgeType({
      label: "Test edge type",
      id: etId,
      cardinality: "many-to-many",
      property_schema: {
        picture: { type: "string" },
        pictures: { type: "array", items_type: "string" },
      },
    });
    expect(ok.status).toBe(201);
    trackEdgeType(ctx, etId);
  });

  it("refuses to delete a shipped edge type with 400 validation_error, and lists it still", async () => {
    for (const shipped of ["about", "in-folder"]) {
      for (const force of [false, true]) {
        const r = await client.deleteEdgeType(shipped, force);
        expect(r.status, `${shipped} ${String(force)}`).toBe(400);
        expect(r.error?.error.code, shipped).toBe("validation_error");
      }
    }
    const listed = await client.listEdgeTypes();
    const ids = listed.data.data.map((t) => t.id);
    expect(ids).toContain("about");
    expect(ids).toContain("in-folder");

    // The witness: a registered type is deleted at the same door.
    const etId = `mock.deletable.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      label: "Test edge type",
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.status).toBe(201);
    trackEdgeType(ctx, etId);
    expect((await client.deleteEdgeType(etId)).status).toBe(200);
  });

  it("answers the edge type list as the whole list, with a null next_cursor", async () => {
    const etId = `mock.wholelist.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      label: "Test edge type",
      id: etId,
      cardinality: "many-to-many",
    });
    expect(reg.status).toBe(201);
    trackEdgeType(ctx, etId);

    const r = await client.listEdgeTypes();
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(["data", "next_cursor"]);
    expect(r.data.next_cursor).toBeNull();
    // Shipped and registered together: a page with a cursor would hold one
    // of the two first.
    const ids = r.data.data.map((t) => t.id);
    expect(ids).toContain("about");
    expect(ids).toContain(etId);
  });

  it("refuses a reverse name that is not an edge type identifier", async () => {
    const r = await client.registerEdgeType({
      label: "Test edge type",
      id: `mock.rev-shape.${ctx.runId}`,
      cardinality: "many-to-many",
      reverse_name: "Not A Name",
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });

  it("rejects registration that attempts extends on a core edge type (custom edges do not inherit)", async () => {
    const r = await client.registerEdgeType({
      label: "Test edge type",
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
      label: "Test edge type",
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

describe("the order POST /edge-types asks its refusals in", () => {
  let keyCount = 0;

  async function registrar(
    edgeMap: Record<string, "read" | "write">,
    withSchemaGrant = true,
  ): Promise<MarfaClient> {
    keyCount += 1;
    const minted = await client.createKey({
      label: `edge-type-order-${String(keyCount)}`,
      source: `${ctx.source}-edge-type-order-${String(keyCount)}`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: edgeMap,
      ...(withSchemaGrant && { metadata_permissions: { edge_types: "write" } }),
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
  }

  const extending = { extends: "about" } as Record<string, unknown>;

  it("answers a shipped id as a conflict before it refuses extends", async () => {
    const shipped = await client.registerEdgeType({
      label: "Test edge type",
      id: "about",
      cardinality: "many-to-many",
      ...extending,
    });
    expect(shipped.status).toBe(409);
    expect(shipped.error?.error.code).toBe("conflict");

    // The witness: an id of its own with the same extends is the refusal of extends.
    const alone = await client.registerEdgeType({
      label: "Test edge type",
      id: `mock.order-extends.${ctx.runId}`,
      cardinality: "many-to-many",
      ...extending,
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("validation_error");
  });

  it("answers a shipped id as a conflict before it asks the key's edge map", async () => {
    const own = `mock.order-shipped.${ctx.runId}`;
    const scoped = await registrar({ [own]: "write" });
    const shipped = await scoped.registerEdgeType({
      label: "Test edge type",
      id: "about",
      cardinality: "many-to-many",
    });
    expect(shipped.status).toBe(409);
    expect(shipped.error?.error.code).toBe("conflict");

    // The witness: the same key is refused an id its map does not grant.
    const alone = await scoped.registerEdgeType({
      label: "Test edge type",
      id: `mock.order-ungranted.${ctx.runId}`,
      cardinality: "many-to-many",
    });
    expect(alone.status).toBe(403);
    expect(alone.error?.error.code).toBe("edge_permission_denied");
  });

  it("refuses an id the key's edge map does not grant before it refuses extends", async () => {
    const granted = `mock.order-granted.${ctx.runId}`;
    const ungranted = `mock.order-denied.${ctx.runId}`;
    const scoped = await registrar({ [granted]: "write" });
    const denied = await scoped.registerEdgeType({
      label: "Test edge type",
      id: ungranted,
      cardinality: "many-to-many",
      ...extending,
    });
    expect(denied.status).toBe(403);
    expect(denied.error?.error.code).toBe("edge_permission_denied");
    expect(denied.error?.error.details?.edge_type).toBe(ungranted);

    // The witness: an id the map grants meets the refusal of extends.
    const alone = await scoped.registerEdgeType({
      label: "Test edge type",
      id: granted,
      cardinality: "many-to-many",
      ...extending,
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("validation_error");
  });

  it("refuses a key the edge type does not define before it answers an id a registered edge type holds", async () => {
    const id = `mock.order-unread.${ctx.runId}`;
    const first = await client.registerEdgeType({
      label: "Test edge type",
      id,
      cardinality: "many-to-many",
    });
    expect(first.status).toBe(201);
    trackEdgeType(ctx, id);

    const unread = await client.registerEdgeType({
      id,
      label: "Test edge type",
      cardinality: "many-to-many",
      cascade: "orphan",
    } as never);
    expect(unread.status).toBe(400);
    expect(unread.error?.error.code).toBe("invalid_schema");

    // The witness: without the key, the same body is the held id's conflict.
    const alone = await client.registerEdgeType({
      label: "Test edge type",
      id,
      cardinality: "many-to-many",
    });
    expect(alone.status).toBe(409);
    expect(alone.error?.error.code).toBe("conflict");
  });

  it("refuses extends before a key the edge type does not define", async () => {
    const both = await client.registerEdgeType({
      id: `mock.order-extends-unread.${ctx.runId}`,
      label: "Test edge type",
      cardinality: "many-to-many",
      cascade: "orphan",
      ...extending,
    } as never);
    expect(both.status).toBe(400);
    expect(both.error?.error.code).toBe("validation_error");
  });

  it("refuses a key without metadata.edge_types:write before it answers a shipped id", async () => {
    const bare = await registrar({ "*": "write" }, false);
    const refused = await bare.registerEdgeType({
      label: "Test edge type",
      id: "about",
      cardinality: "many-to-many",
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");

    // The witness: with the grant, the same body is the shipped id's conflict.
    const granted = await registrar({ "*": "write" });
    const alone = await granted.registerEdgeType({
      label: "Test edge type",
      id: "about",
      cardinality: "many-to-many",
    });
    expect(alone.status).toBe(409);
    expect(alone.error?.error.code).toBe("conflict");
  });

  it("refuses an id that is not an edge type identifier before it asks the key's edge map", async () => {
    const scoped = await registrar({
      [`mock.order-identifier.${ctx.runId}`]: "write",
    });
    const malformed = await scoped.registerEdgeType({
      label: "Test edge type",
      id: "Not An Identifier",
      cardinality: "many-to-many",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");

    // The witness: a well formed id the map does not grant is the map's refusal.
    const alone = await scoped.registerEdgeType({
      label: "Test edge type",
      id: `mock.order-identifier-denied.${ctx.runId}`,
      cardinality: "many-to-many",
    });
    expect(alone.status).toBe(403);
    expect(alone.error?.error.code).toBe("edge_permission_denied");
  });
});

describe("explicit edge-type constraint evolution", () => {
  it("widens endpoint constraints without rewriting held edges", async () => {
    const definition = {
      id: `mock.evolve.${ctx.runId}`,
      label: "Kept connection",
      cardinality: "many-to-many" as const,
      source_type_constraints: ["core.note"],
      target_type_constraints: ["core.note"],
    };
    expect((await client.registerEdgeType(definition)).status).toBe(201);
    trackEdgeType(ctx, definition.id);
    const note = async () => {
      const answer = await client.createItem(
        createNote({ source: ctx.source }),
      );
      expect(answer.status).toBe(201);
      trackItem(ctx, answer.data.item.id);
      return answer.data.item;
    };
    const a = await note();
    const b = await note();
    const made = await client.createEdge({
      source_id: a.id,
      target_id: b.id,
      edge_type: definition.id,
      properties: { note: "Kept" },
    });
    expect(made.status).toBe(201);
    trackEdge(ctx, made.data.edge.id);
    const before = (await client.getEdge(made.data.edge.id)).data.edge;
    const evolution = {
      ...definition,
      source_type_constraints: ["core.note", "core.task"],
      evolve_constraints: true,
    };
    const changed = await client.registerEdgeType(evolution);
    expect(changed.status).toBe(200);
    await expectMatchesSchema("POST", "/edge-types", 200, changed.data);
    expect(changed.data.edge_type.source_type_constraints).toEqual([
      "core.note",
      "core.task",
    ]);
    expect(changed.data.edge_type).not.toHaveProperty("evolve_constraints");
    expect((await client.getEdge(made.data.edge.id)).data.edge).toEqual(before);
    expect((await client.registerEdgeType(evolution)).status).toBe(200);
    expect((await client.getEdge(made.data.edge.id)).data.edge).toEqual(before);
  });

  it("changes the labels of a registered edge type in place", async () => {
    const definition = {
      id: `mock.evolve-labels.${ctx.runId}`,
      label: "Kept connection",
      reverse_label: "Kept by",
      cardinality: "many-to-many" as const,
    };
    expect((await client.registerEdgeType(definition)).status).toBe(201);
    trackEdgeType(ctx, definition.id);
    const row = async () =>
      (await client.listEdgeTypes()).data.data.find(
        (one) => one.id === definition.id,
      );

    const evolve = (change: Record<string, unknown>) => {
      const body = { ...definition, ...change, evolve_constraints: true };
      return client.registerEdgeType(body);
    };
    const renamed = await evolve({
      label: "Held connection",
      reverse_label: "Held by",
    });
    expect(renamed.status).toBe(200);
    expect((await row())?.label).toBe("Held connection");
    expect((await row())?.reverse_label).toBe("Held by");

    // Naming no reverse label keeps the stored one. A reverse label equal
    // to the label makes the type two-way, and it then stays as it was set
    // when the label changes alone.
    const kept = await evolve({ label: "Linked", reverse_label: undefined });
    expect(kept.status).toBe(200);
    expect((await row())?.label).toBe("Linked");
    expect((await row())?.reverse_label).toBe("Held by");
    const both = await evolve({ label: "Linked", reverse_label: "Linked" });
    expect(both.status).toBe(200);
    expect((await row())?.reverse_label).toBe("Linked");
    const again = await evolve({ label: "Joined", reverse_label: undefined });
    expect(again.status).toBe(200);
    expect((await row())?.label).toBe("Joined");
    expect((await row())?.reverse_label).toBe("Linked");
  });

  it("keeps the labels of a registered edge type when an evolution names none", async () => {
    const named = {
      id: `mock.evolve-labels-kept.${ctx.runId}`,
      label: "Kept connection",
      reverse_label: "Kept by",
      cardinality: "many-to-many" as const,
      source_type_constraints: ["core.note"],
    };
    const twoWay = {
      id: `mock.evolve-labels-two-way.${ctx.runId}`,
      label: "Joined to",
      cardinality: "many-to-many" as const,
      source_type_constraints: ["core.note"],
    };
    for (const definition of [named, twoWay]) {
      expect((await client.registerEdgeType(definition)).status).toBe(201);
      trackEdgeType(ctx, definition.id);
    }
    const bare = (definition: typeof named | typeof twoWay) => ({
      id: definition.id,
      cardinality: definition.cardinality,
      source_type_constraints: ["*"],
      evolve_constraints: true,
    });
    for (const definition of [named, twoWay]) {
      const widened = await client.registerEdgeType(bare(definition));
      expect(widened.status, JSON.stringify(widened.error)).toBe(200);
    }
    const listed = (await client.listEdgeTypes()).data.data;
    const row = (id: string) => listed.find((t) => t.id === id);
    expect([row(named.id)?.label, row(named.id)?.reverse_label]).toEqual([
      "Kept connection",
      "Kept by",
    ]);
    expect([row(twoWay.id)?.label, row(twoWay.id)?.reverse_label]).toEqual([
      "Joined to",
      "Joined to",
    ]);
    // The witness that the evolution ran: the endpoint is widened.
    expect(row(named.id)?.source_type_constraints).toEqual(["*"]);
  });

  it("refuses narrowing, structural changes, and a missing evolution target", async () => {
    const definition = {
      id: `mock.evolve-refused.${ctx.runId}`,
      label: "Kept connection",
      cardinality: "many-to-many" as const,
      source_type_constraints: ["core.note"],
    };
    expect((await client.registerEdgeType(definition)).status).toBe(201);
    trackEdgeType(ctx, definition.id);
    const before = (await client.listEdgeTypes()).data.data.find(
      (one) => one.id === definition.id,
    );
    for (const change of [
      { source_type_constraints: ["core.task"] },
      { cardinality: "many-to-one" as const },
      { description: "Changed" },
    ]) {
      const evolution = { ...definition, ...change, evolve_constraints: true };
      const refused = await client.registerEdgeType(evolution);
      expect(refused.status).toBe(409);
      expect(
        (await client.listEdgeTypes()).data.data.find(
          (one) => one.id === definition.id,
        ),
      ).toEqual(before);
    }
    const missing = {
      ...definition,
      id: `mock.evolve-missing.${ctx.runId}`,
      evolve_constraints: true,
    };
    expect((await client.registerEdgeType(missing)).status).toBe(404);
    expect((await client.registerEdgeType(definition)).status).toBe(409);
  });

  it("treats empty and wildcard constraint lists as unrestricted", async () => {
    const definition = {
      id: `mock.evolve-unrestricted.${ctx.runId}`,
      label: "Kept connection",
      cardinality: "many-to-many" as const,
      source_type_constraints: [],
    };
    expect((await client.registerEdgeType(definition)).status).toBe(201);
    trackEdgeType(ctx, definition.id);
    const narrowing = {
      ...definition,
      source_type_constraints: ["core.note"],
      evolve_constraints: true,
    };
    expect((await client.registerEdgeType(narrowing)).status).toBe(409);
    const wildcard = {
      ...definition,
      source_type_constraints: ["*"],
      evolve_constraints: true,
    };
    expect((await client.registerEdgeType(wildcard)).status).toBe(200);
    const empty = { ...definition, evolve_constraints: true };
    expect((await client.registerEdgeType(empty)).status).toBe(200);
  });
});

it("preserves an admitted addition when constraint evolutions compete", async () => {
  const definition = {
    id: `mock.evolve-race.${ctx.runId}`,
    label: "Kept connection",
    cardinality: "many-to-many" as const,
    source_type_constraints: ["core.note"],
  };
  expect((await client.registerEdgeType(definition)).status).toBe(201);
  trackEdgeType(ctx, definition.id);
  const attempts = await Promise.all(
    ["core.task", "core.message"].map((type) => {
      const evolution = {
        ...definition,
        source_type_constraints: ["core.note", type],
        evolve_constraints: true,
      };
      return client.registerEdgeType(evolution);
    }),
  );
  expect(attempts.map((one) => one.status).sort()).toEqual([200, 409]);
  const held = (await client.listEdgeTypes()).data.data.find(
    (one) => one.id === definition.id,
  );
  expect(held?.source_type_constraints).toHaveLength(2);
  const combined = {
    ...definition,
    source_type_constraints: ["core.note", "core.task", "core.message"],
    evolve_constraints: true,
  };
  expect((await client.registerEdgeType(combined)).status).toBe(200);
});
