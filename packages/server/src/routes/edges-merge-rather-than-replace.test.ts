/**
 * An edge update keeps the properties it was not told about.
 *
 * The write used to replace the property bag wholesale, so an update
 * naming one property dropped every other property on that edge. Both
 * halves were defensible alone — a client queuing what changed is right,
 * and a replacing endpoint is a coherent design — and nothing had ever put
 * them side by side. What made it costly is that the local engine's
 * projection merges, so the screen went on showing the properties the
 * server had just discarded, until some inbound event happened to correct
 * the row. On a quiet space that is indefinitely.
 *
 * The item doors already merged, so the edge doors were the odd ones out
 * and the consistent answer was to move them. The case below drives the
 * identical payload through both, because a test that built one payload
 * per door could drift into two that each pass their own.
 *
 * There is no way to remove a single property from an edge afterwards:
 * these doors carry no replace mode and no null-clears. That is stated on
 * the route and in the store interface, and it is a consequence of this
 * change rather than something it introduced a mechanism for.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface WireEdge {
  id: string;
  properties: Record<string, unknown>;
  version: number;
}

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/** An edge between two fresh notes, carrying `properties`. */
async function edgeWith(
  properties: Record<string, unknown>,
): Promise<{ edge: WireEdge; source: string; target: string }> {
  const marker = Math.random().toString(36).slice(2);
  const source = await note(`src-${marker}`);
  const target = await note(`tgt-${marker}`);
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.adminKey,
    body: {
      source_id: source,
      target_id: target,
      edge_type: "references",
      properties,
    },
  });
  expect(res.status).toBe(201);
  return {
    edge: ((await res.json()) as { edge: WireEdge }).edge,
    source,
    target,
  };
}

/** The edge as the server holds it, read back rather than taken from the
 *  write's own response — a write that returned a merged body while
 *  storing a replaced row would satisfy the weaker check. */
async function storedProperties(id: string): Promise<Record<string, unknown>> {
  const res = await request(ctx.app, "GET", `/edges/${id}`, {
    key: ctx.adminKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { edge: WireEdge }).edge.properties;
}

/** The two properties every case here starts from, and the patch that
 *  names one of them. Shared so no case can drift into its own shape. */
const BOTH = { label: "kept", weight: 3 };
const PATCH = { weight: 4 };
const AFTER = { label: "kept", weight: 4 };

describe("an edge update merges over what the edge holds", () => {
  it("leaves a property the patch did not name", async () => {
    const { edge } = await edgeWith(BOTH);

    const res = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: PATCH },
    });
    expect(res.status).toBe(200);

    expect(await storedProperties(edge.id)).toEqual(AFTER);
  });

  it("answers the same as the item door given the same payload", async () => {
    // The reason this change was made rather than the other one available:
    // the two doors disagreed, and the item door is the one clients have
    // been written against.
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "merge-parity", ...BOTH },
      },
    });
    expect(itemRes.status).toBe(201);
    const itemId = ((await itemRes.json()) as { item: { id: string } }).item.id;

    const { edge } = await edgeWith(BOTH);

    await request(ctx.app, "PATCH", `/items/${itemId}`, {
      key: ctx.adminKey,
      body: { properties: PATCH },
    });
    await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: PATCH },
    });

    const item = await request(ctx.app, "GET", `/items/${itemId}`, {
      key: ctx.adminKey,
    }).then(
      async (r) =>
        ((await r.json()) as { item: { properties: Record<string, unknown> } })
          .item.properties,
    );

    // The note's own body is not part of the comparison; the two
    // properties driven through both doors are.
    expect({ label: item.label, weight: item.weight }).toEqual(AFTER);
    expect(await storedProperties(edge.id)).toEqual(AFTER);
  });

  it("merges on the bulk door too, which is the second site", async () => {
    // The bulk upsert reaches the same statement through a different route
    // file. A merge written into `PATCH` rather than into the store would
    // pass every case above and leave this one replacing.
    const { edge, source, target } = await edgeWith(BOTH);

    const res = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.adminKey,
      body: {
        edges: [
          {
            source_id: source,
            target_id: target,
            edge_type: "references",
            properties: PATCH,
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    expect(await storedProperties(edge.id)).toEqual(AFTER);
  });

  it("still refuses a stale version, and hands back the merged row", async () => {
    // The precondition is decided by the write statement, and the merge
    // put a read in front of it. A refusal has to stay a refusal, and the
    // edge it returns has to be the one the caller must re-apply over.
    const { edge } = await edgeWith(BOTH);

    const moved = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: PATCH },
    });
    expect(moved.status).toBe(200);

    const stale = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: { label: "loser" }, version: edge.version },
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { edge?: WireEdge };
    expect(body.edge?.properties).toEqual(AFTER);
    expect(body.edge?.version).toBe(edge.version + 1);

    // And the losing write changed nothing.
    expect(await storedProperties(edge.id)).toEqual(AFTER);
  });
});
