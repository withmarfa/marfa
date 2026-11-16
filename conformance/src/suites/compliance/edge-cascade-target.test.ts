import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import {
  createBookmark,
  createNote,
  generateId,
} from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-cascade-target",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const bookmarkWrite = { kind: "type", name: "core.bookmark", level: "write" };

async function mintClient(
  label: string,
  opts: {
    type_permissions: Record<string, string>;
    edge_permissions: Record<string, string>;
    metadata_permissions?: Record<string, string>;
  },
): Promise<MarfaClient> {
  const minted = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    permissions: [],
    ...opts,
  });
  expect(minted.ok).toBe(true);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

async function noteBy(c: MarfaClient): Promise<string> {
  const made = await c.createItem(createNote());
  expect(made.status).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function bookmark(): Promise<string> {
  const made = await client.createItem(createBookmark({ source: ctx.source }));
  expect(made.status).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function registerCascading(
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const made = await client.registerEdgeType({
    id,
    label: "Cascading test edge type",
    cardinality: "many-to-many",
    cascade_on_delete: "cascade",
    ...extra,
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackEdgeType(ctx, id);
}

/** The code and grant an answer of any door carries for the refusal. */
function refusal(r: ApiResponse<unknown>): { code?: string; grant?: unknown } {
  const body = r.data as {
    results?: { error?: { code: string; details?: { grant?: unknown } } }[];
  };
  const entry = body?.results?.[0]?.error;
  if (entry) return { code: entry.code, grant: entry.details?.grant };
  const error = r.error?.error;
  if (error?.code === "bulk_atomic_rollback") {
    const inner = error.details?.details as { grant?: unknown } | undefined;
    return { code: error.details?.code as string, grant: inner?.grant };
  }
  return { code: error?.code, grant: error?.details?.grant };
}

function track(r: ApiResponse<unknown>, door: string): void {
  const data = r.data as {
    item?: { id: string };
    edge?: { id: string };
    results?: { id?: string }[];
  };
  if (data.item) trackItem(ctx, data.item.id);
  if (data.edge) trackEdge(ctx, data.edge.id);
  for (const { id } of data.results ?? []) {
    if (id === undefined) continue;
    if (door.startsWith("POST /edges")) trackEdge(ctx, id);
    else trackItem(ctx, id);
  }
}

describe("an edge that cascades on delete takes write on its to item's type", () => {
  let writer: MarfaClient;
  let source: string;
  let readOnlyTarget: string;
  const NATURAL_KEY = "cascade-target-upsert";

  /** Every door that creates an edge from the source or from a new item. */
  const doors: {
    name: string;
    write: (edgeType: string, target: string) => Promise<ApiResponse<unknown>>;
  }[] = [
    {
      name: "POST /edges",
      write: (edgeType, target) =>
        writer.createEdge({
          from_id: source,
          to_id: target,
          edge_type: edgeType,
        }),
    },
    {
      name: "POST /edges/bulk (atomic)",
      write: (edgeType, target) =>
        writer.bulkEdges({
          atomic: true,
          edges: [
            { from_id: source, to_id: target, edge_type: edgeType },
          ],
        }),
    },
    {
      name: "POST /edges/bulk (not atomic)",
      write: (edgeType, target) =>
        writer.bulkEdges({
          atomic: false,
          edges: [
            { from_id: source, to_id: target, edge_type: edgeType },
          ],
        }),
    },
    {
      name: "POST /items with edges",
      write: (edgeType, target) =>
        writer.createItem(createNote({ edges: { [edgeType]: [target] } })),
    },
    {
      name: "POST /items with edges, resolving a natural key",
      write: (edgeType, target) =>
        writer.createItem(
          createNote({
            source_id: NATURAL_KEY,
            properties: { body: "upserted" },
            edges: { [edgeType]: [target] },
          }),
        ),
    },
    {
      name: "PATCH /items/{id} with edges",
      write: async (edgeType, target) => {
        const current = await writer.getItem(source);
        return writer.updateItem(source, {
          version: current.data.item.version,
          edges: { [edgeType]: [target] },
        });
      },
    },
    {
      name: "POST /items/bulk with edges (atomic)",
      write: (edgeType, target) =>
        writer.bulkItems({
          atomic: true,
          items: [
            {
              type: "core.note",
              properties: { body: "inline edge in bulk" },
              edges: { [edgeType]: [target] },
            },
          ],
        }),
    },
    {
      name: "POST /items/bulk with edges (not atomic)",
      write: (edgeType, target) =>
        writer.bulkItems({
          atomic: false,
          items: [
            {
              type: "core.note",
              properties: { body: "inline edge in bulk" },
              edges: { [edgeType]: [target] },
            },
          ],
        }),
    },
  ];

  beforeAll(async () => {
    writer = await mintClient("cascade-target", {
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
      edge_permissions: { "*": "write" },
    });
    source = await noteBy(writer);
    readOnlyTarget = await bookmark();
    const keyed = await writer.createItem(
      createNote({
        source_id: NATURAL_KEY,
        properties: { body: "upserted" },
      }),
    );
    expect(keyed.status).toBe(201);
    trackItem(ctx, keyed.data.item.id);
  });

  it.each(doors)(
    "$name refuses an edge of a type that cascades to a to item the key may read and not write, naming the grant to write its type",
    async (door) => {
      // The witnesses: the same target takes an edge of a type that does not
      // cascade, and a target the key may write takes one that does.
      const kept = await door.write("about", readOnlyTarget);
      expect(kept.status, JSON.stringify(kept.error)).toBeLessThan(300);
      track(kept, door.name);
      const writable = await noteBy(writer);
      const cascaded = await door.write("parent-of", writable);
      expect(cascaded.status, JSON.stringify(cascaded.error)).toBeLessThan(300);
      track(cascaded, door.name);

      const refused = await door.write("parent-of", readOnlyTarget);
      expect(refusal(refused)).toEqual({
        code: "type_not_permitted",
        grant: bookmarkWrite,
      });
      if (door.name.startsWith("POST /edges")) {
        const written = await client.listItemBackrefs(readOnlyTarget, {
          edge_type: "parent-of",
        });
        expect(written.data.data).toHaveLength(0);
      }
    },
  );

  it("refuses an edge of a registered type that cascades as it refuses parent-of", async () => {
    const id = `mock.cascades-target.${ctx.runId}`;
    await registerCascading(id);
    const refused = await writer.createEdge({
      from_id: source,
      to_id: readOnlyTarget,
      edge_type: id,
    });
    expect(refused.status).toBe(403);
    expect(refusal(refused)).toEqual({
      code: "type_not_permitted",
      grant: bookmarkWrite,
    });
    const writable = await noteBy(writer);
    const accepted = await writer.createEdge({
      from_id: source,
      to_id: writable,
      edge_type: id,
    });
    expect(accepted.status).toBe(201);
    trackEdge(ctx, accepted.data.edge.id);
  });

  it("refuses a move of the from item of an edge to a to item the key may not write, and a move of the to item onto one", async () => {
    // Moving the source of `parent-of` leaves the target in place, and the
    // target is judged again. The admin made the edge: this key could not.
    const writable = await noteBy(writer);
    const held = await client.createEdge({
      from_id: writable,
      to_id: readOnlyTarget,
      edge_type: "parent-of",
    });
    expect(held.status).toBe(201);
    trackEdge(ctx, held.data.edge.id);
    const elsewhere = await noteBy(writer);
    const sourceMove = await writer.updateEdge(held.data.edge.id, {
      version: 1,
      from_id: elsewhere,
    });
    expect(sourceMove.status).toBe(403);
    expect(refusal(sourceMove)).toEqual({
      code: "type_not_permitted",
      grant: bookmarkWrite,
    });
    expect((await client.getEdge(held.data.edge.id)).data.edge.from_id).toBe(
      writable,
    );

    // The same move of an edge whose target the key may write is accepted.
    const okTarget = await noteBy(writer);
    const own = await writer.createEdge({
      from_id: writable,
      to_id: okTarget,
      edge_type: "parent-of",
    });
    expect(own.status).toBe(201);
    trackEdge(ctx, own.data.edge.id);
    const moved = await writer.updateEdge(own.data.edge.id, {
      version: 1,
      from_id: elsewhere,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    // Moving the target of a many-to-one type onto an item the key may not
    // write is refused, and onto one it may write is accepted.
    const id = `mock.cascades-move.${ctx.runId}`;
    await registerCascading(id, { cardinality: "many-to-one" });
    const first = await noteBy(writer);
    const link = await writer.createEdge({
      from_id: writable,
      to_id: first,
      edge_type: id,
    });
    expect(link.status).toBe(201);
    trackEdge(ctx, link.data.edge.id);
    const targetMove = await writer.updateEdge(link.data.edge.id, {
      version: 1,
      to_id: readOnlyTarget,
    });
    expect(targetMove.status).toBe(403);
    expect(refusal(targetMove)).toEqual({
      code: "type_not_permitted",
      grant: bookmarkWrite,
    });
    const second = await noteBy(writer);
    const accepted = await writer.updateEdge(link.data.edge.id, {
      version: 1,
      to_id: second,
    });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
  });

  it("refuses write on a cascading to item's type after it finds the to item of a create and before it checks the endpoint types", async () => {
    const id = `mock.cascades-order.${ctx.runId}`;
    await registerCascading(id, { to_type_constraints: ["core.note"] });
    const create = (target: string) =>
      writer.createEdge({
        from_id: source,
        to_id: target,
        edge_type: id,
      });

    // The witnesses: a missing target is answered first, and a key that may
    // write the bookmark meets the endpoint constraint.
    const missing = await create(generateId());
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("item_not_found");
    const wide = await mintClient("cascade-order-wide", {
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
      edge_permissions: { "*": "write" },
    });
    const widened = await wide.createEdge({
      from_id: await noteBy(wide),
      to_id: readOnlyTarget,
      edge_type: id,
    });
    expect(widened.error?.error.code).toBe("edge_constraint_violation");

    const refused = await create(readOnlyTarget);
    expect(refused.status).toBe(403);
    expect(refusal(refused)).toEqual({
      code: "type_not_permitted",
      grant: bookmarkWrite,
    });
  });

  it("refuses write on a cascading to item's type after it finds the to item of a move and before it checks the endpoint types", async () => {
    const id = `mock.cascades-order-move.${ctx.runId}`;
    await registerCascading(id, {
      cardinality: "many-to-one",
      to_type_constraints: ["core.note"],
    });
    const home = await noteBy(writer);
    const held = await writer.createEdge({
      from_id: source,
      to_id: home,
      edge_type: id,
    });
    expect(held.status).toBe(201);
    trackEdge(ctx, held.data.edge.id);
    const move = (target: string, c: MarfaClient = writer) =>
      c.updateEdge(held.data.edge.id, { version: 1, to_id: target });

    const missing = await move(generateId());
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("item_not_found");
    const wide = await mintClient("cascade-order-move-wide", {
      type_permissions: {
        "core.note": "write",
        "core.bookmark": "write",
      },
      edge_permissions: { "*": "write" },
    });
    const widened = await move(readOnlyTarget, wide);
    expect(widened.error?.error.code).toBe("edge_constraint_violation");

    const refused = await move(readOnlyTarget);
    expect(refused.status).toBe(403);
    expect(refusal(refused)).toEqual({
      code: "type_not_permitted",
      grant: bookmarkWrite,
    });
  });
});

describe("registering an edge type that cascades over stored edges", () => {
  let registrar: MarfaClient;

  async function storedEdge(id: string, target: string): Promise<void> {
    const made = await client.registerEdgeType({
      id,
      label: "Orphaning test edge type",
      cardinality: "many-to-many",
      cascade_on_delete: "orphan",
    });
    expect(made.status).toBe(201);
    const from = await noteBy(client);
    const edge = await client.createEdge({
      from_id: from,
      to_id: target,
      edge_type: id,
    });
    expect(edge.status).toBe(201);
    trackEdge(ctx, edge.data.edge.id);
    const dropped = await client.deleteEdgeType(id, true);
    expect(dropped.status).toBe(200);
  }

  const cascading = (id: string) => ({
    id,
    label: "Cascading test edge type",
    cardinality: "many-to-many" as const,
    cascade_on_delete: "cascade" as const,
  });

  beforeAll(async () => {
    registrar = await mintClient("cascade-registrar", {
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
      edge_permissions: { "mock.*": "write" },
      metadata_permissions: { edge_types: "write" },
    });
  });

  it("refuses a registration over a stored edge to a type the key may not write, without naming the type", async () => {
    const id = `mock.stored-hidden.${ctx.runId}`;
    const target = await bookmark();
    await storedEdge(id, target);

    const refused = await registrar.registerEdgeType(cascading(id));
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    expect(refused.error?.error.details?.grant).toBeUndefined();
    expect(JSON.stringify(refused.error)).not.toContain("core.bookmark");
    expect(JSON.stringify(refused.error)).not.toContain(target);

    // The witness: the type registers for a key that may write the bookmark,
    // and nothing was registered by the refusal.
    expect(
      (await client.listEdgeTypes()).data.data.map((t) => t.id),
    ).not.toContain(id);
    const registered = await client.registerEdgeType(cascading(id));
    expect(registered.status).toBe(201);
    trackEdgeType(ctx, id);
  });

  it("registers a cascading edge type over stored edges whose to items the key may write", async () => {
    const id = `mock.stored-writable.${ctx.runId}`;
    await storedEdge(id, await noteBy(client));
    const registered = await registrar.registerEdgeType(cascading(id));
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    trackEdgeType(ctx, id);
  });

  it("answers an id a registered edge type holds as a conflict before it asks for write on the stored to items", async () => {
    const id = `mock.stored-held.${ctx.runId}`;
    const target = await bookmark();
    const made = await client.registerEdgeType({
      id,
      label: "Orphaning test edge type",
      cardinality: "many-to-many",
      cascade_on_delete: "orphan",
    });
    expect(made.status).toBe(201);
    trackEdgeType(ctx, id);
    const edge = await client.createEdge({
      from_id: await noteBy(client),
      to_id: target,
      edge_type: id,
    });
    expect(edge.status).toBe(201);
    trackEdge(ctx, edge.data.edge.id);

    const held = await registrar.registerEdgeType(cascading(id));
    expect(held.status).toBe(409);
    expect(held.error?.error.code).toBe("conflict");

    // The witness: with the registration gone, the same body is refused for
    // the stored target.
    expect((await client.deleteEdgeType(id, true)).status).toBe(200);
    const refused = await registrar.registerEdgeType(cascading(id));
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
  });
});
