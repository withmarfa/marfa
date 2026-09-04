/**
 * Search can be bounded by date, which its own description already claimed.
 *
 * The route says it accepts the same filters as `GET /items`. It took a
 * query, a type, a state, a tier, tags, an include list, a limit, an offset
 * and a filter expression — and neither of the listing's two time bounds.
 * So a date-narrowed search was not expressible, and a caller who read the
 * description and sent one got a 200 over the whole corpus, because an
 * unknown query key is stripped rather than refused.
 *
 * Asserted by row identity rather than by count: a bound that is dropped
 * and a bound that matched everything are indistinguishable by status, and
 * a count still passes if the filter silently matched a coincidental
 * number of rows.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
const TOKEN = `chronobound${Math.random().toString(36).slice(2, 8)}`;
let oldId = "";
let midId = "";
let newId = "";

beforeAll(async () => {
  ctx = await createTestContext();

  const seed = async (timestamp: string, label: string): Promise<string> => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        // The FTS token is shared so one query returns all three; the
        // label keeps the rows distinguishable in a failure message.
        properties: { body: `${TOKEN} ${label}` },
        timestamp,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string } };
    return body.item.id;
  };

  oldId = await seed("2020-01-01T00:00:00.000Z", "old");
  midId = await seed("2023-06-15T12:00:00.000Z", "mid");
  newId = await seed("2026-01-01T00:00:00.000Z", "new");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function searchIds(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/search?${query}`, {
    key: ctx.adminKey,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { item: { id: string } }[] };
  return body.results.map((r) => r.item.id).sort();
}

describe("GET /search — the time bounds it advertises", () => {
  it("returns every seeded row when unbounded", async () => {
    // The control. Without it, a bounded search returning two rows says
    // nothing about whether the bound worked.
    expect(await searchIds(`q=${TOKEN}`)).toEqual([oldId, midId, newId].sort());
  });

  it("excludes a row before the lower bound", async () => {
    const ids = await searchIds(
      `q=${TOKEN}&timestamp_after=2023-01-01T00:00:00.000Z`,
    );
    expect(ids).toEqual([midId, newId].sort());
    expect(ids).not.toContain(oldId);
  });

  it("excludes a row after the upper bound", async () => {
    const ids = await searchIds(
      `q=${TOKEN}&timestamp_before=2024-01-01T00:00:00.000Z`,
    );
    expect(ids).toEqual([oldId, midId].sort());
    expect(ids).not.toContain(newId);
  });

  it("composes the two into a window", async () => {
    const ids = await searchIds(
      `q=${TOKEN}&timestamp_after=2023-01-01T00:00:00.000Z&timestamp_before=2024-01-01T00:00:00.000Z`,
    );
    expect(ids).toEqual([midId]);
  });

  it("is inclusive at both ends, matching the item listing", async () => {
    expect(
      await searchIds(`q=${TOKEN}&timestamp_after=2023-06-15T12:00:00.000Z`),
    ).toEqual([midId, newId].sort());
    expect(
      await searchIds(`q=${TOKEN}&timestamp_before=2023-06-15T12:00:00.000Z`),
    ).toEqual([oldId, midId].sort());
  });

  it("accepts a bound at second precision, normalizing it", async () => {
    // The columns are text and the comparison is lexical, so a valid
    // RFC 3339 instant at a narrower width would otherwise answer a
    // different question than the one asked.
    expect(
      await searchIds(`q=${TOKEN}&timestamp_after=2023-06-15T12:00:00Z`),
    ).toEqual([midId, newId].sort());
  });

  it("refuses a bound that is not a timestamp", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${TOKEN}&timestamp_after=not-a-date`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("timestamp_after");
  });

  it("refuses the retired names rather than searching the whole corpus", async () => {
    // This door never carried `since` / `until`, but the published rename
    // tells a caller they belong on every filtered read. Stripped in
    // silence, they return the whole corpus at 200 — the failure the
    // rename's refusal exists to prevent, reached by following the
    // instructions.
    for (const [oldName, replacement] of [
      ["since", "timestamp_after"],
      ["until", "timestamp_before"],
    ] as const) {
      const res = await request(
        ctx.app,
        "GET",
        `/search?q=${TOKEN}&${oldName}=2023-01-01T00:00:00.000Z`,
        { key: ctx.adminKey },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain(replacement);
    }
  });
});
