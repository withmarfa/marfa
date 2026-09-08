/**
 * GET /items/:id?include=backrefs,neighbors,versions — the 1-hop neighborhood
 * read that collapses an open-a-detail fan-out into one request.
 *
 * Coverage:
 *  - the base shape (item + outbound edges + metadata) is unchanged when no
 *    include is passed;
 *  - `backrefs` hydrates inbound edges grouped by type, with per-type cap +
 *    pagination signalling;
 *  - `neighbors` hydrates the far-end items of the requested edge blocks, each
 *    with its metadata;
 *  - neighbor hydration is NOT an access-control bypass: a neighbor the
 *    caller cannot read by type, or that lives in another space, is silently
 *    omitted, never leaked;
 *  - `versions` is opt-in.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { HYDRATE_PER_TYPE_CAP } from "./_edges-hydrate.js";

let ctx: TestContext;

const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
const spaceB = `space-b-${Math.random().toString(36).slice(2, 10)}`;
let adminA: string;
let adminB: string;
// Reads core.note only — used to prove a neighbor of an unreadable type is
// omitted rather than leaked through the bundle.
let noteReaderA: string;

async function mintKey(
  label: string,
  spaceId: string,
  opts: {
    type_permissions?: Record<string, "read" | "write">;
    edge_permissions?: Record<string, "read" | "write">;
  } = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_detail_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      // No space permission is named because no door here asks for one: the
      // item read, the edge writes and the neighbor hydration are all decided
      // by the two maps below.
      default_tier: "library",
      type_permissions: opts.type_permissions ?? { "*": "write" },
      edge_permissions: opts.edge_permissions ?? { "*": "write" },
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

async function create(
  key: string,
  type: string,
  properties: Record<string, unknown>,
  tags?: string[],
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type, properties, ...(tags ? { tags } : {}) },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { item: { id: string } };
  return body.item.id;
}

async function edge(
  key: string,
  source_id: string,
  target_id: string,
  edge_type: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const res = await request(ctx.app, "POST", "/edges", {
    key,
    body: {
      source_id,
      target_id,
      edge_type,
      ...(properties ? { properties } : {}),
    },
  });
  expect(res.status).toBe(201);
}

interface EdgesBlock {
  edges: {
    id: string;
    source_id: string;
    target_id: string;
    edge_type: string;
  }[];
  has_more: boolean;
  next_cursor?: string;
}
interface DetailResponse {
  item: { id: string; edges?: Record<string, EdgesBlock> };
  metadata: { item_id: string; tags: string[] };
  backrefs?: Record<string, EdgesBlock>;
  neighbors?: {
    item: { id: string; type: string };
    metadata: { tags: string[] };
  }[];
  neighbors_truncated?: boolean;
  neighbors_omitted?: number;
  versions?: { id: string; version: number }[];
}

async function detail(
  key: string,
  id: string,
  include?: string,
): Promise<DetailResponse> {
  const path = include
    ? `/items/${id}?include=${encodeURIComponent(include)}`
    : `/items/${id}`;
  const res = await request(ctx.app, "GET", path, { key });
  expect(res.status).toBe(200);
  return (await res.json()) as DetailResponse;
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminA = await mintKey("detail-admin-a", spaceA);
  adminB = await mintKey("detail-admin-b", spaceB);
  noteReaderA = await mintKey("detail-note-reader-a", spaceA, {
    type_permissions: { "core.note": "read" },
    edge_permissions: { "*": "read" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /items/:id — base shape is unchanged without include", () => {
  it("returns item (with outbound edges) + metadata, and no neighborhood blocks", async () => {
    const parent = await create(adminA, "core.note", { body: "root" }, ["t"]);
    const child = await create(adminA, "core.note", { body: "child" });
    await edge(adminA, parent, child, "parent-of");

    const d = await detail(adminA, parent);
    expect(d.item.id).toBe(parent);
    expect(d.metadata.tags).toEqual(["t"]);
    // Outbound edges are always hydrated on the single-item read.
    expect(d.item.edges?.["parent-of"]?.edges.length).toBe(1);
    // The opt-in blocks are absent unless requested.
    expect(d.backrefs).toBeUndefined();
    expect(d.neighbors).toBeUndefined();
    expect(d.versions).toBeUndefined();
  });
});

describe("GET /items/:id?include=backrefs", () => {
  it("hydrates inbound edges grouped by type", async () => {
    const parent = await create(adminA, "core.note", { body: "thread root" });
    const comment = await create(adminA, "core.note", { body: "a comment" });
    // in-thread: comment is the source, the thread root is the target — so the
    // parent carries it as an INBOUND edge (a backref), not an outbound one.
    await edge(adminA, comment, parent, "in-thread");

    const d = await detail(adminA, parent, "backrefs");
    expect(d.backrefs?.["in-thread"]?.edges.length).toBe(1);
    expect(d.backrefs?.["in-thread"]?.edges[0]?.source_id).toBe(comment);
    // Inbound edges don't appear on the outbound `item.edges` block.
    expect(d.item.edges?.["in-thread"]).toBeUndefined();
  });
});

describe("GET /items/:id?include=neighbors", () => {
  it("hydrates outbound targets only when backrefs is not also requested", async () => {
    const parent = await create(adminA, "core.note", { body: "p" });
    const child = await create(adminA, "core.note", { body: "c" }, ["child"]);
    const comment = await create(adminA, "core.note", { body: "cm" });
    await edge(adminA, parent, child, "parent-of");
    await edge(adminA, comment, parent, "in-thread");

    const d = await detail(adminA, parent, "neighbors");
    const ids = (d.neighbors ?? []).map((n) => n.item.id);
    expect(ids).toContain(child);
    expect(ids).not.toContain(comment); // inbound source not pulled without backrefs
    const childNeighbor = d.neighbors?.find((n) => n.item.id === child);
    expect(childNeighbor?.metadata.tags).toEqual(["child"]);
  });

  it("hydrates both outbound targets and inbound sources when backrefs is requested", async () => {
    const parent = await create(adminA, "core.note", { body: "p2" });
    const child = await create(adminA, "core.note", { body: "c2" });
    const comment = await create(adminA, "core.note", { body: "cm2" });
    await edge(adminA, parent, child, "parent-of");
    await edge(adminA, comment, parent, "in-thread");

    const d = await detail(adminA, parent, "backrefs,neighbors");
    const ids = (d.neighbors ?? []).map((n) => n.item.id).sort();
    expect(ids).toEqual([child, comment].sort());
    // A small, fully-hydrated neighbourhood is not truncated.
    expect(d.neighbors_truncated).toBe(false);
  });

  it("returns an empty neighbor list (not absent) for an item with no edges", async () => {
    const lone = await create(adminA, "core.note", { body: "lonely" });
    const d = await detail(adminA, lone, "backrefs,neighbors");
    expect(d.neighbors).toEqual([]);
    expect(d.backrefs).toEqual({});
  });
});

describe("GET /items/:id?include=neighbors — not an access-control bypass", () => {
  it("omits a neighbor whose type the caller cannot read", async () => {
    const parent = await create(adminA, "core.note", {
      body: "visible parent",
    });
    const secret = await create(adminA, "core.bookmark", { url: "https://x" });
    await edge(adminA, parent, secret, "parent-of");

    // The note-reader can read the parent (core.note) but not core.bookmark.
    const d = await detail(noteReaderA, parent, "neighbors");
    expect(d.item.id).toBe(parent);
    const ids = (d.neighbors ?? []).map((n) => n.item.id);
    expect(ids).not.toContain(secret);
    expect(ids).toEqual([]);
    // Omitting is right; omitting silently is not. Without a count, a
    // neighbourhood the caller may not fully read is indistinguishable from
    // one that is genuinely empty, so an app missing a scope renders a
    // ticket with none of its relations and looks correct doing it.
    expect(d.neighbors_omitted).toBe(1);
  });

  it("reports nothing omitted when the caller can read the whole neighborhood", () => {
    // The other direction, so the count cannot be a constant.
    return (async () => {
      const parent = await create(adminA, "core.note", { body: "root" });
      const child = await create(adminA, "core.note", { body: "child" });
      await edge(adminA, parent, child, "parent-of");
      const d = await detail(adminA, parent, "neighbors");
      expect((d.neighbors ?? []).map((n) => n.item.id)).toEqual([child]);
      expect(d.neighbors_omitted).toBe(0);
    })();
  });

  it("omits a cross-space neighbor even when an edge references it", async () => {
    const parentA = await create(adminA, "core.note", {
      body: "space A root",
    });
    const itemB = await create(adminB, "core.note", {
      body: "space B secret",
    });
    // Forge an edge in space A whose target is a space-B item — the raw edge
    // store bypasses constraint enforcement, simulating a stale / hostile edge.
    await ctx.storage.edges.createRaw(
      { source_id: parentA, target_id: itemB, edge_type: "parent-of" },
      spaceA,
    );

    const d = await detail(adminA, parentA, "neighbors");
    const ids = (d.neighbors ?? []).map((n) => n.item.id);
    // The edge is real and shows up in the outbound block...
    expect(d.item.edges?.["parent-of"]?.edges[0]?.target_id).toBe(itemB);
    // ...but the cross-space item is never hydrated into a neighbor.
    expect(ids).not.toContain(itemB);
    expect(ids).toEqual([]);
    // And it is not counted as a permission omission: an edge whose far end
    // this space cannot see is a repair, not a scope to widen. It is logged
    // separately for that reason.
    expect(d.neighbors_omitted).toBe(0);
  });
});

describe("GET /items/:id?include=versions", () => {
  it("returns version snapshots only when requested", async () => {
    const item = await create(adminA, "core.note", { body: "v1" });
    await request(ctx.app, "PATCH", `/items/${item}`, {
      key: adminA,
      body: { properties: { body: "v2" } },
    });

    const without = await detail(adminA, item);
    expect(without.versions).toBeUndefined();

    const withVersions = await detail(adminA, item, "versions");
    expect(Array.isArray(withVersions.versions)).toBe(true);
    expect((withVersions.versions ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /items/:id?include=backrefs — per-type pagination", () => {
  it("caps each inbound type and signals has_more + a cursor past the cap", async () => {
    const parent = await create(adminA, "core.note", { body: "busy thread" });
    const overflow = HYDRATE_PER_TYPE_CAP + 1;

    // Bulk-create the comment items, then bulk-wire the in-thread edges, so the
    // overflow setup is two requests instead of ~100.
    const bulkItems = await request(ctx.app, "POST", "/items/bulk", {
      key: adminA,
      body: {
        items: Array.from({ length: overflow }, (_, i) => ({
          type: "core.note",
          properties: { body: `comment ${String(i)}` },
        })),
        mode: "create_only",
      },
    });
    expect(bulkItems.status).toBe(200);
    const { results } = (await bulkItems.json()) as {
      results: { index: number; id: string }[];
    };
    const commentIds = results
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((r) => r.id);
    expect(commentIds.length).toBe(overflow);

    const bulkEdges = await request(ctx.app, "POST", "/edges/bulk", {
      key: adminA,
      body: {
        edges: commentIds.map((cid) => ({
          source_id: cid,
          target_id: parent,
          edge_type: "in-thread",
        })),
      },
    });
    expect(bulkEdges.status).toBe(200);

    const d = await detail(adminA, parent, "backrefs");
    const block = d.backrefs?.["in-thread"];
    expect(block?.edges.length).toBe(HYDRATE_PER_TYPE_CAP);
    expect(block?.has_more).toBe(true);
    expect(typeof block?.next_cursor).toBe("string");
  });
});

describe("GET /items/:id?include=neighbors — combined-set truncation signal", () => {
  it("flags neighbors_truncated when the combined set overflows even though every per-type block is below its cap", async () => {
    // Three edge types, 40 each = 120 neighbours. Each block (40) is under the
    // 50 per-type cap, so no block reports has_more — but the combined set
    // exceeds the 100-neighbour bound. This is the case the per-type has_more
    // cannot signal; only neighbors_truncated catches it.
    const per = 40;
    const parent = await create(adminA, "core.note", { body: "busy hub" });

    // 120 neighbour items in one bulk call: [0,40) children, [40,80) comments,
    // [80,120) attachments.
    const bulkItems = await request(ctx.app, "POST", "/items/bulk", {
      key: adminA,
      body: {
        items: Array.from({ length: per * 3 }, (_, i) => ({
          type: "core.note",
          properties: { body: `n${String(i)}` },
        })),
        mode: "create_only",
      },
    });
    expect(bulkItems.status).toBe(200);
    const { results } = (await bulkItems.json()) as {
      results: { index: number; id: string }[];
    };
    const ids = results
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((r) => r.id);

    const edges = [
      // parent-of: parent is source, child is target (outbound).
      ...ids.slice(0, per).map((cid) => ({
        source_id: parent,
        target_id: cid,
        edge_type: "parent-of",
      })),
      // in-thread + attached-to: the item is source, parent is target (inbound).
      ...ids.slice(per, per * 2).map((cid) => ({
        source_id: cid,
        target_id: parent,
        edge_type: "in-thread",
      })),
      ...ids.slice(per * 2, per * 3).map((cid) => ({
        source_id: cid,
        target_id: parent,
        edge_type: "attached-to",
      })),
    ];
    const bulkEdges = await request(ctx.app, "POST", "/edges/bulk", {
      key: adminA,
      body: { edges },
    });
    expect(bulkEdges.status).toBe(200);

    const d = await detail(adminA, parent, "backrefs,neighbors");
    // No single type is truncated...
    expect(d.item.edges?.["parent-of"]?.has_more).toBe(false);
    expect(d.backrefs?.["in-thread"]?.has_more).toBe(false);
    expect(d.backrefs?.["attached-to"]?.has_more).toBe(false);
    // ...but the combined neighbour set is, and only this flag says so.
    expect(d.neighbors_truncated).toBe(true);
    expect((d.neighbors ?? []).length).toBeLessThanOrEqual(100);
  });
});
