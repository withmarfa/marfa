import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { TRASH_MAX_IDS, TRASH_PREVIEW_LIMIT } from "./items-lifecycle.js";

let ctx: TestContext;
let key: string;

beforeAll(async () => {
  ctx = await createTestContext();
  key = await mintWorkingKey(ctx);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function note(): Promise<string> {
  const created = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "note" },
  });
  return created.id;
}

async function parentOf(children: number): Promise<string> {
  const parent = await note();
  for (let i = 0; i < children; i++) {
    await ctx.storage.edges.createRaw({
      source_id: parent,
      target_id: await note(),
      edge_type: "parent-of",
    });
  }
  return parent;
}

interface PreviewItem {
  id: string;
  takes: { id: string; version: number }[];
  count: number;
  truncated?: true;
}

interface Preview {
  items: PreviewItem[];
  count: number;
  digest: string;
}

interface Refusal {
  error: { code: string };
}

async function previewOf(ids: string[]): Promise<Response> {
  return request(ctx.app, "POST", "/items/trash-preview", {
    key,
    body: { ids },
  });
}

async function preview(id: string): Promise<Response> {
  return previewOf([id]);
}

/** The one named item of a preview of one item. */
async function previewed(id: string): Promise<PreviewItem & Preview> {
  const body = (await (await preview(id)).json()) as Preview;
  const [item] = body.items;
  if (item === undefined) throw new Error("the preview names no item");
  return { ...body, ...item, count: body.count };
}

async function state(id: string): Promise<string | undefined> {
  return (await ctx.storage.items.getIncludingTrashed(id))?.state;
}

/** Two items whose trash each takes one shared child. */
async function sharing(): Promise<{ a: string; b: string; shared: string }> {
  const a = await note();
  const b = await note();
  const shared = await note();
  for (const parent of [a, b]) {
    await ctx.storage.edges.createRaw({
      source_id: parent,
      target_id: shared,
      edge_type: "parent-of",
    });
  }
  return { a, b, shared };
}

describe("POST /items/trash-preview", () => {
  it("lists at most the limit, says it cut the list, and still counts every item", async () => {
    const full = await previewed(await parentOf(TRASH_PREVIEW_LIMIT));
    expect(full.takes).toHaveLength(TRASH_PREVIEW_LIMIT);
    expect(full.count).toBe(TRASH_PREVIEW_LIMIT + 1);
    expect(full).not.toHaveProperty("truncated");

    const cut = await previewed(await parentOf(TRASH_PREVIEW_LIMIT + 1));
    expect(cut.takes).toHaveLength(TRASH_PREVIEW_LIMIT);
    expect(cut.count).toBe(TRASH_PREVIEW_LIMIT + 2);
    expect(cut.truncated).toBe(true);
  });

  it("changes its digest when an item it does not list changes, or is swapped for another", async () => {
    const parent = await note();
    const edges = new Map<string, string>();
    for (let i = 0; i < TRASH_PREVIEW_LIMIT + 2; i++) {
      const child = await note();
      const edge = await ctx.storage.edges.createRaw({
        source_id: parent,
        target_id: child,
        edge_type: "parent-of",
      });
      edges.set(child, edge.id);
    }
    const read = () => previewed(parent);
    const first = await read();
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await read()).digest).toBe(first.digest);

    const listed = new Set(first.takes.map((item) => item.id));
    const [edited, swapped] = [...edges.keys()].filter((id) => !listed.has(id));
    if (edited === undefined || swapped === undefined) {
      throw new Error("every child is listed");
    }

    const row = await ctx.storage.items.get(edited);
    const patched = await request(ctx.app, "PATCH", `/items/${edited}`, {
      key,
      body: { version: row?.version, properties: { body: "edited" } },
    });
    expect(patched.status).toBe(200);
    const afterEdit = await read();
    expect(afterEdit.takes).toEqual(first.takes);
    expect(afterEdit.count).toBe(first.count);
    expect(afterEdit.digest).not.toBe(first.digest);

    await ctx.storage.edges.delete(edges.get(swapped) ?? "");
    await ctx.storage.edges.createRaw({
      source_id: parent,
      target_id: await note(),
      edge_type: "parent-of",
    });
    const afterSwap = await read();
    expect(afterSwap.count).toBe(first.count);
    expect(afterSwap.digest).not.toBe(afterEdit.digest);
  });

  it("counts a child two named items share once, under each and in the whole", async () => {
    const { a, b, shared } = await sharing();
    const res = await previewOf([a, b, a]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Preview;
    expect(body.items.map((item) => item.id)).toEqual([a, b]);
    for (const item of body.items) {
      expect(item.takes.map((taken) => taken.id)).toEqual([shared]);
      expect(item.count).toBe(2);
    }
    expect(body.count).toBe(3);
  });

  it("refuses an ID that is not one, an empty list and more than the limit", async () => {
    const malformed = await previewOf([await note(), "nope"]);
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as Refusal).error.code).toBe("invalid_id");
    const empty = await previewOf([]);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as Refusal).error.code).toBe(
      "validation_error",
    );
    const ids: string[] = [];
    for (let i = 0; i <= TRASH_MAX_IDS; i++) ids.push(await note());
    const many = await previewOf(ids);
    expect(many.status).toBe(400);
    expect(((await many.json()) as Refusal).error.code).toBe(
      "validation_error",
    );
    // The witness: the limit itself is answered.
    expect((await previewOf(ids.slice(0, TRASH_MAX_IDS))).status).toBe(200);
  });

  it("refuses an item that is parent-of a live connection as the delete does", async () => {
    const parent = await note();
    const connection = await itemWrites(ctx.storage).create({
      writer: null,
      type: "system.connection",
      properties: {
        kind: "app",
        status: "active",
        granted_at: new Date().toISOString(),
        client_id: "acme.demo",
      },
    });
    await ctx.storage.edges.createRaw({
      source_id: parent,
      target_id: connection.id,
      edge_type: "parent-of",
    });

    const refused = await preview(parent);
    const deleted = await request(ctx.app, "DELETE", `/items/${parent}`, {
      key,
    });
    expect(refused.status).toBe(400);
    expect(deleted.status).toBe(400);
    const body = (await refused.json()) as Refusal;
    expect(body.error.code).toBe("validation_error");
    expect(body.error).toEqual(((await deleted.json()) as Refusal).error);
    expect((await ctx.storage.items.get(parent))?.state).toBe("active");
  });
});

