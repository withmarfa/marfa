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

  it("counts the rows a listing's filters match", async () => {
    const tag = `stats-count-${ctx.runId}`;
    const ids: string[] = [];
    for (const [body, tags] of [
      ["kept one", [tag]],
      ["kept two", [tag]],
      ["put away", [tag]],
      ["untagged", []],
    ] as [string, string[]][]) {
      const made = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: `${body} ${ctx.runId}` },
        tags,
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      trackItem(ctx, made.data.item.id);
      ids.push(made.data.item.id);
    }
    const archived = await client.transitionItem(ids[2] ?? "", "archived");
    expect(archived.ok, JSON.stringify(archived.error)).toBe(true);

    const scope = `source=${encodeURIComponent(ctx.source)}&tags=${encodeURIComponent(tag)}`;

    // The listing these counts size: two active rows carry the tag, so a
    // count that ignored the tag or the source would read higher.
    const listed = await client.rawRequest<{ data: { id: string }[] }>(
      `/items?${scope}&limit=50`,
    );
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.data.data.map((r) => r.id).sort()).toEqual(
      [ids[0], ids[1]].sort(),
    );

    const byState = await client.rawRequest<Record<string, number>>(
      `/items/stats?${scope}`,
    );
    expect(byState.ok, JSON.stringify(byState.error)).toBe(true);
    expect(byState.data).toEqual({ active: 2, archived: 1 });

    const active = await client.rawRequest<Record<string, number>>(
      `/items/stats?${scope}&state=active&by=type`,
    );
    expect(active.ok, JSON.stringify(active.error)).toBe(true);
    expect(active.data).toEqual({ "core.note": 2 });

    const expression = await client.rawRequest<Record<string, number>>(
      `/items/stats?source=${encodeURIComponent(ctx.source)}&filter=${encodeURIComponent(`properties.body eq "untagged ${ctx.runId}"`)}`,
    );
    expect(expression.ok, JSON.stringify(expression.error)).toBe(true);
    expect(expression.data).toEqual({ active: 1 });

    // A filter the listing refuses is refused here too, rather than counted
    // as if it matched everything.
    const unknownType = await client.rawRequest<unknown>(
      `/items/stats?type=${encodeURIComponent(`user.unregistered_${ctx.runId.replace(/[^a-z0-9]/g, "")}`)}`,
    );
    expect(unknownType.status).toBe(400);
    expect(unknownType.error?.error.code).toBe("unknown_type");
  });
});
