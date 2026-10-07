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
import { createNote, generateId } from "../../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "edges-cardinality",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(body: string = "card-test"): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function makeEdge(
  source_id: string,
  target_id: string,
  edge_type: string,
): Promise<{ ok: boolean; id?: string; code?: string; status: number }> {
  const r = await client.createEdge({ source_id, target_id, edge_type });
  if (r.ok) {
    trackEdge(ctx, r.data.edge.id);
    return { ok: true, id: r.data.edge.id, status: r.status };
  }
  return {
    ok: false,
    code: r.error?.error.code,
    status: r.status,
  };
}

describe("edge cardinality enforcement", () => {
  it("parent-of is one-parent-per-child: second parent rejected", async () => {
    const parent1 = await makeItem("parent1");
    const parent2 = await makeItem("parent2");
    const child = await makeItem("child");

    const first = await makeEdge(parent1, child, "parent-of");
    expect(first.ok).toBe(true);

    const second = await makeEdge(parent2, child, "parent-of");
    expect(second.ok).toBe(false);
    expect(second.status).toBe(400);
    expect(second.code).toBe("edge_constraint_violation");
  });

  it("in-thread is many-to-one: source can only join one thread", async () => {
    const thread1 = await makeItem("thread1");
    const thread2 = await makeItem("thread2");
    const member = await makeItem("member");

    const first = await makeEdge(member, thread1, "in-thread");
    expect(first.ok).toBe(true);

    const second = await makeEdge(member, thread2, "in-thread");
    expect(second.ok).toBe(false);
    expect(second.code).toBe("edge_constraint_violation");
  });

  it("supersedes is one-to-one: rejects second outbound from same source", async () => {
    const head = await makeItem("head");
    const t1 = await makeItem("t1");
    const t2 = await makeItem("t2");

    const first = await makeEdge(head, t1, "supersedes");
    expect(first.ok).toBe(true);

    const second = await makeEdge(head, t2, "supersedes");
    expect(second.ok).toBe(false);
    expect(second.code).toBe("edge_constraint_violation");
  });

  it("supersedes is one-to-one: rejects second inbound to same target", async () => {
    const target = await makeItem("target");
    const successorA = await makeItem("succA");
    const successorB = await makeItem("succB");

    const first = await makeEdge(successorA, target, "supersedes");
    expect(first.ok).toBe(true);

    const second = await makeEdge(successorB, target, "supersedes");
    expect(second.ok).toBe(false);
    expect(second.code).toBe("edge_constraint_violation");
  });

  it("many-to-many edge types accept multiple edges", async () => {
    const source = await makeItem("mm-source");

    for (const edgeType of [
      "about",
      "authored-by",
      "derived-from",
      "attached-to",
      "references",
    ]) {
      const t1 = await makeItem(`t1-${edgeType}`);
      const t2 = await makeItem(`t2-${edgeType}`);
      const t3 = await makeItem(`t3-${edgeType}`);

      for (const target of [t1, t2, t3]) {
        const r = await makeEdge(source, target, edgeType);
        expect(r.ok).toBe(true);
      }
    }
  });

  it("parent-of deep nesting respects the one-parent-per-child rule at depth", async () => {
    // A → B → C → D is legal (each child has exactly one parent).
    const a = await makeItem("depth-A");
    const b = await makeItem("depth-B");
    const c = await makeItem("depth-C");
    const d = await makeItem("depth-D");

    expect((await makeEdge(a, b, "parent-of")).ok).toBe(true);
    expect((await makeEdge(b, c, "parent-of")).ok).toBe(true);
    expect((await makeEdge(c, d, "parent-of")).ok).toBe(true);

    // D already has C as its parent, so a second parent-of into D is refused
    // at depth exactly as it is at the root.
    const dup = await makeEdge(a, d, "parent-of");
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe("edge_constraint_violation");
  });
});

