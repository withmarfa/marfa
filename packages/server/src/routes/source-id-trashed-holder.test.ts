/**
 * A natural key a trashed row holds is taken: the unique index counts the row
 * in every state, so a write giving another row that key is a conflict, not
 * an unexpected failure.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function create(body: Record<string, unknown>): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "x" }, ...body },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("PATCH /items/{id} giving a row the natural key of a trashed row", () => {
  it("is refused 409 source_id_conflict, as a live holder is", async () => {
    await create({ source_id: "live-holder" });
    const holder = await create({ source_id: "trashed-holder" });
    const mover = await create({ source_id: "mover" });
    const gone = await request(ctx.app, "DELETE", `/items/${holder}`, {
      key: ctx.workingKey,
    });
    expect(gone.status).toBe(200);

    const witness = await request(ctx.app, "PATCH", `/items/${mover}`, {
      key: ctx.workingKey,
      body: { version: 1, source_id: "live-holder" },
    });
    expect(witness.status).toBe(409);

    const res = await request(ctx.app, "PATCH", `/items/${mover}`, {
      key: ctx.workingKey,
      body: { version: 1, source_id: "trashed-holder" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { source_id?: string } };
    };
    expect(body.error.code).toBe("source_id_conflict");
    expect(body.error.details?.source_id).toBe("trashed-holder");
  });
});
