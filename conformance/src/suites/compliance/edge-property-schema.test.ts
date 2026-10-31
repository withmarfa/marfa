/**
 * Conformance for an edge type's `property_schema`: every door that writes an
 * edge holds the properties the edge would stand with to it.
 *
 * The edge type under test declares one property of each kind a write can
 * break: `label` is required, `weight` has a type and `status` has an enum.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "edge-property-schema",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const SCHEMA = {
  label: { type: "string", required: true },
  weight: { type: "number" },
  status: { type: "enum", enum_values: ["open", "done"] },
};

let counter = 0;

async function register(
  property_schema: Record<string, unknown> = SCHEMA,
  cardinality: "many-to-many" | "many-to-one" = "many-to-many",
): Promise<string> {
  const id = `mock.propschema${String(counter++)}.${ctx.runId}`;
  const r = await client.registerEdgeType({
    label: "Test edge type",
    id,
    cardinality,
    property_schema,
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdgeType(ctx, id);
  return id;
}

async function note(): Promise<string> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

/** The properties a refusal names, from `details.errors`. */
function named(error: { details?: unknown } | undefined): string[] {
  const details = error?.details as
    { errors?: { field: string }[] } | undefined;
  return (details?.errors ?? []).map((e) => e.field).sort();
}

/** The three ways a write breaks the schema, each naming one property. */
const BROKEN: [string, Record<string, unknown>, string][] = [
  ["a value of the wrong type", { label: "a", weight: "heavy" }, "weight"],
  ["a value outside the enum", { label: "a", status: "stuck" }, "status"],
  ["a missing required property", { weight: 1 }, "label"],
];

describe("POST /edges", () => {
  it("refuses a wrong-typed value, a value outside an enum and a missing required property with 400 invalid_properties naming the property", async () => {
    const edgeType = await register();
    const source = await note();
    const target = await note();
    for (const [what, properties, property] of BROKEN) {
      const r = await client.createEdge({
        source_id: source,
        target_id: target,
        edge_type: edgeType,
        properties,
      });
      expect(r.status, what).toBe(400);
      expect(r.error?.error.code, what).toBe("invalid_properties");
      expect(named(r.error?.error), what).toEqual([property]);
    }
    const none = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
    });
    expect(none.status, "an edge that names no properties").toBe(400);
    expect(named(none.error?.error)).toEqual(["label"]);
    const held = await client.listItemEdges(source, { edge_type: edgeType });
    expect(held.data.data, "a refused write stores nothing").toEqual([]);

    // The witness: the same edge with properties that fit is created.
    const ok = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: { label: "a", weight: 2.5, status: "open" },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
    trackEdge(ctx, ok.data.edge.id);
  });

  it("holds an array property's elements to its items_type on a create and an update", async () => {
    const edgeType = await register({
      roles: { type: "array", items_type: "string" },
    });
    const source = await note();
    const target = await note();
    const refused = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: { roles: ["a", 1] },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(named(refused.error?.error)).toEqual(["roles.1"]);

    // The witness: the same edge with strings, an empty list and no list.
    for (const roles of [["a", "b"], [], undefined]) {
      const ok = await client.createEdge({
        source_id: source,
        target_id: await note(),
        edge_type: edgeType,
        ...(roles === undefined ? {} : { properties: { roles } }),
      });
      expect(ok.status, JSON.stringify(ok.error)).toBe(201);
      trackEdge(ctx, ok.data.edge.id);
    }

    const made = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: { roles: ["a"] },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackEdge(ctx, made.data.edge.id);
    const patched = await client.updateEdge(made.data.edge.id, {
      version: made.data.edge.version,
      properties: { roles: [{}] },
    });
    expect(patched.status).toBe(400);
    expect(patched.error?.error.code).toBe("invalid_properties");
    expect(named(patched.error?.error)).toEqual(["roles.0"]);
  });

  it("accepts a property the schema does not declare and stores it", async () => {
    const edgeType = await register();
    const r = await client.createEdge({
      source_id: await note(),
      target_id: await note(),
      edge_type: edgeType,
      properties: { label: "a", undeclared: { nested: [1] } },
    });
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackEdge(ctx, r.data.edge.id);
    expect(r.data.edge.properties).toEqual({
      label: "a",
      undeclared: { nested: [1] },
    });
  });

  it("takes any properties on an edge type whose property_schema is empty", async () => {
    const edgeType = await register({});
    const r = await client.createEdge({
      source_id: await note(),
      target_id: await note(),
      edge_type: edgeType,
      properties: { weight: "heavy", anything: null },
    });
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackEdge(ctx, r.data.edge.id);
  });
});

