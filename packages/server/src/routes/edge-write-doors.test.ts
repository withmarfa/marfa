/**
 * The doors that write an item's edges agree on who may write them.
 *
 * Edge writes are dual-gated: the caller needs write on the source item's
 * type AND write on the edge type. New credentials default to
 * `edge_permissions: {}` precisely because edge access is meant to be
 * opt-in, so a route that skips the second gate makes that default
 * meaningless for anyone who can reach it.
 *
 * Three routes accept an inline `edges` payload and reach the same state.
 * Testing one on its own cannot catch a gate that exists on the others and
 * is missing here, which is exactly how this was found — by probing the
 * door rather than reading it. So the property asserted is agreement.
 *
 * Both halves are covered. `applyInlineEdges` deletes every existing edge
 * of a listed type before recreating the requested set, so an empty array
 * is a delete instruction, and a caller who may not create an edge must
 * not be able to clear one either. The delete half is the easier one to
 * miss: a test that only checks creation passes while a caller can still
 * wipe edges it was never permitted to touch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import { generateId } from "@withmarfa/shared";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * A key holding write on `core.note` and nothing on any edge type.
 * The type half of the dual gate passes, so anything that gets through is
 * the edge half being absent rather than the request being wrong.
 */
async function keyWithoutEdgePermissions(): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.spaceKey,
    body: {
      label: `edge-door-${suffix}`,
      source: `edge-door-${suffix}`,
      space_permissions: [],
      default_tier: "library",
      type_permissions: { "core.note": "write" },
      edge_permissions: {},
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

async function note(sourceId?: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: {
      type: "core.note",
      ...(sourceId ? { source_id: sourceId } : {}),
      properties: { body: "edge door fixture" },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function edgeCount(sourceItemId: string): Promise<number> {
  const res = await request(ctx.app, "GET", `/items/${sourceItemId}/edges`, {
    key: ctx.spaceKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: unknown[] }).data.length;
}

/** Give `sourceItemId` one `about` edge, using authority that may do so. */
async function seedEdge(sourceItemId: string, targetId: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.spaceKey,
    body: { source_id: sourceItemId, target_id: targetId, edge_type: "about" },
  });
  expect(res.status).toBe(201);
}

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

interface Door {
  name: string;
  /** `${METHOD} ${path}` exactly as Hono registers it. */
  route: string;
  /**
   * How the door says no. The direct routes refuse the request outright
   * with the permission error. Bulk in atomic mode wraps every per-item
   * failure in `bulk_atomic_rollback` and answers 400, which is the same
   * envelope it already gives an unauthorized type — the refusal is the
   * batch aborting, and the underlying code rides in the details. Spelled
   * out per door rather than flattened, so a door that starts answering
   * the wrong way fails here.
   */
  refusalStatus: 403 | 400;
  /**
   * Write `edges` onto an item the caller may otherwise write. `existing`
   * is a row that already exists and can be addressed by id or by natural
   * key, so the same door can be driven for both halves.
   */
  write(
    key: string,
    existing: { id: string; sourceId: string },
    edges: Record<string, string[]>,
  ): Promise<Response>;
}

const DOORS: Door[] = [
  {
    name: "POST /items (create)",
    route: "POST /items",
    refusalStatus: 403,
    write: (key, _existing, edges) =>
      request(ctx.app, "POST", "/items", {
        key,
        body: { type: "core.note", properties: { body: "door" }, edges },
      }),
  },
  {
    name: "POST /items (natural-key upsert)",
    route: "POST /items",
    refusalStatus: 403,
    write: (key, existing, edges) =>
      request(ctx.app, "POST", "/items", {
        key,
        body: {
          type: "core.note",
          source_id: existing.sourceId,
          properties: { body: "door" },
          edges,
        },
      }),
  },
  {
    name: "POST /items/bulk (by id)",
    route: "POST /items/bulk",
    refusalStatus: 400,
    write: (key, existing, edges) =>
      request(ctx.app, "POST", "/items/bulk", {
        key,
        body: {
          atomic: true,
          items: [
            {
              id: existing.id,
              type: "core.note",
              properties: { body: "door" },
              edges,
            },
          ],
        },
      }),
  },
  {
    name: "POST /items/bulk (natural key)",
    route: "POST /items/bulk",
    refusalStatus: 400,
    write: (key, existing, edges) =>
      request(ctx.app, "POST", "/items/bulk", {
        key,
        body: {
          atomic: true,
          items: [
            {
              source_id: existing.sourceId,
              type: "core.note",
              properties: { body: "door" },
              edges,
            },
          ],
        },
      }),
  },
];

// ---------------------------------------------------------------------------
// The agreement
// ---------------------------------------------------------------------------

describe.each(DOORS)("$name", (door) => {
  it("refuses to create an edge the caller has no edge permission for", async () => {
    const key = await keyWithoutEdgePermissions();
    const sourceId = `edge-door-create-${Math.random().toString(36).slice(2)}`;
    const existingId = await note(sourceId);
    const target = await note();

    const res = await door.write(
      key,
      { id: existingId, sourceId },
      { about: [target] },
    );

    expect(res.status).toBe(door.refusalStatus);
    // Bulk nests the real code inside the rollback envelope's details, so
    // assert on the code rather than the top-level shape. Without this the
    // bulk doors would pass on any 400, including a validation error that
    // refused for the wrong reason entirely.
    expect(JSON.stringify(await res.json())).toContain(
      "edge_permission_denied",
    );
  });

  it("refuses to clear an existing edge by writing an empty list", async () => {
    const key = await keyWithoutEdgePermissions();
    const sourceId = `edge-door-delete-${Math.random().toString(36).slice(2)}`;
    const existingId = await note(sourceId);
    const target = await note();
    await seedEdge(existingId, target);
    expect(await edgeCount(existingId)).toBe(1);

    const res = await door.write(
      key,
      { id: existingId, sourceId },
      {
        about: [],
      },
    );

    expect(res.status).toBe(door.refusalStatus);
    // The status alone is not the property that matters. `applyInlineEdges`
    // deletes before it validates, so a refusal that still let the delete
    // commit would report a refusal and destroy the edge anyway.
    expect(await edgeCount(existingId)).toBe(1);
  });

  it("still allows the write when the caller does hold the edge permission", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: `edge-door-allowed-${suffix}`,
        source: `edge-door-allowed-${suffix}`,
        space_permissions: [],
        default_tier: "library",
        type_permissions: { "core.note": "write" },
        edge_permissions: { about: "write" },
      },
    });
    expect(keyRes.status).toBe(201);
    const key = ((await keyRes.json()) as { key: string }).key;

    const sourceId = `edge-door-allowed-${Math.random().toString(36).slice(2)}`;
    const existingId = await note(sourceId);
    const target = await note();

    const res = await door.write(
      key,
      { id: existingId, sourceId },
      { about: [target] },
    );

    // The gate must not have become a blanket refusal — a fix that denies
    // everyone passes both tests above and breaks every legitimate caller.
    expect(res.status).toBeLessThan(400);
  });
});

