import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-refusals",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const UNKNOWN_ID = "00000000-0000-7000-8000-000000000000";

async function makeItem(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `er-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function makeEdge(
  source: string,
  target: string,
  edgeType = "about",
  properties?: Record<string, unknown>,
) {
  const r = await client.createEdge({
    source_id: source,
    target_id: target,
    edge_type: edgeType,
    ...(properties === undefined ? {} : { properties }),
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge;
}

async function keyClient(
  label: string,
  request: {
    type_permissions: Record<string, string>;
    edge_permissions: Record<string, string>;
  },
): Promise<MarfaClient> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    permissions: [],
    ...request,
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

describe("POST /edges refusals", () => {
  it("refuses a second edge naming a triple one already holds as a duplicate", async () => {
    const a = await makeItem("dup-a");
    const b = await makeItem("dup-b");
    const first = await makeEdge(a, b);

    const repeat = await client.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(repeat.status).toBe(400);
    expect(repeat.error?.error.code).toBe("edge_constraint_violation");
    expect(repeat.error?.error.details).toMatchObject({
      constraint: "duplicate",
      edge_type: "about",
      source_id: a,
      target_id: b,
    });

    // A fresh id names no held edge, so it is not a repeat of the first.
    const otherId = await client.createEdge({
      id: uuidv7(),
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(otherId.status).toBe(400);
    expect(otherId.error?.error.details?.constraint).toBe("duplicate");

    // The witness for the triple being what is refused: the same pair in the
    // other direction, and the same direction under another type, both land.
    const reverse = await makeEdge(b, a);
    const otherType = await makeEdge(a, b, "references");
    expect(new Set([first.id, reverse.id, otherType.id]).size).toBe(3);

    const held = await client.listItemEdges(a, { edge_type: "about" });
    expect(held.data.data.map((e) => e.id)).toEqual([first.id]);
  });

  it("answers an edge type nothing registered with edge_type_not_found", async () => {
    const a = await makeItem("unreg-a");
    const b = await makeItem("unreg-b");
    const unregistered = `mock.unregistered.${ctx.runId}`;

    const registered = `mock.registered.${ctx.runId}`;
    const reg = await client.registerEdgeType({
      id: registered,
      cardinality: "many-to-many",
    });
    expect(reg.status, JSON.stringify(reg.error)).toBe(201);
    trackEdgeType(ctx, registered);
    await makeEdge(a, b, registered);

    const refused = await client.createEdge({
      source_id: a,
      target_id: b,
      edge_type: unregistered,
    });
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("edge_type_not_found");

    const all = await client.listItemEdges(a);
    expect(all.data.data.map((e) => e.edge_type)).toEqual([registered]);

    // A key whose edge map does not reach the name is refused for its map
    // before the name is looked up.
    const narrow = await keyClient("unreg-narrow", {
      type_permissions: { "*": "write" },
      edge_permissions: { about: "write" },
    });
    const unreached = await narrow.createEdge({
      source_id: a,
      target_id: b,
      edge_type: unregistered,
    });
    expect(unreached.status).toBe(403);
    expect(unreached.error?.error.code).toBe("edge_permission_denied");
  });

  it("refuses a malformed source_id, target_id or edge id with invalid_id", async () => {
    const a = await makeItem("bad-id-a");
    const b = await makeItem("bad-id-b");

    const bodies = [
      { source_id: "not-an-id", target_id: b },
      { source_id: a, target_id: "not-an-id" },
      { id: "not-an-id", source_id: a, target_id: b },
    ];
    for (const body of bodies) {
      const r = await client.createEdge({ ...body, edge_type: "about" });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.error.code, JSON.stringify(body)).toBe("invalid_id");
    }

    // The same bodies with well-formed ids are accepted, so the refusals
    // above are the ids.
    const ok = await makeEdge(a, b);
    expect(ok.source_id).toBe(a);
    const held = await client.listItemEdges(a);
    expect(held.data.data.map((e) => e.id)).toEqual([ok.id]);
  });
});

describe("an edge named by an id that is malformed or unknown", () => {
  it("answers edge_not_found on read, update and delete, and touches no edge", async () => {
    const a = await makeItem("nf-a");
    const b = await makeItem("nf-b");
    const edge = await makeEdge(a, b);

    for (const id of ["not-an-id", "0123456789", UNKNOWN_ID]) {
      const read = await client.getEdge(id);
      expect(read.status, id).toBe(404);
      expect(read.error?.error.code, id).toBe("edge_not_found");

      const update = await client.updateEdge(id, {
        properties: { note: "no edge to write" },
        version: 1,
      });
      expect(update.status, id).toBe(404);
      expect(update.error?.error.code, id).toBe("edge_not_found");

      const removed = await client.deleteEdge(id);
      expect(removed.status, id).toBe(404);
      expect(removed.error?.error.code, id).toBe("edge_not_found");
    }

    // The witness: the same three operations answer for an edge that exists.
    const stored = await client.getEdge(edge.id);
    expect(stored.status).toBe(200);
    expect(stored.data.edge.version).toBe(1);
    const updated = await client.updateEdge(edge.id, {
      properties: { note: "written" },
      version: 1,
    });
    expect(updated.status).toBe(200);
    expect((await client.deleteEdge(edge.id)).status).toBe(200);
  });
});

describe("PATCH /edges/{id} versions and grants", () => {
  it("refuses a version other than the current one, lower or higher, and writes nothing", async () => {
    const a = await makeItem("ver-a");
    const b = await makeItem("ver-b");
    const created = await makeEdge(a, b);
    const advanced = await client.updateEdge(created.id, {
      properties: { n: 1 },
      version: created.version,
    });
    expect(advanced.status).toBe(200);
    const current = advanced.data.edge.version;
    expect(current).toBe(2);

    for (const version of [current - 1, current + 1, current + 100]) {
      const r = await client.updateEdge(created.id, {
        properties: { n: 99 },
        version,
      });
      expect(r.status, `version ${String(version)}`).toBe(409);
      expect(r.error?.error.code).toBe("version_conflict");
      const body = r.error as unknown as {
        current?: { id: string; version: number };
      };
      expect(body.current?.id).toBe(created.id);
      expect(body.current?.version).toBe(current);
    }

    const stored = await client.getEdge(created.id);
    expect(stored.data.edge.version).toBe(current);
    expect(stored.data.edge.properties).toEqual({ n: 1 });

    // The witness: the current version lands.
    const landed = await client.updateEdge(created.id, {
      properties: { n: 2 },
      version: current,
    });
    expect(landed.status).toBe(200);
    expect(landed.data.edge.version).toBe(current + 1);
  });

  it("answers a stale edge update with the edge as it stands and none of ancestor, conflicting_fields or merge_policy", async () => {
    const a = await makeItem("shape-a");
    const b = await makeItem("shape-b");
    const created = await makeEdge(a, b, "about", { note: "original" });
    const advanced = await client.updateEdge(created.id, {
      properties: { note: "winner" },
      version: created.version,
    });
    expect(advanced.status).toBe(200);

    for (const version of [0, created.version]) {
      const label = `version ${String(version)}`;
      const stale = await client.updateEdge(created.id, {
        properties: { note: "loser" },
        version,
      });
      expect(stale.status, label).toBe(409);
      expect(stale.headers.get("x-error-code"), label).toBe("version_conflict");
      const body = stale.error as unknown as Record<string, unknown> & {
        error: { code: string; status: number };
        current: { id: string };
      };
      expect(body.error.code, label).toBe("version_conflict");
      expect(body.error.status, label).toBe(409);
      expect(body.current, label).toEqual(advanced.data.edge);
      for (const absent of ["ancestor", "conflicting_fields", "merge_policy"]) {
        expect(body, `${label}: ${absent}`).not.toHaveProperty(absent);
      }
    }
  });

  it("names version in details.field where an update names none, and asks for it before it looks for the edge", async () => {
    const a = await makeItem("field-a");
    const b = await makeItem("field-b");
    const created = await makeEdge(a, b);

    for (const id of [created.id, UNKNOWN_ID]) {
      const refused = await client.rawRequest(`/edges/${id}`, {
        method: "PATCH",
        body: { properties: { note: "no version named" } },
      });
      expect(refused.status, id).toBe(400);
      expect(refused.error?.error.code, id).toBe("missing_required_field");
      expect(refused.error?.error.details?.field, id).toBe("version");
    }

    // The witness: the unknown id is refused as unknown once it names a
    // version, so the 400 above came first.
    const unknown = await client.updateEdge(UNKNOWN_ID, {
      properties: { note: "x" },
      version: 1,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("edge_not_found");
  });

  it("refuses an update and a delete from a key that reads the edge but may not write its type", async () => {
    const a = await makeItem("grant-a");
    const b = await makeItem("grant-b");
    const edge = await makeEdge(a, b, "references", { note: "kept" });

    const reader = await keyClient("edge-reader", {
      type_permissions: { "*": "write" },
      edge_permissions: { references: "read" },
    });
    // Reads the edge, so the refusals below are for its write and not an
    // edge the key cannot see.
    const seen = await reader.getEdge(edge.id);
    expect(seen.status).toBe(200);

    const update = await reader.updateEdge(edge.id, {
      properties: { note: "changed" },
      version: edge.version,
    });
    expect(update.status).toBe(403);
    expect(update.error?.error.code).toBe("edge_permission_denied");
    expect(update.error?.error.details?.edge_type).toBe("references");

    const removed = await reader.deleteEdge(edge.id);
    expect(removed.status).toBe(403);
    expect(removed.error?.error.code).toBe("edge_permission_denied");
    expect(removed.error?.error.details?.edge_type).toBe("references");

    const untouched = await client.getEdge(edge.id);
    expect(untouched.data.edge.version).toBe(edge.version);
    expect(untouched.data.edge.properties).toEqual({ note: "kept" });

    // The witness: a key holding write on the same type, with the same type
    // grants, is allowed both.
    const writer = await keyClient("edge-writer", {
      type_permissions: { "*": "write" },
      edge_permissions: { references: "write" },
    });
    const allowed = await writer.updateEdge(edge.id, {
      properties: { note: "changed" },
      version: edge.version,
    });
    expect(allowed.status).toBe(200);
    expect((await writer.deleteEdge(edge.id)).status).toBe(200);
    expect((await client.getEdge(edge.id)).status).toBe(404);
  });
});
