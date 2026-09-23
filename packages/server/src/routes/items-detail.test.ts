/**
 * GET /items/:id?include=backrefs,neighbors,versions — the 1-hop neighborhood
 * read that collapses an open-a-detail fan-out into one request.
 *
 * Coverage:
 *  - the base shape (item + outbound edges + metadata) is unchanged when no
 *    include is passed;
 *  - `backrefs` hydrates inbound edges grouped by type, with per-type cap +
 *    pagination signaling;
 *  - `neighbors` hydrates the far-end items of the requested edge blocks, each
 *    with its metadata;
 *  - neighbor hydration is NOT an access-control bypass: a neighbor the
 *    caller cannot read by type is silently omitted, never leaked;
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

let adminA: string;
// Reads core.note only — used to prove a neighbor of an unreadable type is
// omitted rather than leaked through the bundle.
let noteReaderA: string;

async function mintKey(
  label: string,
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
      // No permission is named because no door here asks for one: the
      // item read, the edge writes and the neighbor hydration are all decided
      // by the two maps below.
      default_tier: "library",
      type_permissions: opts.type_permissions ?? { "*": "write" },
      edge_permissions: opts.edge_permissions ?? { "*": "write" },
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
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
  data: {
    id: string;
    source_id: string;
    target_id: string;
    edge_type: string;
  }[];
  next_cursor: string | null;
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
  adminA = await mintKey("detail-admin-a");
  noteReaderA = await mintKey("detail-note-reader-a", {
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
    expect(d.item.edges?.["parent-of"]?.data.length).toBe(1);
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
    expect(d.backrefs?.["in-thread"]?.data.length).toBe(1);
    expect(d.backrefs?.["in-thread"]?.data[0]?.source_id).toBe(comment);
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
    // A small, fully-hydrated neighborhood is not truncated.
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
    // neighborhood the caller may not fully read is indistinguishable from
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
});

describe("GET /items/:id?include=versions", () => {
  it("returns version snapshots only when requested", async () => {
    const item = await create(adminA, "core.note", { body: "v1" });
    const updated = await request(ctx.app, "PATCH", `/items/${item}`, {
      key: adminA,
      body: { properties: { body: "v2" }, version: 1 },
    });
    expect(updated.status).toBe(200);

    const without = await detail(adminA, item);
    expect(without.versions).toBeUndefined();

    const withVersions = await detail(adminA, item, "versions");
    expect(Array.isArray(withVersions.versions)).toBe(true);
    expect((withVersions.versions ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /items/:id?include=backrefs — per-type pagination", () => {
  it("caps each inbound type and carries a cursor past the cap", async () => {
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
    expect(block?.data.length).toBe(HYDRATE_PER_TYPE_CAP);
    expect(block?.next_cursor).not.toBeNull();
    expect(typeof block?.next_cursor).toBe("string");
  });
});

describe("GET /items/:id?include=neighbors — combined-set truncation signal", () => {
  it("flags neighbors_truncated when the combined set overflows even though every per-type block is below its cap", async () => {
    // Three edge types, 40 each = 120 neighbors. Each block (40) is under the
    // 50 per-type cap, so no block carries a cursor — but the combined set
    // exceeds the 100-neighbor bound. This is the case the per-type cursor
    // cannot signal; only neighbors_truncated catches it.
    const per = 40;
    const parent = await create(adminA, "core.note", { body: "busy hub" });

    // 120 neighbor items in one bulk call: [0,40) children, [40,80) comments,
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
    expect(d.item.edges?.["parent-of"]?.next_cursor).toBeNull();
    expect(d.backrefs?.["in-thread"]?.next_cursor).toBeNull();
    expect(d.backrefs?.["attached-to"]?.next_cursor).toBeNull();
    // ...but the combined neighbor set is, and only this flag says so.
    expect(d.neighbors_truncated).toBe(true);
    expect((d.neighbors ?? []).length).toBeLessThanOrEqual(100);
  });
});
