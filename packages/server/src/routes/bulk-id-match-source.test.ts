/**
 * A bulk entry that lands on a row by its `id` moves that row's natural key
 * only under the source the entry is written under.
 *
 * The id fallback finds a row whatever source wrote it, so an entry naming a
 * `source_id` there would move another source's natural key: the row leaves
 * the key its own connector syncs it by, and that connector's next sync makes
 * a second row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  ctx = await createTestContext();
  keyA = await mintWorkingKey(ctx, { source: "src-a" });
  keyB = await mintWorkingKey(ctx, { source: "src-b" });
});

afterAll(async () => {
  await ctx.cleanup();
});

interface BulkAnswer {
  results: {
    outcome: string;
    id?: string;
    error?: { code: string; details?: { source?: string } };
  }[];
}

async function bulk(key: string, entry: Record<string, unknown>) {
  const res = await request(ctx.app, "POST", "/items/bulk", {
    key,
    body: { atomic: false, items: [entry] },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as BulkAnswer).results[0];
}

describe("a bulk entry landing on a row by its id", () => {
  it("refuses to move another source's natural key", async () => {
    const made = await bulk(keyA, {
      type: "core.note",
      properties: { body: "a's" },
      source_id: "from-a",
    });
    expect(made?.outcome).toBe("created");
    const id = made!.id!;

    const moved = await bulk(keyB, {
      type: "core.note",
      id,
      properties: { body: "b's" },
      source_id: "from-b",
    });
    expect(moved?.outcome).toBe("errored");
    expect(moved?.error?.code).toBe("forbidden");
    const row = await ctx.storage.items.get(id);
    expect(row?.source_id).toBe("from-a");
    expect(row?.properties.body).toBe("a's");

    const resynced = await bulk(keyA, {
      type: "core.note",
      properties: { body: "a's again" },
      source_id: "from-a",
    });
    expect(resynced?.outcome).toBe("updated");
    expect(resynced?.id).toBe(id);
  });

  it("moves its own source's natural key", async () => {
    const made = await bulk(keyA, {
      type: "core.note",
      properties: { body: "a's" },
      source_id: "own-before",
    });
    const id = made!.id!;
    const moved = await bulk(keyA, {
      type: "core.note",
      id,
      properties: { body: "a's" },
      source_id: "own-after",
    });
    expect(moved?.outcome).toBe("updated");
    expect((await ctx.storage.items.get(id))?.source_id).toBe("own-after");
  });

  it("refuses the same move through PATCH /items/{id}", async () => {
    const made = await bulk(keyA, {
      type: "core.note",
      properties: { body: "a's" },
      source_id: "patched-from-a",
    });
    const id = made!.id!;
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: keyB,
      body: { source_id: "patched-from-b", version: 1 },
    });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as {
      error: { code: string; details?: { source?: string } };
    };
    expect(error.code).toBe("forbidden");
    expect(error.details?.source).toBe("src-a");
    expect((await ctx.storage.items.get(id))?.source_id).toBe("patched-from-a");
  });
});
