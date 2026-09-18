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
 * these doors carry no replace mode and no null-clears, a `null` is
 * stored rather than clearing the key, and recreating the edge restarts
 * its version. The last case here pins that, so the limit is measured
 * rather than only written down on the route and in the store interface.
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
    key: ctx.spaceKey,
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
    key: ctx.spaceKey,
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
    key: ctx.spaceKey,
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
      key: ctx.spaceKey,
      body: { properties: PATCH, version: edge.version },
    });
    expect(res.status).toBe(200);

    expect(await storedProperties(edge.id)).toEqual(AFTER);
  });

  it("answers the same as the item door given the same payload", async () => {
    // The reason this change was made rather than the other one available:
    // the two doors disagreed, and the item door is the one clients have
    // been written against.
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "merge-parity", ...BOTH },
      },
    });
    expect(itemRes.status).toBe(201);
    const created = (
      (await itemRes.json()) as { item: { id: string; version: number } }
    ).item;

    const { edge } = await edgeWith(BOTH);

    await request(ctx.app, "PATCH", `/items/${created.id}`, {
      key: ctx.spaceKey,
      body: { properties: PATCH, version: created.version },
    });
    await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.spaceKey,
      body: { properties: PATCH, version: edge.version },
    });

    const item = await request(ctx.app, "GET", `/items/${created.id}`, {
      key: ctx.spaceKey,
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
      key: ctx.spaceKey,
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

  it("stores a null rather than clearing the key it names", async () => {
    // The limit this change carries, measured rather than asserted in
    // prose. A caller reaching for the obvious way to drop a property
    // gets a stored null, and the key is then there for good: the merge
    // is `{...current, ...incoming}` with nothing filtering it, and no
    // door on an edge takes a replace mode or a null-clears flag.
    const { edge } = await edgeWith(BOTH);

    const res = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.spaceKey,
      body: { properties: { label: null }, version: edge.version },
    });
    expect(res.status).toBe(200);

    const after = await storedProperties(edge.id);
    expect(after).toHaveProperty("label");
    expect(after.label).toBeNull();
  });

  it("still refuses a stale version, and hands back the merged row", async () => {
    // The precondition is decided by the write statement, and the merge
    // put a read in front of it. A refusal has to stay a refusal, and the
    // edge it returns has to be the one the caller must re-apply over.
    const { edge } = await edgeWith(BOTH);

    const moved = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.spaceKey,
      body: { properties: PATCH, version: edge.version },
    });
    expect(moved.status).toBe(200);

    const stale = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.spaceKey,
      body: { properties: { label: "loser" }, version: edge.version },
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { edge?: WireEdge };
    expect(body.edge?.properties).toEqual(AFTER);
    expect(body.edge?.version).toBe(edge.version + 1);

    // And the losing write changed nothing.
    expect(await storedProperties(edge.id)).toEqual(AFTER);
  });
  it("accepts exactly one of eight writers that read the same version, and it lands", async () => {
    // Eight clients read one version and all write from it. The version
    // gate decides this now: the first to land moves the row past the
    // version the other seven named, so seven are refused and exactly one
    // is accepted. Asserting the count is the point — "at least one" would
    // pass on a build that had lost the gate entirely and accepted all
    // eight, which is the failure this case is closest to.
    //
    // **This no longer exercises the row lock, and that is a real loss to
    // record rather than paper over.** It used to: before an update
    // carried a required version these eight were unconditional, several
    // could be accepted, and the transaction was the only thing stopping
    // one merge overwriting another computed from the same read. The gate
    // refuses them earlier now, so the interleaving never reaches the
    // lock. What would still reach it is eight writers that each GET the
    // edge and then PATCH with what they read — a genuine read-then-write
    // race, where two can read the same version only by interleaving.
    // Nothing in this file does that today.
    const { edge } = await edgeWith({ base: "kept" });

    const keys = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"];
    const responses = await Promise.all(
      keys.map((k) =>
        request(ctx.app, "PATCH", `/edges/${edge.id}`, {
          key: ctx.spaceKey,
          body: { properties: { [k]: k }, version: edge.version },
        }),
      ),
    );
    const accepted = keys.filter((_, i) => responses[i]?.status === 200);
    expect(accepted).toHaveLength(1);

    const after = await storedProperties(edge.id);
    expect(after.base).toBe("kept");
    // The accepted write is durable, which is what a 200 has to mean.
    expect(after).toHaveProperty(accepted[0]!);
  });
});
