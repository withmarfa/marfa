/**
 * Conformance for POST /items/bulk-get.
 *
 * Scope is deliberately narrow: the wire shape of the endpoint — the
 * readable items come back, unresolvable ids are omitted rather than errored,
 * the id cap is enforced, and `include` hydrates inline.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "bulk-get"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function createTrackedNote(): Promise<string> {
  const r = await client.createItem(createNote({ source: ctx.source }));
  expect(r.status).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("POST /items/bulk-get", () => {
  it("returns the requested items by id", async () => {
    const a = await createTrackedNote();
    const b = await createTrackedNote();

    const res = await client.bulkGet([a, b]);
    expect(res.status).toBe(200);
    await expectMatchesSchema("POST", "/items/bulk-get", 200, res.data);
    expect(Object.keys(res.data)).toEqual(["items"]);
    const ids = res.data.items.map((i) => i.id).sort();
    expect(ids).toEqual([a, b].sort());
  });

  it("omits ids that do not resolve rather than erroring", async () => {
    const present = await createTrackedNote();
    // A trashed item is not readable, so bulk-get drops it from the result.
    const gone = await createTrackedNote();
    const del = await client.deleteItem(gone);
    expect(del.status).toBe(200);

    const res = await client.bulkGet([present, gone]);
    expect(res.status).toBe(200);
    const ids = res.data.items.map((i) => i.id);
    expect(ids).toContain(present);
    expect(ids).not.toContain(gone);
  });

  it("rejects a request with more than 100 ids", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `id-${String(i)}`);
    const res = await client.bulkGet(tooMany);
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("validation_error");
    expect(res.error?.error.details?.cap).toBe(100);
    expect(res.error?.error.details?.provided).toBe(101);
  });

  it("hydrates metadata when include carries metadata", async () => {
    const a = await createTrackedNote();
    const res = await client.bulkGet([a], ["metadata"]);
    expect(res.status).toBe(200);
    await expectMatchesSchema("POST", "/items/bulk-get", 200, res.data);
    // The ids the caller named are the whole answer, so there is no cursor
    // beside the rows.
    expect(Object.keys(res.data).sort()).toEqual(["items", "metadata"]);
    expect(Array.isArray(res.data.metadata)).toBe(true);
    expect(res.data.metadata?.some((m) => m.item_id === a)).toBe(true);
  });

  it("refuses a body whose ids is not a list", async () => {
    const r = await client.rawRequest("/items/bulk-get", {
      method: "POST",
      body: { ids: "not-a-list" },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
  });
});
