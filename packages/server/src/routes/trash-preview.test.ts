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
  items: unknown[];
  count: number;
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