describe("the two doors that accept a client-supplied edge id", () => {
  /**
   * Agreement, like every other property in this file. `POST /edges` and
   * `POST /edges/bulk` both declare an `id` and both write it to the same
   * column, so an id shape one accepts and the other refuses is a rule
   * that depends on which door the writer happened to use.
   *
   * The bulk door is the one that had it wrong: it declared the field
   * first and stored whatever arrived. Nothing downstream objected —
   * `PATCH` and `DELETE /edges/{id}` address any string — so the row was
   * usable and the identifier was not.
   */
  it("refuse a malformed id the same way", async () => {
    const source = await note();
    const target = await note();
    const malformed = "not-an-identifier";

    const single = await request(ctx.app, "POST", "/edges", {
      key: ctx.spaceKey,
      body: {
        id: malformed,
        source_id: source,
        target_id: target,
        edge_type: "about",
      },
    });
    expect(single.status).toBe(400);
    expect(
      ((await single.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_id");

    const bulk = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.spaceKey,
      body: {
        atomic: false,
        edges: [
          {
            id: malformed,
            source_id: source,
            target_id: target,
            edge_type: "about",
          },
        ],
      },
    });
    const bulkBody = (await bulk.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    // Bulk reports per entry rather than refusing the request, which is
    // its contract for every other check. The code is what has to match.
    expect(bulkBody.results[0]?.outcome).toBe("errored");
    expect(bulkBody.results[0]?.error?.code).toBe("invalid_id");

    // Neither door wrote anything.
    expect(await edgeCount(source)).toBe(0);
  });

  it("accept a well-formed id the same way", async () => {
    // The agreement has to hold in both directions, or "they agree" is
    // satisfied by a door that refuses everything.
    const singleSource = await note();
    const singleTarget = await note();
    const singleId = generateId();
    const single = await request(ctx.app, "POST", "/edges", {
      key: ctx.spaceKey,
      body: {
        id: singleId,
        source_id: singleSource,
        target_id: singleTarget,
        edge_type: "about",
      },
    });
    expect(single.status).toBe(201);
    expect(((await single.json()) as { edge: { id: string } }).edge.id).toBe(
      singleId,
    );

    const bulkSource = await note();
    const bulkTarget = await note();
    const bulkId = generateId();
    const bulk = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.spaceKey,
      body: {
        atomic: false,
        edges: [
          {
            id: bulkId,
            source_id: bulkSource,
            target_id: bulkTarget,
            edge_type: "about",
          },
        ],
      },
    });
    const bulkBody = (await bulk.json()) as {
      results: { outcome: string; id?: string }[];
    };
    expect(bulkBody.results[0]?.outcome).toBe("created");
    expect(bulkBody.results[0]?.id).toBe(bulkId);
  });
});
