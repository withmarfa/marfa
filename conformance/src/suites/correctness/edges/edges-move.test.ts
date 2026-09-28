import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { MarfaEdge, TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../../utils/setup.js";
import { createNote } from "../../../generators/items.js";

/**
 * An end that holds one edge of a type has that edge replaced by moving it:
 * one write, so no reader ever finds the end holding none (`edges.md` 10).
 */

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "edges-move"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(body: string): Promise<string> {
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
  properties?: Record<string, unknown>,
): Promise<MarfaEdge> {
  const r = await client.createEdge({
    source_id,
    target_id,
    edge_type,
    ...(properties === undefined ? {} : { properties }),
  });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge;
}

/** The sources of an item's inbound edges of one type. */
async function parentsOf(child: string, edgeType: string): Promise<string[]> {
  const r = await client.listItemBackrefs(child, { edge_type: edgeType });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.data.data.map((edge) => edge.source_id);
}

/** The targets of an item's outbound edges of one type. */
async function targetsOf(source: string, edgeType: string): Promise<string[]> {
  const r = await client.listItemEdges(source, { edge_type: edgeType });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.data.data.map((edge) => edge.target_id);
}

describe("moving an edge's end", () => {
  it("moves a child to a new parent in one write, keeping the edge's id and properties", async () => {
    const first = await makeItem("move-first-parent");
    const second = await makeItem("move-second-parent");
    const child = await makeItem("move-child");
    const held = await makeEdge(first, child, "parent-of", { since: "spring" });
    expect(await parentsOf(child, "parent-of")).toEqual([first]);

    const moved = await client.updateEdge(held.id, {
      source_id: second,
      properties: { note: "moved" },
      version: held.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.edge).toMatchObject({
      id: held.id,
      source_id: second,
      target_id: child,
      edge_type: "parent-of",
      properties: { since: "spring", note: "moved" },
      version: held.version + 1,
    });
    expect(await parentsOf(child, "parent-of")).toEqual([second]);
    expect(await targetsOf(first, "parent-of")).toEqual([]);
    const read = await client.getEdge(held.id);
    expect(read.data.edge.source_id).toBe(second);
  });

  it("moves a message to another thread, and a successor onto another predecessor", async () => {
    const message = await makeItem("move-message");
    const oldThread = await makeItem("move-old-thread");
    const newThread = await makeItem("move-new-thread");
    const joined = await makeEdge(message, oldThread, "in-thread");
    const rethreaded = await client.updateEdge(joined.id, {
      target_id: newThread,
      version: joined.version,
    });
    expect(rethreaded.status, JSON.stringify(rethreaded.error)).toBe(200);
    expect(await targetsOf(message, "in-thread")).toEqual([newThread]);

    const newer = await makeItem("move-newer");
    const older = await makeItem("move-older");
    const oldest = await makeItem("move-oldest");
    const supersedes = await makeEdge(newer, older, "supersedes");
    const repointed = await client.updateEdge(supersedes.id, {
      target_id: oldest,
      version: supersedes.version,
    });
    expect(repointed.status, JSON.stringify(repointed.error)).toBe(200);
    expect(await targetsOf(newer, "supersedes")).toEqual([oldest]);
    expect(await parentsOf(older, "supersedes")).toEqual([]);
  });

  it("never shows a reader the end with no edge while the edge moves", async () => {
    const parents = [await makeItem("race-a"), await makeItem("race-b")];
    const child = await makeItem("race-child");

    // The witness: written as a delete and a create, a read between the two
    // finds the child with no parent.
    const doomed = await makeEdge(parents[0]!, child, "parent-of");
    expect((await client.deleteEdge(doomed.id)).ok).toBe(true);
    expect(
      await parentsOf(child, "parent-of"),
      "a read between a delete and a create did not find the end empty, so the race below proves nothing",
    ).toEqual([]);

    const held = await makeEdge(parents[0]!, child, "parent-of");
    let version = held.version;
    let moving = true;
    const seen: number[] = [];
    const reads = (async () => {
      while (moving) {
        seen.push((await parentsOf(child, "parent-of")).length);
      }
    })();
    try {
      for (let step = 1; step <= 20; step += 1) {
        const moved = await client.updateEdge(held.id, {
          source_id: parents[step % 2]!,
          version,
        });
        expect(moved.status, JSON.stringify(moved.error)).toBe(200);
        version = moved.data.edge.version;
      }
    } finally {
      moving = false;
      await reads;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.filter((count) => count !== 1),
      "a read racing the move found the child with no parent, or with two",
    ).toEqual([]);
  });
});
