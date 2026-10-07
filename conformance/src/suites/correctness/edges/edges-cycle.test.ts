import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../../utils/setup.js";
import { createNote } from "../../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "edges-cycle"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `cycle-${label}` } }),
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
  return { ok: false, code: r.error?.error.code, status: r.status };
}

describe("edge cycle rejection", () => {
  it("supersedes direct cycle: A→B then B→A rejected", async () => {
    const a = await makeItem("A");
    const b = await makeItem("B");

    expect((await makeEdge(a, b, "supersedes")).ok).toBe(true);

    const cycle = await makeEdge(b, a, "supersedes");
    expect(cycle.ok).toBe(false);
    expect(cycle.status).toBe(400);
    expect(cycle.code).toBe("edge_cycle");
  });

  it("supersedes deep cycle: A→B→C then C→A rejected", async () => {
    const a = await makeItem("dA");
    const b = await makeItem("dB");
    const c = await makeItem("dC");

    expect((await makeEdge(a, b, "supersedes")).ok).toBe(true);
    expect((await makeEdge(b, c, "supersedes")).ok).toBe(true);

    const cycle = await makeEdge(c, a, "supersedes");
    expect(cycle.ok).toBe(false);
    expect(cycle.status).toBe(400);
    expect(cycle.code).toBe("edge_cycle");
  });

  it("parent-of direct cycle: A→B then B→A rejected", async () => {
    const a = await makeItem("pA");
    const b = await makeItem("pB");

    expect((await makeEdge(a, b, "parent-of")).ok).toBe(true);

    const cycle = await makeEdge(b, a, "parent-of");
    expect(cycle.ok).toBe(false);
    expect(cycle.status).toBe(400);
    expect(cycle.code).toBe("edge_cycle");
  });

  it("parent-of deep cycle: A→B→C then C→A rejected", async () => {
    const a = await makeItem("pdA");
    const b = await makeItem("pdB");
    const c = await makeItem("pdC");

    expect((await makeEdge(a, b, "parent-of")).ok).toBe(true);
    expect((await makeEdge(b, c, "parent-of")).ok).toBe(true);

    const cycle = await makeEdge(c, a, "parent-of");
    expect(cycle.ok).toBe(false);
    expect(cycle.status).toBe(400);
    expect(cycle.code).toBe("edge_cycle");
  });

  it("self-loop rejected: A→A on parent-of", async () => {
    const a = await makeItem("self");
    const self = await makeEdge(a, a, "parent-of");
    expect(self.ok).toBe(false);
    expect(self.status).toBe(400);
    expect(self.code).toBe("edge_cycle");
  });

  it("self-loop rejected: A→A on about", async () => {
    // The case above cannot carry the rule on its own. `parent-of` is one of
    // the two types the cycle walk covers, and that walk reaches A→A before
    // any self-loop rule does — so it answers `edge_cycle` whether or not the
    // server still refuses a self-loop as such. `about` is walked by nothing,
    // which is what makes this the fixture the rule is actually held to.
    const a = await makeItem("self-about");
    const self = await makeEdge(a, a, "about");
    expect(self.ok).toBe(false);
    expect(self.status).toBe(400);
    expect(self.code).toBe("edge_cycle");
  });
});

// The two edge types whose graph is walked for a path back: nothing else is
// refused a cycle longer than a self-loop.
const WALKED = ["parent-of", "supersedes"] as const;

