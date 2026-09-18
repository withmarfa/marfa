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
