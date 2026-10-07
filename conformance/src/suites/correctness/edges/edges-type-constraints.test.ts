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
import {
  createBookmark,
  createHighlight,
  createNote,
} from "../../../generators/items.js";

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

describe("endpoint constraints on every write path", () => {
  let edgeType: string;

  beforeAll(async () => {
    edgeType = `mock.ep.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
      source_type_constraints: ["core.highlight"],
      target_type_constraints: ["core.note"],
    });
    expect(reg.status).toBe(201);
    trackEdgeType(ctx, edgeType);
  });

  /** What a refused endpoint names: the type, the end's type and the types allowed. */
  const wrongSource = () => ({
    edge_type: edgeType,
    source_type: "core.note",
    allowed: ["core.highlight"],
  });
  const wrongTarget = () => ({
    edge_type: edgeType,
    target_type: "core.bookmark",
    allowed: ["core.note"],
  });

  async function stored(source: string): Promise<string[]> {
    const r = await client.listItemEdges(source, { edge_type: edgeType });
    expect(r.status).toBe(200);
    return r.data.data.map((e) => e.target_id);
  }

  it("refuses an end of the wrong type on POST /edges, naming the type and the types allowed", async () => {
    const highlight = await makeItem(createHighlight({ source: ctx.source }));
    const note = await makeItem(createNote({ source: ctx.source }));
    const bookmark = await makeItem(createBookmark({ source: ctx.source }));
    const otherNote = await makeItem(createNote({ source: ctx.source }));

    const source = await client.createEdge({
      source_id: otherNote,
      target_id: note,
      edge_type: edgeType,
    });
    expect(source.status).toBe(400);
    expect(source.error?.error.code).toBe("edge_constraint_violation");
    expect(source.error?.error.details).toEqual(wrongSource());
    const target = await client.createEdge({
      source_id: highlight,
      target_id: bookmark,
      edge_type: edgeType,
    });
    expect(target.status).toBe(400);
    expect(target.error?.error.code).toBe("edge_constraint_violation");
    expect(target.error?.error.details).toEqual(wrongTarget());
    expect(await stored(highlight)).toEqual([]);

    // The witness: the same source and a target of the allowed type.
    const placed = await client.createEdge({
      source_id: highlight,
      target_id: note,
      edge_type: edgeType,
    });
    expect(placed.status).toBe(201);
    trackEdge(ctx, placed.data.edge.id);
    expect(await stored(highlight)).toEqual([note]);
  });

  it("refuses an end of the wrong type in a POST /edges/bulk entry, on the entry's error or inside the rollback", async () => {
    const highlight = await makeItem(createHighlight({ source: ctx.source }));
    const note = await makeItem(createNote({ source: ctx.source }));
    const bookmark = await makeItem(createBookmark({ source: ctx.source }));
    const otherNote = await makeItem(createNote({ source: ctx.source }));
    const entries = [
      { source_id: highlight, target_id: note, edge_type: edgeType },
      { source_id: otherNote, target_id: note, edge_type: edgeType },
      { source_id: highlight, target_id: bookmark, edge_type: edgeType },
    ];

    const partial = await client.bulkEdges({ atomic: false, edges: entries });
    expect(partial.status).toBe(200);
    expect(partial.data.counts).toMatchObject({ created: 1, errored: 2 });
    const [witness, source, target] = partial.data.results;
    expect(witness?.outcome).toBe("created");
    trackEdge(ctx, witness!.id!);
    expect(source?.outcome).toBe("errored");
    expect(source?.error?.code).toBe("edge_constraint_violation");
    expect(source?.error?.details).toEqual(wrongSource());
    expect(target?.outcome).toBe("errored");
    expect(target?.error?.code).toBe("edge_constraint_violation");
    expect(target?.error?.details).toEqual(wrongTarget());

    const other = await makeItem(createHighlight({ source: ctx.source }));
    const rolled = await client.bulkEdges({
      atomic: true,
      edges: [
        { source_id: other, target_id: note, edge_type: edgeType },
        entries[2]!,
      ],
    });
    expect(rolled.status).toBe(400);
    expect(rolled.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rolled.error?.error.details).toMatchObject({
      index: 1,
      code: "edge_constraint_violation",
      details: wrongTarget(),
    });
    expect(await stored(other)).toEqual([]);
  });

  it("refuses an inline edge whose new item or target is of the wrong type on POST /items", async () => {
    const note = await makeItem(createNote({ source: ctx.source }));
    const bookmark = await makeItem(createBookmark({ source: ctx.source }));

    // The new item is the edge's source.
    const source = await client.createItem(
      createNote({ source: ctx.source, edges: { [edgeType]: [note] } }),
    );
    expect(source.status).toBe(400);
    expect(source.error?.error.code).toBe("edge_constraint_violation");
    expect(source.error?.error.details).toEqual(wrongSource());
    const target = await client.createItem(
      createHighlight({
        source: ctx.source,
        edges: { [edgeType]: [bookmark] },
      }),
    );
    expect(target.status).toBe(400);
    expect(target.error?.error.code).toBe("edge_constraint_violation");
    expect(target.error?.error.details).toEqual(wrongTarget());

    // The witness: a highlight naming a note.
    const placed = await client.createItem(
      createHighlight({ source: ctx.source, edges: { [edgeType]: [note] } }),
    );
    expect(placed.status).toBe(201);
    trackItem(ctx, placed.data.item.id);
    expect(await stored(placed.data.item.id)).toEqual([note]);
  });
});