describe("a cycle through each write path that refuses one", () => {
  async function stored(source: string, edgeType: string): Promise<string[]> {
    const r = await client.listItemEdges(source, { edge_type: edgeType });
    expect(r.status).toBe(200);
    return r.data.data.map((e) => e.target_id).sort();
  }

  /** What a refused cycle names: the type and the two ends the caller gave. */
  function cycle(edgeType: string, source: string, target: string) {
    return { edge_type: edgeType, source_id: source, target_id: target };
  }

  it("refuses a PATCH /edges/{id} move that closes a cycle, and moves a free edge", async () => {
    for (const edgeType of WALKED) {
      // target -> source exists, so an edge that runs source -> target would close it.
      const source = await makeItem(`${edgeType}-mv-source`);
      const target = await makeItem(`${edgeType}-mv-target`);
      const other = await makeItem(`${edgeType}-mv-other`);
      const free = await makeItem(`${edgeType}-mv-free`);
      expect((await makeEdge(target, source, edgeType)).ok).toBe(true);
      const moving = await client.createEdge({
        source_id: other,
        target_id: target,
        edge_type: edgeType,
      });
      expect(moving.status, edgeType).toBe(201);
      trackEdge(ctx, moving.data.edge.id);
      const { id, version } = moving.data.edge;

      const refused = await client.updateEdge(id, {
        version,
        source_id: source,
      });
      expect(refused.status, edgeType).toBe(400);
      expect(refused.error?.error.code, edgeType).toBe("edge_cycle");
      expect(refused.error?.error.details, edgeType).toEqual(
        cycle(edgeType, source, target),
      );
      const kept = await client.getEdge(id);
      expect(kept.data.edge, edgeType).toMatchObject({
        source_id: other,
        target_id: target,
        version,
      });

      // The witness: the same edge moves to a source with no path back.
      const moved = await client.updateEdge(id, { version, source_id: free });
      expect(moved.status, edgeType).toBe(200);
      expect(moved.data.edge.source_id, edgeType).toBe(free);
    }
  });

  it("refuses a POST /edges/bulk entry that closes a cycle, as an errored entry or a rollback", async () => {
    for (const edgeType of WALKED) {
      const a = await makeItem(`${edgeType}-bk-a`);
      const b = await makeItem(`${edgeType}-bk-b`);
      const c = await makeItem(`${edgeType}-bk-c`);
      const d = await makeItem(`${edgeType}-bk-d`);
      expect((await makeEdge(a, b, edgeType)).ok).toBe(true);

      const partial = await client.bulkEdges({
        atomic: false,
        edges: [
          { source_id: b, target_id: a, edge_type: edgeType },
          { source_id: c, target_id: d, edge_type: edgeType },
        ],
      });
      expect(partial.status, edgeType).toBe(200);
      const [refused, witness] = partial.data.results;
      expect(refused?.outcome, edgeType).toBe("errored");
      expect(refused?.error?.code, edgeType).toBe("edge_cycle");
      expect(refused?.error?.details, edgeType).toEqual(cycle(edgeType, b, a));
      expect(witness?.outcome, edgeType).toBe("created");
      trackEdge(ctx, witness!.id!);
      expect(await stored(c, edgeType), edgeType).toEqual([d]);
      expect(await stored(b, edgeType), edgeType).toEqual([]);

      const e = await makeItem(`${edgeType}-bk-e`);
      const f = await makeItem(`${edgeType}-bk-f`);
      const rolled = await client.bulkEdges({
        edges: [
          { source_id: e, target_id: f, edge_type: edgeType },
          { source_id: b, target_id: a, edge_type: edgeType },
        ],
      });
      expect(rolled.status, edgeType).toBe(400);
      expect(rolled.error?.error.code, edgeType).toBe("bulk_atomic_rollback");
      expect(rolled.error?.error.details, edgeType).toMatchObject({
        index: 1,
        code: "edge_cycle",
        details: cycle(edgeType, b, a),
      });
      expect(await stored(e, edgeType), edgeType).toEqual([]);
      expect(await stored(b, edgeType), edgeType).toEqual([]);
    }
  });

  it("refuses an atomic page that proposes an edge and its reverse together, and writes neither", async () => {
    for (const edgeType of WALKED) {
      const a = await makeItem(`${edgeType}-pg-a`);
      const b = await makeItem(`${edgeType}-pg-b`);

      const refused = await client.bulkEdges({
        atomic: true,
        edges: [
          { source_id: a, target_id: b, edge_type: edgeType },
          { source_id: b, target_id: a, edge_type: edgeType },
        ],
      });
      expect(refused.status, edgeType).toBe(400);
      expect(refused.error?.error.code, edgeType).toBe("bulk_atomic_rollback");
      expect(refused.error?.error.details, edgeType).toMatchObject({
        index: 1,
        code: "edge_cycle",
        details: cycle(edgeType, b, a),
      });
      expect(await stored(a, edgeType), edgeType).toEqual([]);
      expect(await stored(b, edgeType), edgeType).toEqual([]);

      // The witness: the acyclic edge of the same page lands alone, and the
      // listing that showed nothing above shows it.
      const alone = await client.bulkEdges({
        atomic: true,
        edges: [{ source_id: a, target_id: b, edge_type: edgeType }],
      });
      expect(alone.status, edgeType).toBe(200);
      trackEdge(ctx, alone.data.results[0]!.id!);
      expect(await stored(a, edgeType), edgeType).toEqual([b]);
    }

    // A type nothing walks takes the pair: the refusal is the type's.
    const a = await makeItem("pg-about-a");
    const b = await makeItem("pg-about-b");
    const pair = await client.bulkEdges({
      atomic: true,
      edges: [
        { source_id: a, target_id: b, edge_type: "about" },
        { source_id: b, target_id: a, edge_type: "about" },
      ],
    });
    expect(pair.status).toBe(200);
    for (const entry of pair.data.results) trackEdge(ctx, entry.id!);
    expect(pair.data.counts.created).toBe(2);
  });
});
