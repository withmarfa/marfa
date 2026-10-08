/**
 * `GET /edges/{id}`.
 *
 * Every other addressable row in this API reads back by its own id; an edge
 * did not. The ways to read one were every edge filtered by type, or an
 * item's outbound or inbound listing -- and both of those need an endpoint
 * the caller may not have. A synced client holding a queued update that was
 * refused, or an event that arrived before its endpoints did, had an id it
 * could only resolve by scanning.
 *
 * The route is a read, so what needs proving is mostly refusals: the two
 * gates the write paths apply, at `read`, and the same 404 cloak. The gate
 * that is easy to get wrong is the source item's, because a trashed source
 * reads back as null and a null source skips the check rather than failing
 * it -- which would turn trashing an item into a way to disclose its
 * relationships.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;

let keyA: string;

interface EdgeBody {
  edge: {
    id: string;
    source_id: string;
    target_id: string;
    edge_type: string;
    properties: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    version: number;
  };
}
interface ErrorBody {
  error: { code: string };
}

async function mintKey(
  over: {
    type_permissions?: Record<string, "read" | "write" | "none">;
    edge_permissions?: Record<string, "read" | "write">;
  } = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  let raw = `marfa_k1_edge_read_${suffix}`;
  raw = await mintWorkingKey(ctx, {
    permissions: [],
    extension_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    label: `edge-read-${suffix}`,
    source: `edge-read-${suffix}`,
    default_tier: "library",
    type_permissions: over.type_permissions ?? { "*": "write" },
    edge_permissions: over.edge_permissions ?? { "*": "write" },
  });
  return raw;
}

async function createNote(key: string, type = "core.note"): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: { type, properties: { body: `n-${Math.random().toString(36)}` } },
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { item: { id: string } };
  return data.item.id;
}

async function createEdge(
  key: string,
  sourceType = "core.note",
): Promise<{ id: string; source: string; target: string }> {
  const source = await createNote(key, sourceType);
  const target = await createNote(key);
  const res = await request(ctx.app, "POST", "/edges", {
    key,
    body: {
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties: { note: "why these two are related" },
    },
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as EdgeBody;
  return { id: data.edge.id, source, target };
}

beforeAll(async () => {
  ctx = await createTestContext();
  keyA = await mintKey();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /edges/:id", () => {
  it("returns the edge the create route returned", async () => {
    const { id, source, target } = await createEdge(keyA);
    const res = await request(ctx.app, "GET", `/edges/${id}`, { key: keyA });
    expect(res.status).toBe(200);
    const data = (await res.json()) as EdgeBody;
    expect(data.edge.id).toBe(id);
    expect(data.edge.source_id).toBe(source);
    expect(data.edge.target_id).toBe(target);
    expect(data.edge.edge_type).toBe("about");
    expect(data.edge.properties).toEqual({
      note: "why these two are related",
    });
    expect(typeof data.edge.version).toBe("number");
  });

  it("answers with the same shape the item's edge listing does", async () => {
    // One edge, two doors. The shape is declared once now, and this is what
    // says so from outside the type system: a field present on one read and
    // absent from the other is exactly the drift that made the wire shape
    // worth consolidating.
    const { id, source } = await createEdge(keyA);
    const direct = (await (
      await request(ctx.app, "GET", `/edges/${id}`, { key: keyA })
    ).json()) as EdgeBody;
    const viaItem = (await (
      await request(ctx.app, "GET", `/items/${source}/edges`, { key: keyA })
    ).json()) as { data: EdgeBody["edge"][] };
    const listed = viaItem.data.find((e) => e.id === id);
    expect(listed).toBeDefined();
    expect(Object.keys(direct.edge).sort()).toEqual(
      Object.keys(listed ?? {}).sort(),
    );
    expect(direct.edge).toEqual(listed);
  });

  it("404s an id that does not exist", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/edges/019d0000-0000-7000-a000-00000000dead",
      { key: keyA },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("edge_not_found");
  });

  it("rejects an unauthenticated read", async () => {
    const { id } = await createEdge(keyA);
    const res = await request(ctx.app, "GET", `/edges/${id}`);
    expect(res.status).toBe(401);
  });

  it("answers a caller without read on the source item's type as it answers no edge", async () => {
    const { id } = await createEdge(keyA);
    const key = await mintKey({
      type_permissions: { "core.file": "read" },
      edge_permissions: { "*": "read" },
    });
    const res = await request(ctx.app, "GET", `/edges/${id}`, { key });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("edge_not_found");
  });

  it("answers a caller without read on the edge type as it answers no edge", async () => {
    const { id } = await createEdge(keyA);
    const key = await mintKey({
      type_permissions: { "*": "read" },
      edge_permissions: { "in-thread": "read" },
    });
    const res = await request(ctx.app, "GET", `/edges/${id}`, { key });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("edge_not_found");
  });

  it("still applies the source-type gate when the source item is trashed", async () => {
    // A null source skips the check, so reading past the trash is what keeps
    // a trashed item from disclosing what it is related to.
    const { id, source } = await createEdge(keyA);
    const trashed = await request(
      ctx.app,
      "POST",
      `/items/${source}/transition`,
      { key: keyA, body: { state: "trashed" } },
    );
    expect(trashed.status).toBe(200);
    const key = await mintKey({
      type_permissions: { "core.file": "read" },
      edge_permissions: { "*": "read" },
    });
    const res = await request(ctx.app, "GET", `/edges/${id}`, { key });
    expect(res.status).toBe(404);
  });

  it("reads an edge whose source item is trashed, for a caller allowed to", async () => {
    // The gate is about permission, not about lifecycle. An edge off a
    // trashed item is still readable by someone who may read it -- which is
    // the case a client resolving a stale id is usually in.
    const { id, source } = await createEdge(keyA);
    await request(ctx.app, "POST", `/items/${source}/transition`, {
      key: keyA,
      body: { state: "trashed" },
    });
    const res = await request(ctx.app, "GET", `/edges/${id}`, { key: keyA });
    expect(res.status).toBe(200);
    expect(((await res.json()) as EdgeBody).edge.id).toBe(id);
  });
});
