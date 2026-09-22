import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
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
    const ids = r.data.edge_types.map((t) => t.id);
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
    ];
    for (const shipped of SHIPPED) {
      expect(ids).toContain(shipped);
    }
    // And no tenth. `toContain` per name cannot see a shipped type nobody
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
    const mine = r.data.edge_types.find((t) => t.id === etId);
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

    const removed = await client.deleteEdgeType(etId);
    expect(removed.ok).toBe(true);
    await expectMatchesSchema("DELETE", "/edge-types/{id}", 200, removed.data);
    const listed = await client.listEdgeTypes();
    expect(listed.ok).toBe(true);
    expect(listed.data.edge_types.map((t) => t.id)).not.toContain(etId);
    const again = await client.deleteEdgeType(etId);
    expect(again.status).toBe(404);
    expect(again.error?.error.code).toBe("edge_type_not_found");
  });

  it("refuses to delete an edge type while edges of it exist, and orphans them on force", async () => {
    // The sibling shape. `DELETE /types/{id}` refuses `409 type_in_use`
    // while rows of the type exist and takes `?force=true` to delete
    // anyway; this door answered `200` and looked at nothing but the
    // core list and the row, leaving edges naming a type the instance no
    // longer held. Its own published description promised the refusal it
    // did not make.
    //
    // A new code rather than `type_in_use`, matching the
    // `edge_type_not_found` that already sits beside `type_not_found`:
    // the two doors agree in shape, and an edge type is not a type.
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
    expect(stillListed.data.edge_types.map((t) => t.id)).toContain(etId);

    // `force` is the way through, and it orphans rather than cascades:
    // the edges are the caller's to deal with, and deleting rows nobody
    // asked to delete is the worse of the two surprises.
    const forced = await client.deleteEdgeType(etId, { force: true });
    expect(forced.ok, JSON.stringify(forced.error)).toBe(true);
    expect(forced.status).toBe(200);

    const listed = await client.listEdgeTypes();
    expect(listed.data.edge_types.map((t) => t.id)).not.toContain(etId);

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

    const removed = await client.deleteEdgeType(etId);
    expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
    expect(removed.status).toBe(200);

    const listed = await client.listEdgeTypes();
    expect(listed.data.edge_types.map((t) => t.id)).not.toContain(etId);
  });

  it("refuses a delete to a key without schema.write, and declares the refusal", async () => {
    // The door gates on `schema.write` and published no 403, so the one
    // refusal a caller arranges by holding the wrong credential was absent
    // from the document. `expectMatchesSchema` is the half that reddens if
    // the declaration goes: it throws when the served document declares no
    // such status for the door.
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

  it("rejects a custom type whose id collides with a core edge type", async () => {
    const r = await client.registerEdgeType({
      id: "about",
      cardinality: "many-to-many",
    });
    expect(r.status).toBe(409);
    expect(r.error?.error.code).toBe("conflict");
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
    const about = registry.data.edge_types.find((t) => t.id === "about");
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
