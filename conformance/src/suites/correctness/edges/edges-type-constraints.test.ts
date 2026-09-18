import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  cleanup,
} from "../../../utils/setup.js";
import { createNote, createHighlight } from "../../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "edges-type-constraints",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(
  input: Parameters<typeof client.createItem>[0],
): Promise<string> {
  const r = await client.createItem(input);
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("edge type-constraints", () => {
  it("source / target type constraints: matching types accepted", async () => {
    const edgeTypeId = `mock.tc.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: edgeTypeId,
      cardinality: "many-to-many",
      source_type_constraints: ["core.highlight"],
      target_type_constraints: ["core.note"],
      cascade_on_delete: "orphan",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, edgeTypeId);

    const source = await makeItem(createHighlight({ source: ctx.source }));
    const target = await makeItem(createNote({ source: ctx.source }));

    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeTypeId,
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
  });

  it("non-matching source type rejected", async () => {
    const edgeTypeId = `mock.tc2.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: edgeTypeId,
      cardinality: "many-to-many",
      source_type_constraints: ["core.highlight"],
      target_type_constraints: ["core.note"],
      cascade_on_delete: "orphan",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, edgeTypeId);

    const wrongSource = await makeItem(createNote({ source: ctx.source })); // not a highlight
    const target = await makeItem(createNote({ source: ctx.source }));

    const r = await client.createEdge({
      source_id: wrongSource,
      target_id: target,
      edge_type: edgeTypeId,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("edge_constraint_violation");
  });

  it("non-matching target type rejected", async () => {
    const edgeTypeId = `mock.tc3.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: edgeTypeId,
      cardinality: "many-to-many",
      source_type_constraints: ["core.note"],
      target_type_constraints: ["core.media.article"],
      cascade_on_delete: "orphan",
    });
    expect(reg.ok).toBe(true);
    trackEdgeType(ctx, edgeTypeId);

    const source = await makeItem(createNote({ source: ctx.source }));
    const wrongTarget = await makeItem(createNote({ source: ctx.source }));

    const r = await client.createEdge({
      source_id: source,
      target_id: wrongTarget,
      edge_type: edgeTypeId,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.error.code).toBe("edge_constraint_violation");
  });

  // Type-constraint matching walks the `parent` chain, so a type that extends
  // a constraint entry satisfies it.
  it("inheritance-aware: constraint accepts inheriting child type", async () => {
    // Item type IDs follow the five-tier namespace grammar — only
    // `core.<type>`, `system.<type>`, `app.<app>.<type>`, `user.<type>`
    // or `<publisher>.<type>` are accepted, and `user.<...>` is the root for
    // an ad-hoc test type. Edge type IDs follow a separate grammar that
    // accepts `<ns>.<segment>.<segment>`.
    const childTypeId = `user.inh-hl-r${ctx.runId}`;
    const edgeTypeId = `mock.tcinh.${ctx.runId}`;

    const typeReg = await client.registerType({
      id: childTypeId,
      parent: "core.highlight",
      fields: { tagline: { type: "string" } },
    });
    expect(typeReg.ok).toBe(true);

    const edgeReg = await client.registerEdgeType({
      id: edgeTypeId,
      cardinality: "many-to-many",
      source_type_constraints: ["core.highlight"],
      target_type_constraints: ["core.note"],
      cascade_on_delete: "orphan",
    });
    expect(edgeReg.ok).toBe(true);
    trackEdgeType(ctx, edgeTypeId);

    const source = await makeItem({
      type: childTypeId,
      properties: { text: "highlighted passage", tagline: "inh" },
    });
    const target = await makeItem(createNote({ source: ctx.source }));

    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeTypeId,
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);
  });
});
