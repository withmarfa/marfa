import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackFolder,
  trackItem,
  cleanup,
} from "../../utils/setup.js";

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

  it("refuses a limit, a cursor, a sort and a direction as keys it does not declare, naming each", async () => {
    // The witness: the listing takes all four, so the refusal is the stats
    // door's own.
    const listed = await client.rawRequest<unknown>(
      `/items?source=${encodeURIComponent(ctx.source)}&limit=5&sort=created_at&direction=asc`,
    );
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);

    for (const query of [
      "limit=5",
      "cursor=abc",
      "sort=created_at",
      "direction=asc",
    ]) {
      const refused = await client.rawRequest<unknown>(`/items/stats?${query}`);
      expect(refused.status, query).toBe(400);
      expect(refused.error?.error.code, query).toBe("validation_error");
      expect(refused.error?.error.details?.unknown_parameters, query).toEqual([
        query.split("=")[0],
      ]);
    }
    const together = await client.rawRequest<unknown>(
      "/items/stats?limit=5&cursor=abc&sort=created_at&direction=asc",
    );
    expect(together.status).toBe(400);
    expect(
      [
        ...(together.error?.error.details?.unknown_parameters as string[]),
      ].sort(),
    ).toEqual(["cursor", "direction", "limit", "sort"]);
  });

  it("counts the system items under include=system and refuses any other include", async () => {
    const folder = await client.createFolder({ title: `stats-${ctx.runId}` });
    expect(folder.status, JSON.stringify(folder.error)).toBe(201);
    trackFolder(ctx, folder.data.item.id);
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: `stats-system-${ctx.runId}` },
    });
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const byType = async (query: string): Promise<Record<string, number>> => {
      const res = await client.rawRequest<Record<string, number>>(
        `/items/stats?by=type&source=${encodeURIComponent(ctx.source)}${query}`,
      );
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data;
    };
    // The folder is left out by default and counted under the token, beside
    // the same note, so the count that rose is the system one.
    expect(Object.keys(await byType(""))).not.toContain("system.folder");
    const withSystem = await byType("&include=system");
    expect(withSystem["system.folder"]).toBe(1);
    expect(withSystem["core.note"]).toBe((await byType(""))["core.note"]);

    for (const include of ["edges", "metadata", "extensions", "system,edges"]) {
      const refused = await client.rawRequest<unknown>(
        `/items/stats?include=${include}`,
      );
      expect(refused.status, include).toBe(400);
      expect(refused.error?.error.code, include).toBe("validation_error");
    }
  });

  it("refuses what the listing refuses in a filter: a state outside the enum, a bound that is not an instant and a number no double holds", async () => {
    const huge = `1${"0".repeat(400)}`;
    const queries = [
      "state=sleeping",
      "occurred_after=banana",
      "occurred_before=banana",
      "updated_after=banana",
      "updated_before=banana",
      `filter=${encodeURIComponent(`properties.n gt ${huge}`)}`,
    ];
    // The witness: each filter's well-formed neighbor is counted.
    for (const ok of [
      "state=archived",
      "occurred_after=2020-01-01T00:00:00Z",
      "updated_before=2999-01-01T00:00:00Z",
      `filter=${encodeURIComponent("properties.n gt 1")}`,
    ]) {
      const counted = await client.rawRequest<unknown>(`/items/stats?${ok}`);
      expect(counted.status, ok).toBe(200);
    }
    for (const query of queries) {
      const listed = await client.rawRequest<unknown>(`/items?${query}`);
      const counted = await client.rawRequest<unknown>(`/items/stats?${query}`);
      expect(listed.status, `listing ${query}`).toBe(400);
      expect(counted.status, `stats ${query}`).toBe(400);
      expect(counted.error?.error.code, query).toBe("validation_error");
    }
  });

  it("answers the listing's own count as the bucket of its state, and the sum of the buckets under state=any", async () => {
    const tag = `stats-sum-${ctx.runId}`;
    const seed = async (): Promise<string> => {
      const made = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body: `${tag} ${String(Math.random())}` },
        tags: [tag],
      });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      trackItem(ctx, made.data.item.id);
      return made.data.item.id;
    };
    const [, archived, trashed] = [await seed(), await seed(), await seed()];
    expect((await client.transitionItem(archived, "archived")).ok).toBe(true);
    expect((await client.deleteItem(trashed)).ok).toBe(true);

    const scope = `tags=${encodeURIComponent(tag)}`;
    const stats = async (state: string): Promise<Record<string, number>> => {
      const res = await client.rawRequest<Record<string, number>>(
        `/items/stats?${scope}${state}`,
      );
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data;
    };
    const listed = async (state: string): Promise<number> => {
      const res = await client.rawRequest<{ data: unknown[] }>(
        `/items?${scope}&limit=200${state}`,
      );
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data.data.length;
    };

    const everyState = await stats("");
    expect(everyState).toEqual({ active: 1, archived: 1, trashed: 1 });
    expect(await stats("&state=any")).toEqual(everyState);
    expect(await listed("")).toBe(everyState.active);
    expect(await listed("&state=archived")).toBe(everyState.archived);
    const sum = Object.values(everyState).reduce((a, n) => a + n, 0);
    expect(await listed("&state=any")).toBe(sum);
  });
});
