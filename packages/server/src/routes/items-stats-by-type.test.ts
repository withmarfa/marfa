/**
 * `GET /items/stats?by=type` — which types are actually in use.
 *
 * Nothing answered this without paging the whole library. `GET /types` lists
 * what is *registered*, which is a different question and a much longer list;
 * `countByType` answers one exact identifier per call; and `stats` grouped
 * by lifecycle state alone. So a client that wanted the type vocabulary had
 * to walk every row.
 *
 * **The invariant worth asserting is that the two breakdowns describe the same
 * rows.** `by=state` and `by=type` are two groupings of one population — the
 * items this caller can read — so their totals must agree. That is checkable,
 * where "returns some types" is not: a breakdown that quietly dropped a filter
 * or applied a different one still returns plausible-looking types.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";

let ctx: TestContext;

const SEEN = "user.stats_seen";
const HIDDEN = "user.stats_hidden";

beforeAll(async () => {
  ctx = await createTestContext();
  for (const id of [SEEN, HIDDEN]) {
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id, version: 1, fields: { body: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
  }
  // Two of one type and one of the other, so a breakdown that returned
  // presence rather than counts is distinguishable from one that counts.
  for (const [id, n] of [
    [SEEN, 2],
    [HIDDEN, 1],
  ] as [string, number][]) {
    for (let i = 0; i < n; i++) {
      const created = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: id, properties: { body: `row ${String(i)}` } },
      });
      expect(created.status).toBe(201);
    }
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

async function stats(key: string, query = ""): Promise<Record<string, number>> {
  const res = await request(ctx.app, "GET", `/items/stats${query}`, { key });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number>;
}

const total = (s: Record<string, number>): number =>
  Object.values(s).reduce((a, b) => a + b, 0);

describe("GET /items/stats?by=type", () => {
  it("names the types in use, with their counts", async () => {
    const byType = await stats(ctx.workingKey, "?by=type");
    expect(byType[SEEN]).toBe(2);
    expect(byType[HIDDEN]).toBe(1);
  });

  it("describes the same rows as the state breakdown", async () => {
    // The two groupings are of one population, so the totals agree. This is
    // what catches a breakdown that dropped a filter the other still applies.
    const byState = await stats(ctx.workingKey);
    const byType = await stats(ctx.workingKey, "?by=type");
    expect(total(byType)).toBe(total(byState));
  });

  it("defaults to the state breakdown, unchanged", async () => {
    // The parameter is additive: an existing caller sees exactly what it saw.
    const bare = await stats(ctx.workingKey);
    const explicit = await stats(ctx.workingKey, "?by=state");
    expect(bare).toEqual(explicit);
    // States, not types — the shape is a record either way, so asserting the
    // keys is what tells them apart.
    expect(Object.keys(bare)).not.toContain(SEEN);
  });

  it("is scoped to the caller's type permissions", async () => {
    // The type vocabulary names what exists, so a credential that cannot read
    // a type must not learn it is in use — the same reasoning as the tag
    // vocabulary on GET /metadata/tags.
    const suffix = Math.random().toString(36).slice(2, 10);
    let raw = `marfa_k1_stats_${suffix}`;
    raw = await mintWorkingKey(ctx, {
      permissions: [],
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      label: `stats-${suffix}`,
      source: `stats-${suffix}`,
      type_permissions: { [SEEN]: "read" },
      default_tier: "library",
    });

    const byType = await stats(raw, "?by=type");
    // Both halves: the granted type survives and the withheld one does not.
    // Asserting only the absence would pass on an empty response.
    expect(byType[SEEN]).toBe(2);
    expect(byType[HIDDEN]).toBeUndefined();
  });

  it("refuses a breakdown it does not have", async () => {
    // Fail loudly rather than silently answering the state question, which
    // is what an unvalidated parameter would do to a typo.
    const res = await request(ctx.app, "GET", "/items/stats?by=nonsense", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
  });
});
