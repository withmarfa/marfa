import { beforeAll, afterAll, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
beforeAll(async () => {
  ({ client, ctx } = await createTestContext("compliance", "version-exact"));
});
afterAll(async () => {
  await cleanup(ctx);
});
async function note(): Promise<string> {
  const result = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { title: "Before", body: "Original" },
  });
  expect(result.status, JSON.stringify(result.error)).toBe(201);
  trackItem(ctx, result.data.item.id);
  return result.data.item.id;
}

it("refuses stale exact writes without changing the row or history", async () => {
  const id = await note();
  expect(
    (
      await client.updateItem(id, {
        version: 1,
        properties: { body: "Adopted" },
      })
    ).status,
  ).toBe(200);
  const before = await client.getItem(id);
  const history = await client.getVersions(id);
  expect(before.status).toBe(200);
  expect(history.status).toBe(200);
  for (const version of [0, 1, 3, 999]) {
    for (const query of ["", "?conflict=auto", "?conflict=callback"]) {
      const result = await client.rawRequest<unknown>(`/items/${id}${query}`, {
        method: "PATCH",
        body: {
          version,
          version_match: "exact",
          properties: { title: "Stale" },
        },
      });
      expect(result.status, JSON.stringify(result.error)).toBe(409);
      expect(result.error?.error.code).toBe("version_conflict");
      expect(result.error).toMatchObject({
        current: {
          id,
          version: 2,
          properties: before.data.item.properties,
          type: "core.note",
          tier: before.data.item.tier,
          occurred_at: before.data.item.occurred_at,
          source_id: before.data.item.source_id ?? null,
        },
      });
      for (const field of [
        "ancestor",
        "conflicting_fields",
        "merge_policy",
        "requested_version",
      ])
        expect(result.error).not.toHaveProperty(field);
    }
  }
  const after = await client.getItem(id);
  expect(after.status).toBe(200);
  expect(after.data.item).toEqual(before.data.item);
  const afterHistory = await client.getVersions(id);
  expect(afterHistory.status).toBe(200);
  expect(afterHistory.data).toEqual(history.data);
});

it("accepts the current exact version and merges disjoint changes when exact is absent", async () => {
  const id = await note();
  const exact = await client.updateItem(id, {
    version: 1,
    version_match: "exact",
    properties: { body: "Adopted" },
  });
  expect(exact.status, JSON.stringify(exact.error)).toBe(200);
  const merged = await client.updateItem(id, {
    version: 1,
    properties: { title: "Merged" },
  });
  expect(merged.status, JSON.stringify(merged.error)).toBe(200);
  expect(merged.data.item.properties).toMatchObject({
    title: "Merged",
    body: "Adopted",
  });
  expect(merged.data.item.version).toBe(3);
});

it("admits only one concurrent exact write to different fields", async () => {
  const id = await note();
  const results = await Promise.all([
    client.updateItem(id, {
      version: 1,
      version_match: "exact",
      properties: { title: "Changed" },
    }),
    client.updateItem(id, {
      version: 1,
      version_match: "exact",
      properties: { body: "Changed" },
    }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  const current = await client.getItem(id);
  expect(current.status).toBe(200);
  expect(current.data.item.version).toBe(2);
});