describe("PATCH /edges/{id}", () => {
  async function held(
    edgeType: string,
  ): Promise<{ id: string; version: number }> {
    const r = await client.createEdge({
      source_id: await note(),
      target_id: await note(),
      edge_type: edgeType,
      properties: { label: "kept", weight: 1 },
    });
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackEdge(ctx, r.data.edge.id);
    return { id: r.data.edge.id, version: r.data.edge.version };
  }

  it("refuses a patch that sets a value of the wrong type with 400 invalid_properties naming the property, and changes nothing", async () => {
    const edgeType = await register();
    const { id, version } = await held(edgeType);
    const r = await client.updateEdge(id, {
      version,
      properties: { weight: "heavy" },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(named(r.error?.error)).toEqual(["weight"]);
    const after = await client.getEdge(id);
    expect(after.data.edge.version).toBe(version);
    expect(after.data.edge.properties).toEqual({ label: "kept", weight: 1 });

    // The witness: a fitting patch is applied and the other properties stand.
    const ok = await client.updateEdge(id, {
      version,
      properties: { weight: 2, undeclared: true },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(ok.data.edge.properties).toEqual({
      label: "kept",
      weight: 2,
      undeclared: true,
    });
  });

  it("refuses a patch that sets a value outside an enum with 400 invalid_properties naming the property, and changes nothing", async () => {
    const edgeType = await register();
    const { id, version } = await held(edgeType);
    const r = await client.updateEdge(id, {
      version,
      properties: { status: "stuck" },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(named(r.error?.error)).toEqual(["status"]);
    const after = await client.getEdge(id);
    expect(after.data.edge.version).toBe(version);
    expect(after.data.edge.properties).toEqual({ label: "kept", weight: 1 });

    const ok = await client.updateEdge(id, {
      version,
      properties: { status: "done" },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(ok.data.edge.properties).toMatchObject({ status: "done" });
  });

  it("refuses a patch that leaves a required property missing, judged on the merged result", async () => {
    const edgeType = await register();
    const { id, version } = await held(edgeType);
    const r = await client.updateEdge(id, {
      version,
      properties: { label: null },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(named(r.error?.error)).toEqual(["label"]);
    expect((await client.getEdge(id)).data.edge.properties).toEqual({
      label: "kept",
      weight: 1,
    });

    // A patch that names another property leaves the required one standing.
    const ok = await client.updateEdge(id, {
      version,
      properties: { weight: 2 },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
  });

  it("holds a move of an end to the same schema, judged on the merged properties", async () => {
    const edgeType = await register(SCHEMA, "many-to-one");
    const { id, version } = await held(edgeType);
    const moved = await client.updateEdge(id, {
      version,
      target_id: await note(),
      properties: { weight: "heavy" },
    });
    expect(moved.status).toBe(400);
    expect(moved.error?.error.code).toBe("invalid_properties");
    expect(named(moved.error?.error)).toEqual(["weight"]);
  });

  it("leaves an edge stored before its type declared a schema as it is until the edge is next written", async () => {
    // Registered without a schema, force deleted, and registered again with
    // one: the edge stays, holding properties the new schema refuses.
    const id = `mock.propschema.late.${ctx.runId}`;
    const first = await client.registerEdgeType({
      label: "Test edge type",
      id,
      cardinality: "many-to-many",
    });
    expect(first.status).toBe(201);
    trackEdgeType(ctx, id);
    const made = await client.createEdge({
      source_id: await note(),
      target_id: await note(),
      edge_type: id,
      properties: { weight: "heavy" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackEdge(ctx, made.data.edge.id);
    const edge = made.data.edge;
    expect((await client.deleteEdgeType(id, true)).status).toBe(200);
    const second = await client.registerEdgeType({
      label: "Test edge type",
      id,
      cardinality: "many-to-many",
      property_schema: SCHEMA,
    });
    expect(second.status, JSON.stringify(second.error)).toBe(201);

    // Registration judged nothing, and reads answer the edge as stored.
    const read = await client.getEdge(edge.id);
    expect(read.status).toBe(200);
    expect(read.data.edge).toEqual(edge);

    // The next write meets the schema, and the edge it leaves must fit.
    const refused = await client.updateEdge(edge.id, {
      version: edge.version,
      properties: { status: "open" },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(named(refused.error?.error)).toEqual(["label", "weight"]);
    expect((await client.getEdge(edge.id)).data.edge).toEqual(edge);

    const mended = await client.updateEdge(edge.id, {
      version: edge.version,
      properties: { label: "now", weight: 3 },
    });
    expect(mended.status, JSON.stringify(mended.error)).toBe(200);
  });
});

describe("POST /edges/bulk", () => {
  it("refuses each broken entry, created or merged, as an errored entry naming the property, and writes the others", async () => {
    const edgeType = await register();
    const source = await note();
    const target = await note();
    const fresh = await note();
    const placed = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: { label: "kept" },
    });
    expect(placed.status).toBe(201);
    trackEdge(ctx, placed.data.edge.id);

    const entry = (src: string, properties?: Record<string, unknown>) => ({
      source_id: src,
      target_id: target,
      edge_type: edgeType,
      ...(properties !== undefined && { properties }),
    });
    const r = await client.bulkEdges({
      atomic: false,
      edges: [
        // New triples: a wrong type, an enum miss, a missing required property.
        entry(fresh, { label: "a", weight: "heavy" }),
        entry(fresh, { label: "a", status: "stuck" }),
        entry(fresh, { weight: 1 }),
        entry(fresh),
        // The held triple, merged: a wrong type, an enum miss, a null that
        // leaves the required property missing.
        entry(source, { weight: "heavy" }),
        entry(source, { status: "stuck" }),
        entry(source, { label: null }),
        // And one that fits.
        entry(fresh, { label: "fits", extra: 1 }),
      ],
    });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(r.data.counts).toMatchObject({ created: 1, errored: 7 });
    const expected = [
      "weight",
      "status",
      "label",
      "label",
      "weight",
      "status",
      "label",
    ];
    for (const [i, property] of expected.entries()) {
      const result = r.data.results[i];
      expect(result?.outcome, String(i)).toBe("errored");
      expect(result?.error?.code, String(i)).toBe("invalid_properties");
      expect(named(result?.error), String(i)).toEqual([property]);
    }
    expect(r.data.results[7]?.outcome).toBe("created");
    const id = r.data.results[7]?.id;
    if (id !== undefined) trackEdge(ctx, id);
    expect((await client.getEdge(placed.data.edge.id)).data.edge).toEqual(
      placed.data.edge,
    );
  });

  it("rolls the batch back under atomic, with the refusal's code and position", async () => {
    const edgeType = await register();
    const source = await note();
    const target = await note();
    const r = await client.bulkEdges({
      atomic: true,
      edges: [
        {
          source_id: source,
          target_id: target,
          edge_type: edgeType,
          properties: { label: "fits" },
        },
        {
          source_id: target,
          target_id: source,
          edge_type: edgeType,
          properties: { label: "a", weight: "heavy" },
        },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("bulk_atomic_rollback");
    expect(r.error?.error.details).toMatchObject({
      index: 1,
      code: "invalid_properties",
    });
    const written = await client.listItemEdges(source, { edge_type: edgeType });
    expect(written.data.data).toEqual([]);
  });
});

describe("edges written inline with an item", () => {
  it("refuses an item write whose inline edge lacks a required property, and writes nothing of it", async () => {
    // An inline edge carries no properties, so only what the schema requires
    // can break.
    const edgeType = await register();
    const target = await note();

    const sourceId = `inline-${ctx.runId}`;
    const created = await client.rawRequest("/items", {
      method: "POST",
      body: {
        type: "core.note",
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "inline" },
        edges: { [edgeType]: [target] },
      },
    });
    expect(created.status).toBe(400);
    expect(created.error?.error.code).toBe("invalid_properties");
    expect(named(created.error?.error)).toEqual(["label"]);
    const listed = await client.listItems({ source: ctx.source, limit: 200 });
    expect(
      listed.data.data.map((item) => item.source_id),
      "the item was not written",
    ).not.toContain(sourceId);

    const existing = await client.createItem(
      createNote({ source: ctx.source }),
    );
    expect(existing.status).toBe(201);
    trackItem(ctx, existing.data.item.id);
    const patched = await client.rawRequest(`/items/${existing.data.item.id}`, {
      method: "PATCH",
      body: {
        version: existing.data.item.version,
        edges: { [edgeType]: [target] },
      },
    });
    expect(patched.status).toBe(400);
    expect(patched.error?.error.code).toBe("invalid_properties");
    expect(named(patched.error?.error)).toEqual(["label"]);
    const unchanged = await client.getItem(existing.data.item.id);
    expect(unchanged.data.item.version).toBe(existing.data.item.version);

    const bulk = await client.bulkItems({
      atomic: false,
      items: [
        {
          type: "core.note",
          source: ctx.source,
          properties: { body: "bulk inline" },
          edges: { [edgeType]: [target] },
        },
      ],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
    expect(named(bulk.data.results[0]?.error)).toEqual(["label"]);
  });

  it("takes an inline edge of an edge type that requires nothing", async () => {
    const edgeType = await register({
      weight: { type: "number" },
      status: { type: "enum", enum_values: ["open", "done"] },
    });
    const target = await note();
    const r = await client.rawRequest<{ item: { id: string } }>("/items", {
      method: "POST",
      body: {
        type: "core.note",
        source: ctx.source,
        properties: { body: "inline" },
        edges: { [edgeType]: [target] },
      },
    });
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackItem(ctx, r.data.item.id);
    const edges = await client.listItemEdges(r.data.item.id, {
      edge_type: edgeType,
    });
    expect(edges.data.data.map((e) => e.target_id)).toEqual([target]);
    expect(edges.data.data[0]?.properties).toEqual({});
  });
});

describe("the shipped edge types", () => {
  it("holds a shipped edge type to its property_schema", async () => {
    const source = await note();
    const target = await note();
    const refused = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "in-thread",
      properties: { position: "first" },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(named(refused.error?.error)).toEqual(["position"]);

    const ok = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "in-thread",
      properties: { position: 1 },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
    trackEdge(ctx, ok.data.edge.id);
  });
});

describe("null and format", () => {
  it("keeps a null on an optional declared property as sent and refuses one on a required property", async () => {
    const edgeType = await register();
    const source = await note();
    const made = await client.createEdge({
      source_id: source,
      target_id: await note(),
      edge_type: edgeType,
      properties: { label: "a", weight: null },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackEdge(ctx, made.data.edge.id);
    expect(made.data.edge.properties).toEqual({ label: "a", weight: null });

    const patched = await client.updateEdge(made.data.edge.id, {
      version: made.data.edge.version,
      properties: { status: null },
    });
    expect(patched.status, JSON.stringify(patched.error)).toBe(200);
    expect(patched.data.edge.properties).toEqual({
      label: "a",
      weight: null,
      status: null,
    });

    const refused = await client.createEdge({
      source_id: source,
      target_id: await note(),
      edge_type: edgeType,
      properties: { label: null },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(named(refused.error?.error)).toEqual(["label"]);
  });

  const FORMATS: [string, string, string][] = [
    ["email", "not an address", "a@example.com"],
    ["url", "not a url", "https://example.com/a"],
    ["date", "2026-02-30", "2026-02-28"],
    ["datetime", "2026-02-28 10:00", "2026-02-28T10:00:00Z"],
  ];

  it("registers a string property with a format as the type of that format, and judges its values on every edge write", async () => {
    const property_schema = Object.fromEntries(
      FORMATS.map(([format]) => [format, { type: "string", format }]),
    );
    const edgeType = await register(property_schema);
    const listed = await client.listEdgeTypes();
    const registered = listed.data.data.find((t) => t.id === edgeType);
    expect(registered?.property_schema).toEqual(
      Object.fromEntries(FORMATS.map(([format]) => [format, { type: format }])),
    );

    const source = await note();
    const target = await note();
    for (const [format, bad] of FORMATS) {
      const refused = await client.createEdge({
        source_id: source,
        target_id: target,
        edge_type: edgeType,
        properties: { [format]: bad },
      });
      expect(refused.status, format).toBe(400);
      expect(refused.error?.error.code, format).toBe("invalid_properties");
      expect(named(refused.error?.error), format).toEqual([format]);
    }
    const ok = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: Object.fromEntries(FORMATS.map(([f, , good]) => [f, good])),
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
    trackEdge(ctx, ok.data.edge.id);

    const patched = await client.updateEdge(ok.data.edge.id, {
      version: ok.data.edge.version,
      properties: { email: "not an address" },
    });
    expect(patched.status).toBe(400);
    expect(named(patched.error?.error)).toEqual(["email"]);
    const bulk = await client.bulkEdges({
      atomic: false,
      edges: [
        {
          source_id: source,
          target_id: await note(),
          edge_type: edgeType,
          properties: { url: "not a url" },
        },
      ],
    });
    expect(bulk.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
  });

  it("keeps a currency property a string with its format, and judges its values on every edge write", async () => {
    const edgeType = await register({
      code: { type: "string", format: "currency" },
    });
    const listed = await client.listEdgeTypes();
    expect(
      listed.data.data.find((t) => t.id === edgeType)?.property_schema,
    ).toEqual({ code: { type: "string", format: "currency" } });

    const source = await note();
    const target = await note();
    const refused = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: { code: "gbp" },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(named(refused.error?.error)).toEqual(["code"]);

    const ok = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
      properties: { code: "GBP" },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
    trackEdge(ctx, ok.data.edge.id);

    const patched = await client.updateEdge(ok.data.edge.id, {
      version: ok.data.edge.version,
      properties: { code: "gbp" },
    });
    expect(patched.status).toBe(400);
    expect(named(patched.error?.error)).toEqual(["code"]);
    const bulk = await client.bulkEdges({
      atomic: false,
      edges: [
        {
          source_id: source,
          target_id: await note(),
          edge_type: edgeType,
          properties: { code: "gbp" },
        },
      ],
    });
    expect(bulk.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
  });

  it("refuses a registration that puts a format on a property it does not suit, naming the property", async () => {
    const r = await client.registerEdgeType({
      label: "Test edge type",
      id: `mock.propschema.badformat.${ctx.runId}`,
      cardinality: "many-to-many",
      property_schema: { size: { type: "number", format: "email" } },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_schema");
    const paths = (
      r.error?.error.details as { errors?: { field: string }[] } | undefined
    )?.errors?.map((e) => e.field);
    expect(paths).toEqual(["property_schema.size.format"]);
  });
});
