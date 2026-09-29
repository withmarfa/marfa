import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-hidden-limits",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * Two graph rules are judged on the whole graph, edges the key cannot see
 * included, so a refusal can say that something hidden exists. These pin
 * that it says no more than that: nothing of the hidden item's id or type.
 */
describe("a graph refusal owed to an edge the key cannot see", () => {
  /** Writes notes and every edge type, and holds nothing on bookmarks. */
  let writer: MarfaClient;

  async function note(): Promise<string> {
    const r = await writer.createItem(createNote());
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    return r.data.item.id;
  }

  async function hidden(): Promise<string> {
    const r = await client.createItem(createBookmark({ source: ctx.source }));
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    return r.data.item.id;
  }

  async function parentOf(parent: string, child: string): Promise<void> {
    const r = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    expect(r.status).toBe(201);
    trackEdge(ctx, r.data.edge.id);
  }

  async function give(parent: string, child: string) {
    const r = await writer.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    if (r.ok) trackEdge(ctx, r.data.edge.id);
    return r;
  }

  beforeAll(async () => {
    const minted = await client.createKey({
      label: "edge-hidden-limits",
      source: `${ctx.source}-edge-hidden-limits`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    writer = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
  });

  it("refuses a second parent the key cannot see, naming only the child", async () => {
    const child = await note();
    const secret = await hidden();
    await parentOf(secret, child);
    // The key sees no parent: the edge is its hidden source's statement.
    const seen = await writer.listItemBackrefs(child);
    expect(seen.status).toBe(200);
    expect(seen.data.data).toEqual([]);

    const refused = await give(await note(), child);
    expect(refused.status).toBe(400);
    expect(refused.error?.error).toEqual({
      code: "edge_constraint_violation",
      message:
        'Edge "parent-of" is one-to-many on the target side; target already has an inbound edge of this type',
      details: {
        edge_type: "parent-of",
        target_id: child,
        constraint: "cardinality",
      },
    });
    expect(JSON.stringify(refused.error)).not.toContain(secret);
    expect(JSON.stringify(refused.error)).not.toContain("core.bookmark");

    // The witness: the same write lands where the child has no parent.
    expect((await give(await note(), await note())).status).toBe(201);
  });

  it("refuses an edge that closes a cycle only through an edge the key cannot see, naming only its own ends", async () => {
    // a parent-of b is written over b -> secret -> a, whose second edge
    // has a source the key cannot read.
    const a = await note();
    const b = await note();
    const secret = await hidden();
    await parentOf(b, secret);
    await parentOf(secret, a);
    const seen = await writer.listItemBackrefs(a);
    expect(seen.status).toBe(200);
    expect(seen.data.data).toEqual([]);

    const refused = await give(a, b);
    expect(refused.status).toBe(400);
    expect(refused.error?.error).toEqual({
      code: "edge_cycle",
      message: 'Edge "parent-of" would close a cycle',
      details: { edge_type: "parent-of", source_id: a, target_id: b },
    });
    expect(JSON.stringify(refused.error)).not.toContain(secret);
    expect(JSON.stringify(refused.error)).not.toContain("core.bookmark");

    // The witness: the same write lands where the hidden edge leads nowhere back.
    const c = await note();
    const d = await note();
    await parentOf(d, await hidden());
    expect((await give(c, d)).status).toBe(201);
  });
});
