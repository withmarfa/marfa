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
import { expectMatchesSchema } from "../../utils/openapi.js";

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

/** The preview of one item, with that item's entry beside the whole. */
async function previewOne(id: string, by: MarfaClient = client) {
  const r = await by.previewItemTrash([id]);
  return { ...r, item: r.data?.items?.[0] };
}

async function state(id: string): Promise<number> {
  return (await client.getItem(id)).status;
}

let sharesType: string | undefined;

/** A cascading edge type that lets a child hang from several items, which
 *  `parent-of` does not. */
async function shares(): Promise<string> {
  if (sharesType) return sharesType;
  const id = `mock.shares.${ctx.runId}`;
  const r = await client.registerEdgeType({
    id,
    label: "Shares",
    cardinality: "many-to-many",
    cascade_on_delete: "cascade",
  });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  trackEdgeType(ctx, id);
  sharesType = id;
  return id;
}

/** Two items whose trash each takes one shared child. */
async function sharing(): Promise<{ a: string; b: string; shared: string }> {
  const a = await note();
  const b = await note();
  const shared = await note();
  const edgeType = await shares();
  await link(a, shared, edgeType);
  await link(b, shared, edgeType);
  return { a, b, shared };
}

describe("POST /items/trash-preview", () => {
  it("names the item and everything a cascade would take with it, leaves first, and the trash then takes exactly that", async () => {
    const parent = await note();
    const first = await note();
    const second = await note();
    const grandchild = await note();
    await link(parent, first);
    await link(parent, second);
    await link(first, grandchild);

    const preview = await previewOne(parent);
    expect(preview.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/items/trash-preview",
      200,
      preview.data,
    );
    const read = await client.getItem(parent);
    const item = preview.item;
    if (item === undefined) throw new Error("the preview names no item");
    expect(item.id).toBe(parent);
    expect(item.type).toBe("core.note");
    expect(item.version).toBe(read.data.item.version);
    expect(item.count).toBe(4);
    expect(preview.data.count).toBe(4);
    expect(item.truncated).toBeUndefined();
    const listed = item.takes.map((i) => i.id);
    expect([...listed].sort()).toEqual([first, second, grandchild].sort());
    expect(listed.indexOf(grandchild)).toBeLessThan(listed.indexOf(first));
    for (const entry of item.takes) {
      const now = await client.getItem(entry.id);
      expect(entry).toEqual({
        id: entry.id,
        type: "core.note",
        version: now.data.item.version,
      });
    }

    const deleted = await client.trashItems([parent], preview.data.digest);
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

  it("changes its digest when an item past its list changes, and not otherwise", async () => {
    const parent = await note();
    const children: string[] = [];
    for (let i = 0; i < 102; i++) {
      const child = await note();
      children.push(child);
      await link(parent, child);
    }
    const first = await previewOne(parent);
    expect(first.status).toBe(200);
    expect(first.item?.truncated).toBe(true);
    expect(first.data.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await previewOne(parent)).data.digest).toBe(first.data.digest);

    const listed = new Set(first.item?.takes.map((i) => i.id));
    const unlisted = children.find((child) => !listed.has(child));
    if (unlisted === undefined) throw new Error("every child is listed");
    const read = await client.getItem(unlisted);
    const edited = await client.updateItem(unlisted, {
      version: read.data.item.version,
      properties: { body: "edited" },
    });
    expect(edited.ok, JSON.stringify(edited.error)).toBe(true);

    const after = await previewOne(parent);
    expect(after.item?.takes).toEqual(first.item?.takes);
    expect(after.data.count).toBe(first.data.count);
    expect(after.data.digest).not.toBe(first.data.digest);
  });

  it("counts an item two named items would both take once in the whole", async () => {
    const { a, b, shared } = await sharing();
    const preview = await client.previewItemTrash([a, b, a]);
    expect(preview.status).toBe(200);
    expect(preview.data.items.map((i) => i.id)).toEqual([a, b]);
    for (const item of preview.data.items) {
      expect(item.takes.map((i) => i.id)).toEqual([shared]);
      expect(item.count).toBe(2);
    }
    expect(preview.data.count).toBe(3);
  });

  it("writes nothing", async () => {
    const parent = await note();
    const child = await note();
    await link(parent, child);
    const before = await client.getItem(parent);

    expect((await client.previewItemTrash([parent])).status).toBe(200);

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
    const seen = await previewOne(parent);
    expect(seen.status).toBe(200);
    expect(seen.item?.takes.map((i) => i.id)).toEqual([hidden.data.item.id]);
    expect(seen.data.count).toBe(2);

    const preview = await previewOne(parent, writer);
    expect(preview.status).toBe(200);
    expect(preview.item?.takes).toEqual([]);
    expect(preview.item?.count).toBe(1);
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

    const preview = await client.previewItemTrash([parent]);
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

    const refused = await reader.previewItemTrash([parent]);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");

    // The witness: the key that may write the type is answered.
    expect((await client.previewItemTrash([parent])).status).toBe(200);
  });

  it("answers 404 item_not_found for an item in the trash, and 400 invalid_id for an ID that is not one", async () => {
    const id = await note();
    expect((await client.previewItemTrash([id])).status).toBe(200);
    expect((await client.deleteItem(id)).status).toBe(200);

    const trashed = await client.previewItemTrash([id]);
    expect(trashed.status).toBe(404);
    expect(trashed.error?.error.code).toBe("item_not_found");

    const invalid = await client.previewItemTrash(["not-an-id"]);
    expect(invalid.status).toBe(400);
    expect(invalid.error?.error.code).toBe("invalid_id");
  });
});

describe("POST /items/trash", () => {
  it("trashes every named item and an item they share when what the trash would take is what the preview showed", async () => {
    const { a, b, shared } = await sharing();
    const preview = await client.previewItemTrash([a, b]);
    expect(preview.status).toBe(200);
    const trashed = await client.trashItems([a, b], preview.data.digest);
    expect(trashed.status).toBe(200);
    await expectMatchesSchema("POST", "/items/trash", 200, trashed.data);
    for (const id of [a, b, shared]) expect(await state(id)).toBe(404);
  });

  it("refuses with 409 trash_plan_changed and trashes nothing when a child was attached or edited since the preview", async () => {
    const { a, b, shared } = await sharing();
    const attachedBefore = await client.previewItemTrash([a, b]);
    const late = await note();
    await link(b, late);
    const attached = await client.trashItems(
      [a, b],
      attachedBefore.data.digest,
    );
    expect(attached.status).toBe(409);
    expect(attached.error?.error.code).toBe("trash_plan_changed");
    await expectMatchesSchema("POST", "/items/trash", 409, attached.error);
    const now = await client.previewItemTrash([a, b]);
    expect(attached.error?.error.details).toEqual({ digest: now.data.digest });

    const read = await client.getItem(shared);
    const edited = await client.updateItem(shared, {
      version: read.data.item.version,
      properties: { title: "Edited after the preview" },
    });
    expect(edited.status).toBe(200);
    const editedRefusal = await client.trashItems([a, b], now.data.digest);
    expect(editedRefusal.status).toBe(409);
    expect(editedRefusal.error?.error.code).toBe("trash_plan_changed");

    for (const id of [a, b, shared, late]) expect(await state(id)).toBe(200);
  });

  it("trashes none of the named items when one of them is refused", async () => {
    const kept = await note();
    const gone = await note();
    expect((await client.deleteItem(gone)).status).toBe(200);
    const refused = await client.trashItems([kept, gone]);
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("item_not_found");
    expect(await state(kept)).toBe(200);
    // The witness: the same item alone is trashed.
    expect((await client.trashItems([kept])).status).toBe(200);
    expect(await state(kept)).toBe(404);
  });

  it("refuses a digest that is not a SHA-256 hash in hex with 400 validation_error", async () => {
    const parent = await note();
    const refused = await client.trashItems([parent], "not-a-digest");
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(await state(parent)).toBe(200);
  });
});
