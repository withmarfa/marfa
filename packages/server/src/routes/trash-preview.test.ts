import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { TRASH_PREVIEW_LIMIT } from "./items-lifecycle.js";

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

interface Preview {
  items: { id: string; version: number }[];
  count: number;
  digest: string;
  truncated?: true;
}

interface Refusal {
  error: { code: string };
}

async function preview(id: string): Promise<Response> {
  return request(ctx.app, "GET", `/items/${id}/trash-preview`, { key });
}

describe("GET /items/{id}/trash-preview", () => {
  it("lists at most the limit, says it cut the list, and still counts every item", async () => {
    const full = (await (
      await preview(await parentOf(TRASH_PREVIEW_LIMIT))
    ).json()) as Preview;
    expect(full.items).toHaveLength(TRASH_PREVIEW_LIMIT);
    expect(full.count).toBe(TRASH_PREVIEW_LIMIT + 1);
    expect(full).not.toHaveProperty("truncated");

    const res = await preview(await parentOf(TRASH_PREVIEW_LIMIT + 1));
    expect(res.status).toBe(200);
    const cut = (await res.json()) as Preview;
    expect(cut.items).toHaveLength(TRASH_PREVIEW_LIMIT);
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
    const read = async () => (await (await preview(parent)).json()) as Preview;
    const first = await read();
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await read()).digest).toBe(first.digest);

    const listed = new Set(first.items.map((item) => item.id));
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
    expect(afterEdit.items).toEqual(first.items);
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

  it("answers which of check_ids it would take, listed or not", async () => {
    const parent = await note();
    const children: string[] = [];
    for (let i = 0; i < TRASH_PREVIEW_LIMIT + 1; i++) {
      const child = await note();
      children.push(child);
      await ctx.storage.edges.createRaw({
        source_id: parent,
        target_id: child,
        edge_type: "parent-of",
      });
    }
    const plain = (await (await preview(parent)).json()) as Preview;
    expect(plain).not.toHaveProperty("taken_ids");
    const listed = new Set(plain.items.map((item) => item.id));
    const unlisted = children.find((child) => !listed.has(child));
    if (unlisted === undefined) throw new Error("every child is listed");
    const outside = await note();

    const checked = await request(
      ctx.app,
      "GET",
      `/items/${parent}/trash-preview?check_ids=${outside},${unlisted}`,
      { key },
    );
    expect(checked.status).toBe(200);
    expect(
      ((await checked.json()) as { taken_ids: string[] }).taken_ids,
    ).toEqual([unlisted]);

    const malformed = await request(
      ctx.app,
      "GET",
      `/items/${parent}/trash-preview?check_ids=nope`,
      { key },
    );
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as Refusal).error.code).toBe("invalid_id");
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