describe("cardinality on every write path", () => {
  let registered = 0;
  type Cardinality = "one-to-one" | "one-to-many" | "many-to-many";

  async function register(cardinality: Cardinality): Promise<string> {
    const id = `mock.card.${cardinality}.${ctx.runId}${String(++registered)}`;
    const r = await client.registerEdgeType({ id, cardinality });
    expect(r.status).toBe(201);
    trackEdgeType(ctx, id);
    return id;
  }

  async function place(
    source: string,
    target: string,
    edgeType: string,
  ): Promise<string> {
    const r = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
    });
    expect(r.status).toBe(201);
    trackEdge(ctx, r.data.edge.id);
    return r.data.edge.id;
  }

  /** What a refused cardinality names: the type, the end that is full and the constraint. */
  function full(
    edgeType: string,
    end: "source_id" | "target_id",
    id: string,
  ): Record<string, string> {
    return { edge_type: edgeType, [end]: id, constraint: "cardinality" };
  }

  async function targetsOf(
    source: string,
    edgeType: string,
  ): Promise<string[]> {
    const r = await client.listItemEdges(source, { edge_type: edgeType });
    expect(r.status).toBe(200);
    return r.data.data.map((e) => e.target_id).sort();
  }

  it("refuses a second edge at a one-to-one or one-to-many end on POST /edges, and a many-to-many type takes it", async () => {
    const oneToOne = await register("one-to-one");
    const oneToMany = await register("one-to-many");
    const manyToMany = await register("many-to-many");
    const a = await makeItem("pc-a");
    const b = await makeItem("pc-b");
    const c = await makeItem("pc-c");
    const d = await makeItem("pc-d");

    await place(a, b, oneToOne);
    const outbound = await client.createEdge({
      source_id: a,
      target_id: c,
      edge_type: oneToOne,
    });
    expect(outbound.status).toBe(400);
    expect(outbound.error?.error.code).toBe("edge_constraint_violation");
    expect(outbound.error?.error.details).toEqual(
      full(oneToOne, "source_id", a),
    );
    const inbound = await client.createEdge({
      source_id: d,
      target_id: b,
      edge_type: oneToOne,
    });
    expect(inbound.status).toBe(400);
    expect(inbound.error?.error.code).toBe("edge_constraint_violation");
    expect(inbound.error?.error.details).toEqual(
      full(oneToOne, "target_id", b),
    );

    await place(a, b, oneToMany);
    const second = await client.createEdge({
      source_id: d,
      target_id: b,
      edge_type: oneToMany,
    });
    expect(second.status).toBe(400);
    expect(second.error?.error.code).toBe("edge_constraint_violation");
    expect(second.error?.error.details).toEqual(
      full(oneToMany, "target_id", b),
    );

    expect(await targetsOf(a, oneToOne)).toEqual([b]);
    expect(await targetsOf(a, oneToMany)).toEqual([b]);
    expect(await targetsOf(d, oneToOne)).toEqual([]);
    expect(await targetsOf(d, oneToMany)).toEqual([]);

    // The witnesses: the one-to-many source end is free, and a many-to-many
    // type takes a second edge at either end.
    await place(a, c, oneToMany);
    await place(a, b, manyToMany);
    await place(a, c, manyToMany);
    await place(d, b, manyToMany);
  });

  it("refuses to move an end of a one-to-one edge onto one that already holds an edge of the type on PATCH /edges/{id}", async () => {
    const edgeType = await register("one-to-one");
    const a = await makeItem("mv-a");
    const b = await makeItem("mv-b");
    const c = await makeItem("mv-c");
    const d = await makeItem("mv-d");
    const e = await makeItem("mv-e");
    const moving = await client.createEdge({
      source_id: a,
      target_id: b,
      edge_type: edgeType,
    });
    expect(moving.status).toBe(201);
    trackEdge(ctx, moving.data.edge.id);
    await place(c, d, edgeType);
    const { id, version } = moving.data.edge;

    const toHeldSource = await client.updateEdge(id, { version, source_id: c });
    expect(toHeldSource.status).toBe(400);
    expect(toHeldSource.error?.error.code).toBe("edge_constraint_violation");
    expect(toHeldSource.error?.error.details).toEqual(
      full(edgeType, "source_id", c),
    );
    const toHeldTarget = await client.updateEdge(id, { version, target_id: d });
    expect(toHeldTarget.status).toBe(400);
    expect(toHeldTarget.error?.error.code).toBe("edge_constraint_violation");
    expect(toHeldTarget.error?.error.details).toEqual(
      full(edgeType, "target_id", d),
    );
    const stored = await client.getEdge(id);
    expect(stored.data.edge).toMatchObject({
      source_id: a,
      target_id: b,
      version,
    });

    // The witness: the same edge moves onto an end that holds none.
    const moved = await client.updateEdge(id, { version, target_id: e });
    expect(moved.status).toBe(200);
    expect(moved.data.edge).toMatchObject({ source_id: a, target_id: e });
  });

  it("refuses a second edge at a held end in a POST /edges/bulk entry, as an errored entry or a rollback", async () => {
    const oneToOne = await register("one-to-one");
    const oneToMany = await register("one-to-many");
    const manyToMany = await register("many-to-many");
    const a = await makeItem("bk-a");
    const b = await makeItem("bk-b");
    const c = await makeItem("bk-c");
    const d = await makeItem("bk-d");
    const e = await makeItem("bk-e");
    await place(a, b, oneToOne);
    await place(a, b, oneToMany);

    const page = (atomic: boolean) =>
      client.bulkEdges({
        atomic,
        edges: [
          { source_id: c, target_id: d, edge_type: manyToMany },
          { source_id: a, target_id: c, edge_type: oneToOne },
          { source_id: e, target_id: b, edge_type: oneToOne },
          { source_id: e, target_id: b, edge_type: oneToMany },
        ],
      });

    const rolled = await page(true);
    expect(rolled.status).toBe(400);
    expect(rolled.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rolled.error?.error.details).toMatchObject({
      index: 1,
      code: "edge_constraint_violation",
    });
    expect(rolled.error?.error.details?.details).toEqual(
      full(oneToOne, "source_id", a),
    );
    // The entry ahead of the refused one is rolled back with it.
    expect(await targetsOf(c, manyToMany)).toEqual([]);

    const partial = await page(false);
    expect(partial.status).toBe(200);
    expect(partial.data.counts).toMatchObject({ created: 1, errored: 3 });
    const [witness, outbound, inbound, many] = partial.data.results;
    expect(witness?.outcome).toBe("created");
    trackEdge(ctx, witness!.id!);
    for (const [entry, edgeType, end, id] of [
      [outbound, oneToOne, "source_id", a],
      [inbound, oneToOne, "target_id", b],
      [many, oneToMany, "target_id", b],
    ] as const) {
      expect(entry?.outcome, edgeType).toBe("errored");
      expect(entry?.error?.code, edgeType).toBe("edge_constraint_violation");
      expect(entry?.error?.details, edgeType).toEqual(full(edgeType, end, id));
    }
    expect(await targetsOf(c, manyToMany)).toEqual([d]);

    // A held end inside one page: the second entry meets the first.
    const f = await makeItem("bk-f");
    const g = await makeItem("bk-g");
    const inPage = await client.bulkEdges({
      atomic: false,
      edges: [
        { source_id: f, target_id: g, edge_type: oneToMany },
        { source_id: e, target_id: g, edge_type: oneToMany },
      ],
    });
    expect(inPage.status).toBe(200);
    expect(inPage.data.results[0]?.outcome).toBe("created");
    trackEdge(ctx, inPage.data.results[0]!.id!);
    expect(inPage.data.results[1]?.outcome).toBe("errored");
    expect(inPage.data.results[1]?.error?.details).toEqual(
      full(oneToMany, "target_id", g),
    );
  });

  it("refuses an inline edge to an end a one-to-one or one-to-many type holds, and one set naming two ends of a one-to-one type, on POST /items", async () => {
    const oneToOne = await register("one-to-one");
    const oneToMany = await register("one-to-many");
    const manyToMany = await register("many-to-many");
    const holder = await makeItem("il-holder");
    const held = await makeItem("il-held");
    const other = await makeItem("il-other");
    await place(holder, held, oneToOne);
    await place(holder, held, oneToMany);

    const create = (edges: Record<string, string[]>, id?: string) =>
      client.createItem(
        createNote({ source: ctx.source, edges, ...(id && { id }) }),
      );

    const inbound = await create({ [oneToOne]: [held] });
    expect(inbound.status).toBe(400);
    expect(inbound.error?.error.code).toBe("edge_constraint_violation");
    expect(inbound.error?.error.details).toEqual(
      full(oneToOne, "target_id", held),
    );
    const many = await create({ [oneToMany]: [held] });
    expect(many.status).toBe(400);
    expect(many.error?.error.code).toBe("edge_constraint_violation");
    expect(many.error?.error.details).toEqual(
      full(oneToMany, "target_id", held),
    );
    // The new item is the source, and one set names it twice.
    const minted = generateId();
    const outbound = await create({ [oneToOne]: [other, held] }, minted);
    expect(outbound.status).toBe(400);
    expect(outbound.error?.error.code).toBe("edge_constraint_violation");
    expect(outbound.error?.error.details).toEqual(
      full(oneToOne, "source_id", minted),
    );
    expect((await client.getItem(minted)).status).toBe(404);

    // The witnesses: a many-to-many type takes both targets inline, and a
    // one-to-one type takes one that is free.
    const landed = await create({
      [manyToMany]: [held, other],
      [oneToOne]: [other],
    });
    expect(landed.status).toBe(201);
    trackItem(ctx, landed.data.item.id);
    expect(await targetsOf(landed.data.item.id, manyToMany)).toEqual(
      [held, other].sort(),
    );
    expect(await targetsOf(landed.data.item.id, oneToOne)).toEqual([other]);
  });
});
