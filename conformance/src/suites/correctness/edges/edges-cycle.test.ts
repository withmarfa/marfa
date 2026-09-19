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
