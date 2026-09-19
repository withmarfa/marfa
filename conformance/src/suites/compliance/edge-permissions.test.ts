import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
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
    "edge-permissions",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeKey(
  label: string,
  opts: {
    type_permissions: Record<string, string>;
    edge_permissions?: Record<string, string>;
    spacePermissions?: readonly string[];
  },
): Promise<{ key: string; id: string }> {
  const resp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: opts.type_permissions,
    edge_permissions: opts.edge_permissions,
    space_permissions: opts.spacePermissions ?? [],
  });
  expect(resp.ok).toBe(true);
  trackKey(ctx, resp.data.id);
  return { key: resp.data.key, id: resp.data.id };
}

async function scopedItem(c: MarfaClient, label: string): Promise<string> {
  const r = await c.createItem(
    createNote({ properties: { body: `ep-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("per-edge-type permissions", () => {
  it("dual-gate: source-type write + edge-type write required", async () => {
    const noEdgeScope = await makeKey("no-edge-scope", {
      type_permissions: { "*": "write" },
    });
    const noEdgeClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: noEdgeScope.key,
    });

    const a = await scopedItem(noEdgeClient, "a");
    const b = await scopedItem(noEdgeClient, "b");

    const r1 = await noEdgeClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(r1.ok).toBe(false);
    expect(r1.status).toBe(403);
    expect(r1.error?.error.code).toBe("edge_permission_denied");

    const noTypeScope = await makeKey("no-type-scope", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "write" },
    });
    const noTypeClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: noTypeScope.key,
    });

    const r2 = await noTypeClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe(403);
    expect(r2.error?.error.code).toBe("type_not_permitted");

    const bothScopes = await makeKey("both-scopes", {
      type_permissions: { "*": "write" },
      edge_permissions: { about: "write" },
    });
    const bothClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: bothScopes.key,
    });
    const a2 = await scopedItem(bothClient, "a2");
    const b2 = await scopedItem(bothClient, "b2");
    const r3 = await bothClient.createEdge({
      source_id: a2,
      target_id: b2,
      edge_type: "about",
    });
    expect(r3.ok).toBe(true);
    trackEdge(ctx, r3.data.edge.id);
  });

  it("a key holding every edge type creates any edge", async () => {
    const a = await scopedItem(client, "adm-a");
    const b = await scopedItem(client, "adm-b");

    const r = await client.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "parent-of",
    });
    expect(r.ok).toBe(true);
    trackEdge(ctx, r.data.edge.id);
  });

  it("narrow scope: key with edge.about:write cannot create parent-of edges", async () => {
    const narrow = await makeKey("narrow-about-only", {
      type_permissions: { "*": "write" },
      edge_permissions: { about: "write" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    const a = await scopedItem(narrowClient, "narrow-a");
    const b = await scopedItem(narrowClient, "narrow-b");

    const about = await narrowClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(about.ok).toBe(true);
    trackEdge(ctx, about.data.edge.id);

    const po = await narrowClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "parent-of",
    });
    expect(po.ok).toBe(false);
    expect(po.status).toBe(403);
    expect(po.error?.error.code).toBe("edge_permission_denied");
  });

  it("wildcard edge_permissions: edge.*:write creates any edge type", async () => {
    const wild = await makeKey("wildcard", {
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    });
    const wildClient = new MarfaClient({ baseUrl: apiUrl, apiKey: wild.key });

    const a = await scopedItem(wildClient, "w-a");

    for (const edgeType of [
      "about",
      "parent-of",
      "authored-by",
      "attached-to",
    ]) {
      const target = await scopedItem(wildClient, `w-t-${edgeType}`);
      const r = await wildClient.createEdge({
        source_id: a,
        target_id: target,
        edge_type: edgeType,
      });
      expect(r.ok).toBe(true);
      trackEdge(ctx, r.data.edge.id);
    }
  });

  // The type-permission gate on an edge write reads the source item whether
  // it is live or trashed.
  it("trashed source: PATCH/DELETE edge still gated on source type", async () => {
    // Register two custom types so we can gate a key strictly on the target
    // type without granting core.note blanket access through wildcards.
    const sourceType = `user.evaluator-edgesrc-${ctx.runId}`;
    const targetType = `user.evaluator-edgetgt-${ctx.runId}`;
    await client.registerType({
      id: sourceType,
      fields: { title: { type: "string", required: true } },
    });
    await client.registerType({
      id: targetType,
      fields: { title: { type: "string", required: true } },
    });

    const srcResp = await client.createItem({
      type: sourceType,
      properties: { title: "src" },
      source: ctx.source,
    });
    expect(srcResp.ok).toBe(true);
    trackItem(ctx, srcResp.data.item.id);

    const tgtResp = await client.createItem({
      type: targetType,
      properties: { title: "tgt" },
      source: ctx.source,
    });
    expect(tgtResp.ok).toBe(true);
    trackItem(ctx, tgtResp.data.item.id);

    const edge = await client.createEdge({
      source_id: srcResp.data.item.id,
      target_id: tgtResp.data.item.id,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const trash = await client.deleteItem(srcResp.data.item.id);
    expect(trash.ok).toBe(true);

    // Key scoped to the TARGET type only (plus edge.about read/write so the
    // dual-gate on edge-type isn't what denies). No access to source type.
    const targetOnly = await makeKey("target-only", {
      type_permissions: { [targetType]: "write" },
      edge_permissions: { about: "write" },
    });
    const targetOnlyClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: targetOnly.key,
    });

    const patch = await targetOnlyClient.updateEdge(edge.data.edge.id, {
      properties: { note: "should not land" },
      version: edge.data.edge.version,
    });
    expect(patch.ok).toBe(false);
    expect(patch.status).toBe(403);
    expect(patch.error?.error.code).toBe("type_not_permitted");

    const del = await targetOnlyClient.deleteEdge(edge.data.edge.id);
    expect(del.ok).toBe(false);
    expect(del.status).toBe(403);
    expect(del.error?.error.code).toBe("type_not_permitted");

    const sourceOnly = await makeKey("source-only", {
      type_permissions: { [sourceType]: "write", [targetType]: "read" },
      edge_permissions: { about: "write" },
    });
    const sourceOnlyClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: sourceOnly.key,
    });

    const patchOk = await sourceOnlyClient.updateEdge(edge.data.edge.id, {
      properties: { note: "ok" },
      version: edge.data.edge.version,
    });
    expect(patchOk.ok).toBe(true);

    const delOk = await sourceOnlyClient.deleteEdge(edge.data.edge.id);
    expect(delOk.ok).toBe(true);
  });

  it("edge read scope: key with edge.about:read can list but not write", async () => {
    const source = await scopedItem(client, "read-src");
    const target = await scopedItem(client, "read-tgt");
    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    // Write on every item type, so the refusal below can only come from the
    // edge map: the source-type gate runs first and would answer instead.
    const readOnly = await makeKey("read-only-edge", {
      type_permissions: { "*": "write" },
      edge_permissions: { about: "read" },
    });
    const readClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: readOnly.key,
    });

    const list = await readClient.listItemEdges(source, { edge_type: "about" });
    expect(list.ok).toBe(true);
    expect(list.data.data.some((e) => e.id === edge.data.edge.id)).toBe(true);

    const write = await readClient.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(write.ok).toBe(false);
    expect(write.status).toBe(403);
    expect(write.error?.error.code).toBe("edge_permission_denied");
  });
});
