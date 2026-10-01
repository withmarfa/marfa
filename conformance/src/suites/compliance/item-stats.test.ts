import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "item-stats"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("GET /items/stats", () => {
  it("refuses a query key it does not declare, naming it", async () => {
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: `stats-seed-${ctx.runId}` },
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);

    // The door reads its query: the declared spelling changes the answer
    // from counts by state to counts by type. Without this the refusal below
    // would pass against a door that refused every key.
    const byType = await client.rawRequest<Record<string, number>>(
      "/items/stats?by=type",
    );
    expect(byType.ok, JSON.stringify(byType.error)).toBe(true);
    expect(byType.data["core.note"]).toBeGreaterThanOrEqual(1);
    expect(byType.data).not.toHaveProperty("active");

    const undeclared = await client.rawRequest<unknown>(
      "/items/stats?group_by=type",
    );
    expect(
      undeclared.status,
      "a key the door does not declare answered 200, so a misspelled grouping reads as the default one",
    ).toBe(400);
    expect(undeclared.error?.error.code).toBe("validation_error");
    expect(undeclared.error?.error.details?.unknown_parameters).toEqual([
      "group_by",
    ]);
  });
});
