import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "trash-preview",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function note(by: MarfaClient = client): Promise<string> {
  const r = await by.createItem(createNote());
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function link(
  parent: string,
  child: string,
  edgeType = "parent-of",
): Promise<string> {
  const r = await client.createEdge({
    source_id: parent,
    target_id: child,
    edge_type: edgeType,
  });
  expect(r.status).toBe(201);
  trackEdge(ctx, r.data.edge.id);
  return r.data.edge.id;
}

async function mint(
  typePermissions: Record<string, "read" | "write">,
): Promise<MarfaClient> {
  const minted = await client.createKey({
    label: "trash-preview",
    source: `${ctx.source}-${String(Object.keys(typePermissions).length)}-${Object.values(typePermissions).join("")}`,
    permissions: [],
    type_permissions: typePermissions,
    edge_permissions: { "*": "read" },
  });
  expect(minted.ok).toBe(true);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

describe("GET /items/{id}/trash-preview", () => {
  it("names the item and everything a cascade would take with it, leaves first, and the delete then takes exactly that", async () => {
    const parent = await note();
    const first = await note();
    const second = await note();
    const grandchild = await note();
    await link(parent, first);
    await link(parent, second);
    await link(first, grandchild);

    const preview = await client.previewItemTrash(parent);
    expect(preview.status).toBe(200);
    const read = await client.getItem(parent);
    expect(preview.data.id).toBe(parent);
    expect(preview.data.type).toBe("core.note");
    expect(preview.data.version).toBe(read.data.item.version);
    expect(preview.data.count).toBe(4);
    expect(preview.data.truncated).toBeUndefined();
    const listed = preview.data.items.map((i) => i.id);
    expect([...listed].sort()).toEqual([first, second, grandchild].sort());
    expect(listed.indexOf(grandchild)).toBeLessThan(listed.indexOf(first));
    for (const entry of preview.data.items) {
      const now = await client.getItem(entry.id);
      expect(entry).toEqual({
        id: entry.id,
        type: "core.note",
        version: now.data.item.version,
      });
    }

    const deleted = await client.deleteItem(parent, {
      version: preview.data.version,
    });
    expect(deleted.status).toBe(200);
    const trashed = await client.listItems({
      state: "trashed",
      source: ctx.source,
      limit: 100,
    });
    expect(trashed.status).toBe(200);
    const inBin = trashed.data.data.map((i) => i.id);
    for (const id of [parent, ...listed]) expect(inBin).toContain(id);
  });

  it("writes nothing", async () => {
    const parent = await note();
    const child = await note();
    await link(parent, child);
    const before = await client.getItem(parent);

    expect((await client.previewItemTrash(parent)).status).toBe(200);

    for (const id of [parent, child]) {
      const after = await client.getItem(id);
      expect(after.status).toBe(200);
      expect(after.data.item.state).toBe("active");
    }
    expect((await client.getItem(parent)).data.item.version).toBe(
      before.data.item.version,
    );
  });

  it("neither lists nor counts an item beneath that the key cannot read", async () => {
    const writer = await mint({ "core.note": "write" });
    const parent = await note();
    const hidden = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(hidden.status).toBe(201);
    trackItem(ctx, hidden.data.item.id);
    await link(parent, hidden.data.item.id);

    // The witness: a key that reads bookmarks is told of it.
    const seen = await client.previewItemTrash(parent);
    expect(seen.status).toBe(200);
    expect(seen.data.items.map((i) => i.id)).toEqual([hidden.data.item.id]);
    expect(seen.data.count).toBe(2);

    const preview = await writer.previewItemTrash(parent);
    expect(preview.status).toBe(200);
    expect(preview.data.items).toEqual([]);
    expect(preview.data.count).toBe(1);
    expect(JSON.stringify(preview.data)).not.toContain(hidden.data.item.id);
  });

  it("refuses with the same edge_constraint_violation a delete is refused with, where a block edge holds the item", async () => {
    const edgeType = `mock.preview-block.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      label: "Preview block",
      id: edgeType,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(registered.ok).toBe(true);
    trackEdgeType(ctx, edgeType);
    const parent = await note();
    const child = await note();
    await link(parent, child);
    const blocker = await link(child, await note(), edgeType);

    const preview = await client.previewItemTrash(parent);
    const deleted = await client.deleteItem(parent);
    expect(preview.status).toBe(400);
    expect(deleted.status).toBe(400);
    expect(preview.error?.error.code).toBe("edge_constraint_violation");
    expect(preview.error?.error).toEqual(deleted.error?.error);
    expect(
      (
        preview.error?.error.details?.blocking_edges as Array<{ id: string }>
      ).map((e) => e.id),
    ).toEqual([blocker]);
  });

  it("refuses a key that may only read the item's type with 403 type_not_permitted", async () => {
    const reader = await mint({ "core.note": "read" });
    const parent = await note();

    const refused = await reader.previewItemTrash(parent);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");

    // The witness: the key that may write the type is answered.
    expect((await client.previewItemTrash(parent)).status).toBe(200);
  });

  it("answers 404 item_not_found for an item in the trash, and 400 invalid_id for an ID that is not one", async () => {
    const id = await note();
    expect((await client.previewItemTrash(id)).status).toBe(200);
    expect((await client.deleteItem(id)).status).toBe(200);

    const trashed = await client.previewItemTrash(id);
    expect(trashed.status).toBe(404);
    expect(trashed.error?.error.code).toBe("item_not_found");

    const invalid = await client.previewItemTrash("not-an-id");
    expect(invalid.status).toBe(400);
    expect(invalid.error?.error.code).toBe("invalid_id");
  });
});
