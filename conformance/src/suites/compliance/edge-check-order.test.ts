/**
 * The order `POST /edges` asks its refusals in. Each test sends one request
 * that meets two adjacent refusals and asserts the earlier answer, then
 * shows the later refusal fires when the request meets it alone.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackFolder,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import {
  createBookmark,
  createNote,
  generateId,
} from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let keyCount = 0;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-check-order",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function note(): Promise<string> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function bookmark(): Promise<string> {
  const r = await client.createItem(createBookmark({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function folder(): Promise<string> {
  const r = await client.createFolder({ title: `order-${ctx.runId}` });
  expect(r.status).toBe(201);
  trackFolder(ctx, r.data.item.id);
  return r.data.item.id;
}

async function binned(id: string): Promise<void> {
  expect((await client.deleteItem(id)).status).toBe(200);
}

async function keyWith(
  typePermissions: Record<string, "read" | "write">,
  edgePermissions: Record<string, "read" | "write">,
): Promise<MarfaClient> {
  keyCount += 1;
  const minted = await client.createKey({
    label: `edge-check-order-${String(keyCount)}`,
    source: `${ctx.source}-edge-check-order-${String(keyCount)}`,
    permissions: [],
    type_permissions: typePermissions,
    edge_permissions: edgePermissions,
  });
  expect(minted.ok).toBe(true);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

async function edgeTypeOf(
  label: string,
  rest: {
    cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
    source_type_constraints?: string[];
    target_type_constraints?: string[];
  },
): Promise<string> {
  const id = `mock.order-${label}.${ctx.runId}`;
  const r = await client.registerEdgeType({ id, ...rest });
  expect(r.status).toBe(201);
  trackEdgeType(ctx, id);
  return id;
}

async function held(
  source: string,
  target: string,
  edgeType: string,
  id?: string,
): Promise<string> {
  const r = await client.createEdge({
    ...(id !== undefined && { id }),
    source_id: source,
    target_id: target,
    edge_type: edgeType,
  });
  expect(r.status).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge.id;
}

describe("the order POST /edges asks its refusals in", () => {
  it("refuses a malformed id before it looks for the source", async () => {
    const target = await note();
    const absent = generateId();
    for (const body of [
      { source_id: "not-an-id", target_id: target },
      { source_id: absent, target_id: "not-an-id" },
      { source_id: absent, target_id: target, id: "not-an-id" },
    ]) {
      const r = await client.createEdge({ ...body, edge_type: "about" });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.error.code, JSON.stringify(body)).toBe("invalid_id");
    }

    // The witness: well formed ids with the same absent source are a not-found.
    const alone = await client.createEdge({
      source_id: absent,
      target_id: target,
      edge_type: "about",
    });
    expect(alone.status).toBe(404);
    expect(alone.error?.error.code).toBe("item_not_found");
  });

  it("answers a source in the bin as missing before it asks for write on the source's type", async () => {
    const reader = await keyWith({ "core.note": "read" }, { about: "write" });
    const source = await note();
    const target = await note();

    // The witness: while the source is live, the same key is refused the write.
    const live = await reader.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(live.status).toBe(403);
    expect(live.error?.error.code).toBe("type_not_permitted");
    expect((await reader.getItem(source)).status).toBe(200);

    await binned(source);
    const gone = await reader.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(gone.status).toBe(404);
    expect(gone.error?.error.code).toBe("item_not_found");
  });

  it("refuses write on the source's type before write on the edge type", async () => {
    const source = await note();
    const target = await note();
    const neither = await keyWith({ "core.note": "read" }, { about: "read" });
    const both = await neither.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(both.status).toBe(403);
    expect(both.error?.error.code).toBe("type_not_permitted");

    // The witness: write on the type leaves the edge type's refusal alone.
    const typeOnly = await keyWith({ "core.note": "write" }, { about: "read" });
    const alone = await typeOnly.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(alone.status).toBe(403);
    expect(alone.error?.error.code).toBe("edge_permission_denied");
  });

  it("refuses write on the edge type before it recognizes a repeated edge id", async () => {
    const source = await note();
    const target = await note();
    const id = generateId();
    await held(source, target, "about", id);
    const repeat = {
      id,
      source_id: source,
      target_id: target,
      edge_type: "about",
    };

    const readOnly = await keyWith({ "core.note": "write" }, { about: "read" });
    const refused = await readOnly.createEdge(repeat);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("edge_permission_denied");

    // The witness: a key with the grant is told the edge is already held.
    const writer = await keyWith({ "core.note": "write" }, { about: "write" });
    const again = await writer.createEdge(repeat);
    expect(again.status).toBe(200);
    expect(again.data.acknowledged).toBe(true);
    expect(again.data.edge.id).toBe(id);
  });

  it("refuses a reused edge id before it looks up the edge type", async () => {
    const source = await note();
    const target = await note();
    const id = generateId();
    await held(source, target, "about", id);
    const unknown = `mock.order-unknown.${ctx.runId}`;

    const reused = await client.createEdge({
      id,
      source_id: source,
      target_id: target,
      edge_type: unknown,
    });
    expect(reused.status).toBe(409);
    expect(reused.error?.error.code).toBe("id_reused");
    expect(reused.error?.error.details?.differs).toEqual(["edge_type"]);

    // The witness: a fresh id with the same unknown type is the type's refusal.
    const alone = await client.createEdge({
      id: generateId(),
      source_id: source,
      target_id: target,
      edge_type: unknown,
    });
    expect(alone.status).toBe(404);
    expect(alone.error?.error.code).toBe("edge_type_not_found");
  });

  it("answers an unknown edge type before it judges a self-loop", async () => {
    const item = await note();
    const unknown = await client.createEdge({
      source_id: item,
      target_id: item,
      edge_type: `mock.order-unknown.${ctx.runId}`,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("edge_type_not_found");

    // The witness: a known type on the same ends is the self-loop's refusal.
    const loop = await client.createEdge({
      source_id: item,
      target_id: item,
      edge_type: "about",
    });
    expect(loop.status).toBe(400);
    expect(loop.error?.error.code).toBe("edge_cycle");
  });

  it("refuses a self-loop before it checks properties", async () => {
    const dir = await folder();
    const item = await note();
    const loop = await client.createEdge({
      source_id: item,
      target_id: item,
      edge_type: "in-folder",
    });
    expect(loop.status).toBe(400);
    expect(loop.error?.error.code).toBe("edge_cycle");

    // The witness: other ends with the same missing path are the property's refusal.
    const alone = await client.createEdge({
      source_id: item,
      target_id: dir,
      edge_type: "in-folder",
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("validation_error");
  });

  it("refuses bad properties before it looks for the target", async () => {
    const source = await note();
    const absent = generateId();
    const bad = await client.createEdge({
      source_id: source,
      target_id: absent,
      edge_type: "in-folder",
      properties: { path: "../outside.md" },
    });
    expect(bad.status).toBe(400);
    expect(bad.error?.error.code).toBe("validation_error");

    // The witness: a good path to the same absent target is a not-found.
    const alone = await client.createEdge({
      source_id: source,
      target_id: absent,
      edge_type: "in-folder",
      properties: { path: "Notes/inside.md" },
    });
    expect(alone.status).toBe(404);
    expect(alone.error?.error.code).toBe("item_not_found");
  });

  it("refuses bad properties before it checks the endpoint types", async () => {
    const source = await note();
    const notAFolder = await note();
    const bad = await client.createEdge({
      source_id: source,
      target_id: notAFolder,
      edge_type: "in-folder",
      properties: { path: "../outside.md" },
    });
    expect(bad.status).toBe(400);
    expect(bad.error?.error.code).toBe("validation_error");

    // The witness: a good path to the same target is the endpoint's refusal.
    const alone = await client.createEdge({
      source_id: source,
      target_id: notAFolder,
      edge_type: "in-folder",
      properties: { path: "Notes/inside.md" },
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("edge_constraint_violation");
  });

  it("answers a missing target before it checks the endpoint types", async () => {
    const edgeType = await edgeTypeOf("endpoints-missing", {
      cardinality: "many-to-many",
      source_type_constraints: ["core.bookmark"],
    });
    const source = await note();
    const missing = await client.createEdge({
      source_id: source,
      target_id: generateId(),
      edge_type: edgeType,
    });
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("item_not_found");

    // The witness: with a target present, the same source meets the constraint.
    const alone = await client.createEdge({
      source_id: source,
      target_id: await note(),
      edge_type: edgeType,
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("edge_constraint_violation");
    expect(alone.error?.error.details?.source_type).toBe("core.note");
  });

  it("answers a missing target as forbidden when the key lacks write on the edge type", async () => {
    const source = await note();
    const absent = generateId();
    const readOnly = await keyWith({ "core.note": "write" }, { about: "read" });
    const refused = await readOnly.createEdge({
      source_id: source,
      target_id: absent,
      edge_type: "about",
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("edge_permission_denied");

    // The witness: a key with the grant meets the missing target.
    const writer = await keyWith({ "core.note": "write" }, { about: "write" });
    const alone = await writer.createEdge({
      source_id: source,
      target_id: absent,
      edge_type: "about",
    });
    expect(alone.status).toBe(404);
    expect(alone.error?.error.code).toBe("item_not_found");
  });

  it("checks the source's type before the target's type", async () => {
    const edgeType = await edgeTypeOf("endpoints-both", {
      cardinality: "many-to-many",
      source_type_constraints: ["core.bookmark"],
      target_type_constraints: ["core.bookmark"],
    });
    const both = await client.createEdge({
      source_id: await note(),
      target_id: await note(),
      edge_type: edgeType,
    });
    expect(both.status).toBe(400);
    expect(both.error?.error.code).toBe("edge_constraint_violation");
    expect(both.error?.error.details?.source_type).toBe("core.note");
    expect(both.error?.error.details?.target_type).toBeUndefined();

    // The witness: a source of the right type meets the target's constraint.
    const alone = await client.createEdge({
      source_id: await bookmark(),
      target_id: await note(),
      edge_type: edgeType,
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("edge_constraint_violation");
    expect(alone.error?.error.details?.target_type).toBe("core.note");
  });

  it("refuses an endpoint type before it names a duplicate", async () => {
    // A type deleted with force leaves its edges, and registering it again
    // with a constraint leaves a held edge the constraint now refuses.
    const edgeType = await edgeTypeOf("endpoints-duplicate", {
      cardinality: "many-to-many",
    });
    const source = await note();
    const target = await note();
    await held(source, target, edgeType);
    expect((await client.deleteEdgeType(edgeType, true)).status).toBe(200);
    const again = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
      source_type_constraints: ["core.bookmark"],
    });
    expect(again.status).toBe(201);

    const refused = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("edge_constraint_violation");
    expect(refused.error?.error.details?.source_type).toBe("core.note");

    // The witness: a held edge the constraint admits is a duplicate.
    const admitted = await bookmark();
    await held(admitted, target, edgeType);
    const duplicate = await client.createEdge({
      source_id: admitted,
      target_id: target,
      edge_type: edgeType,
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.error?.error.code).toBe("edge_constraint_violation");
    expect(duplicate.error?.error.details?.constraint).toBe("duplicate");
  });

  it("names a duplicate before cardinality", async () => {
    const edgeType = await edgeTypeOf("duplicate-cardinality", {
      cardinality: "one-to-one",
    });
    const source = await note();
    const target = await note();
    await held(source, target, edgeType);

    const duplicate = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.error?.error.code).toBe("edge_constraint_violation");
    expect(duplicate.error?.error.details?.constraint).toBe("duplicate");

    // The witness: another target for the same source is the cardinality's refusal.
    const alone = await client.createEdge({
      source_id: source,
      target_id: await note(),
      edge_type: edgeType,
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("edge_constraint_violation");
    expect(alone.error?.error.details?.constraint).toBe("cardinality");
  });

  it("refuses cardinality before a cycle", async () => {
    // top holds middle holds bottom. Making bottom the parent of middle
    // meets both rules: middle already has a parent, and the edge closes a loop.
    const top = await note();
    const middle = await note();
    const bottom = await note();
    await held(top, middle, "parent-of");
    await held(middle, bottom, "parent-of");
    const both = await client.createEdge({
      source_id: bottom,
      target_id: middle,
      edge_type: "parent-of",
    });
    expect(both.status).toBe(400);
    expect(both.error?.error.code).toBe("edge_constraint_violation");
    expect(both.error?.error.details?.constraint).toBe("cardinality");

    // The witness: with no parent above it, the same shape closes a loop alone.
    const root = await note();
    const leaf = await note();
    await held(root, leaf, "parent-of");
    const alone = await client.createEdge({
      source_id: leaf,
      target_id: root,
      edge_type: "parent-of",
    });
    expect(alone.status).toBe(400);
    expect(alone.error?.error.code).toBe("edge_cycle");
  });

  it("answers a repeated edge id as missing when its source is now in the bin", async () => {
    const source = await note();
    const target = await note();
    const id = generateId();
    await held(source, target, "about", id);
    const repeat = {
      id,
      source_id: source,
      target_id: target,
      edge_type: "about",
    };

    // The witness: while the source is live, the repeat is acknowledged.
    const live = await client.createEdge(repeat);
    expect(live.status).toBe(200);
    expect(live.data.acknowledged).toBe(true);

    await binned(source);
    const gone = await client.createEdge(repeat);
    expect(gone.status).toBe(404);
    expect(gone.error?.error.code).toBe("item_not_found");
  });
});
