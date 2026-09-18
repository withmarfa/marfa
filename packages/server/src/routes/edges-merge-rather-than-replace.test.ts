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
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "merge-parity", ...BOTH },
      },
    });
    expect(itemRes.status).toBe(201);
    const itemId = ((await itemRes.json()) as { item: { id: string } }).item.id;

    const { edge } = await edgeWith(BOTH);

    await request(ctx.app, "PATCH", `/items/${itemId}`, {
      key: ctx.spaceKey,
      body: { properties: PATCH },
    });
    await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.spaceKey,
      body: { properties: PATCH },
    });

    const item = await request(ctx.app, "GET", `/items/${itemId}`, {
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
      body: { properties: { label: null } },
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
      body: { properties: PATCH },
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
  it("never loses a patch it accepted, which is what the row lock is for", async () => {
    // The merge is computed from a read, so two patches interleaving
    // between another's read and its write lose one of them silently.
    // That is the entire reason this write took a transaction, and nothing
    // else in this file exercises it: every other case is sequential and
    // passes with it deleted.
    //
    // **The assertion is "no accepted write is lost", not "all eight
    // succeed".** The driver opens each transaction with BEGIN IMMEDIATE
    // and a second one meets `SQLITE_BUSY` rather than waiting, so seven
    // of eight are refused with a 500. That is not
    // introduced here — `PATCH /items/{id}` has done the same since it
    // started merging under a transaction, measured on this build — and
    // it is a defect in its own right, tracked separately. What must
    // hold on both dialects is that a 200 means the write landed.
    //
    // Eight rather than two because a single pair may not interleave. A
    // correct implementation passes every time and a loaded machine
    // makes that more certain rather than less; an unlocked one drops an
    // accepted key on almost any run.
    // Last in the file deliberately. On SQLite the refused arrivals
    // leave the write lock contended for a moment afterwards, and a
    // case following this one saw its own first write answer 500. That
    // is the same pre-existing behavior this case documents, showing up
    // as flakiness in a neighbor rather than as a failure here.
    const { edge } = await edgeWith({ base: "kept" });

    const keys = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"];
    const responses = await Promise.all(
      keys.map((k) =>
        request(ctx.app, "PATCH", `/edges/${edge.id}`, {
          key: ctx.spaceKey,
          body: { properties: { [k]: k } },
        }),
      ),
    );
    const accepted = keys.filter((_, i) => responses[i]?.status === 200);
    // The control. Without it a build that refused all eight would pass
    // this case having proved nothing.
    expect(accepted.length).toBeGreaterThan(0);

    const after = await storedProperties(edge.id);
    expect(after.base).toBe("kept");
    for (const k of accepted) {
      expect(after, `a 200 was not durable: ${k}`).toHaveProperty(k);
    }
  });
});