describe("POST /items/trash", () => {
  async function trash(ids: string[], digest?: string): Promise<Response> {
    return request(ctx.app, "POST", "/items/trash", {
      key,
      body: { ids, ...(digest !== undefined && { digest }) },
    });
  }

  async function digestOf(ids: string[]): Promise<string> {
    return ((await (await previewOf(ids)).json()) as Preview).digest;
  }

  it("trashes two named items and the child they share, on the preview's digest", async () => {
    const { a, b, shared } = await sharing();
    const ids = [a, b];
    const res = await trash(ids, await digestOf(ids));
    expect(res.status).toBe(200);
    for (const id of [a, b, shared]) expect(await state(id)).toBe("trashed");
  });

  it("records a named item another named item takes as taken with it, whatever the order named", async () => {
    const parent = await note();
    const child = await note();
    await ctx.storage.edges.createRaw({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    const res = await trash([child, parent]);
    expect(res.status).toBe(200);
    expect(await state(child)).toBe("trashed");
    const restored = await request(
      ctx.app,
      "POST",
      `/items/${parent}/restore`,
      { key },
    );
    expect(restored.status).toBe(200);
    expect(await state(child)).toBe("active");
  });

  it("refuses with trash_plan_changed and trashes nothing when a child joined one item since the preview", async () => {
    const { a, b, shared } = await sharing();
    const ids = [a, b];
    const digest = await digestOf(ids);
    const joined = await note();
    await ctx.storage.edges.createRaw({
      source_id: b,
      target_id: joined,
      edge_type: "parent-of",
    });
    const res = await trash(ids, digest);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Refusal & {
      error: { details?: { digest?: string } };
    };
    expect(body.error.code).toBe("trash_plan_changed");
    expect(body.error.details?.digest).toBe(await digestOf(ids));
    for (const id of [a, b, shared, joined]) {
      expect(await state(id)).toBe("active");
    }
  });

  it("refuses with trash_plan_changed when a child was edited since the preview", async () => {
    const parent = await note();
    const child = await note();
    await ctx.storage.edges.createRaw({
      source_id: parent,
      target_id: child,
      edge_type: "parent-of",
    });
    const digest = await digestOf([parent]);
    const row = await ctx.storage.items.get(child);
    const patched = await request(ctx.app, "PATCH", `/items/${child}`, {
      key,
      body: { version: row?.version, properties: { body: "edited" } },
    });
    expect(patched.status).toBe(200);
    const res = await trash([parent], digest);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Refusal).error.code).toBe(
      "trash_plan_changed",
    );
    expect(await state(parent)).toBe("active");
    expect(await state(child)).toBe("active");
  });

  it("trashes none of the items when one of them is refused", async () => {
    const kept = await note();
    const gone = await note();
    expect((await trash([gone])).status).toBe(200);
    const res = await trash([kept, gone]);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Refusal).error.code).toBe("item_not_found");
    expect(await state(kept)).toBe("active");
  });

  it("refuses a digest that is not a SHA-256 hash in hex", async () => {
    const parent = await note();
    const res = await trash([parent], "not-a-digest");
    expect(res.status).toBe(400);
    expect(((await res.json()) as Refusal).error.code).toBe("validation_error");
    expect(await state(parent)).toBe("active");
  });
});
