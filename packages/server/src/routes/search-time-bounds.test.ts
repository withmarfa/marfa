/**
 * Search can be bounded by date, and its own description claims parity
 * with `GET /items`.
 *
 * A bound this door declared and did not apply would be invisible: an
 * unknown query key is stripped rather than refused, so a caller sending
 * one gets a 200 over the whole corpus that looks exactly like the narrow
 * answer they asked for.
 *
 * Asserted by row identity rather than by count: a bound that is dropped
 * and a bound that matched everything are indistinguishable by status, and
 * a count still passes if the filter silently matched a coincidental
 * number of rows.
 *
 * **The claim is parity, so the last case asks the two doors the same
 * question and compares their answers.** Every case above it would pass
 * against a search that bounded correctly on some other expression, and
 * "the same filters as `GET /items`" is what the route's own description
 * promises — a search answering a neighboring question is a worse failure
 * than the absence it replaces, and no case that only reads `/search` can
 * see it.
 *
 * Not covered, deliberately, and worth knowing before looking for it: the
 * `COALESCE(occurred_at, created_at)` both stores compile cannot be
 * reached from a test, because `items.occurred_at` is `NOT NULL`. No row
 * can have the null the fallback is for. It is written anyway because it
 * is what the item listing compiles, and the parity below is the claim
 * being made; a search store that spelled the expression its own way
 * would be reading the same rows today and diverging the day the column
 * changes.
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

  const seed = async (occurredAt: string, label: string): Promise<string> => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        // The FTS token is shared so one query returns all three; the
        // label keeps the rows distinguishable in a failure message.
        properties: { body: `${TOKEN} ${label}` },
        occurred_at: occurredAt,
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
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { item: { id: string } }[] };
  return body.data.map((r) => r.item.id).sort();
}

describe("GET /search — the time bounds it advertises", () => {
  it("returns every seeded row when unbounded", async () => {
    // The control. Without it, a bounded search returning two rows says
    // nothing about whether the bound worked.
    expect(await searchIds(`q=${TOKEN}`)).toEqual([oldId, midId, newId].sort());
  });

  it("excludes a row before the lower bound", async () => {
    const ids = await searchIds(
      `q=${TOKEN}&occurred_after=2023-01-01T00:00:00.000Z`,
    );
    expect(ids).toEqual([midId, newId].sort());
    expect(ids).not.toContain(oldId);
  });

  it("excludes a row after the upper bound", async () => {
    const ids = await searchIds(
      `q=${TOKEN}&occurred_before=2024-01-01T00:00:00.000Z`,
    );
    expect(ids).toEqual([oldId, midId].sort());
    expect(ids).not.toContain(newId);
  });

  it("composes the two into a window", async () => {
    const ids = await searchIds(
      `q=${TOKEN}&occurred_after=2023-01-01T00:00:00.000Z&occurred_before=2024-01-01T00:00:00.000Z`,
    );
    expect(ids).toEqual([midId]);
  });

  it("is exclusive at both ends, matching the item listing", async () => {
    // The bound lands exactly on the mid row's own time, so an inclusive
    // comparison at either end shows up here as that row coming back.
    expect(
      await searchIds(`q=${TOKEN}&occurred_after=2023-06-15T12:00:00.000Z`),
    ).toEqual([newId]);
    expect(
      await searchIds(`q=${TOKEN}&occurred_before=2023-06-15T12:00:00.000Z`),
    ).toEqual([oldId]);
  });

  it("accepts a bound at second precision, normalizing it", async () => {
    // The columns are text and the comparison is lexical, so a valid
    // RFC 3339 instant at a narrower width would otherwise answer a
    // different question than the one asked.
    expect(
      await searchIds(`q=${TOKEN}&occurred_after=2023-06-15T12:00:00Z`),
    ).toEqual([newId]);
  });

  it("refuses a bound that is not an instant", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/search?q=${TOKEN}&occurred_after=not-a-date`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("occurred_after");
  });

  it("answers the same rows as the item listing for the same bound", async () => {
    // The parity the route's description claims, asserted against the door
    // it claims parity with. Comparing row identity rather than counts, and
    // over the seeded rows only, because `/items` returns everything and
    // `/search` returns what the token matched.
    const seeded = new Set([oldId, midId, newId]);
    const listedIds = async (query: string): Promise<string[]> => {
      const res = await request(
        ctx.app,
        "GET",
        `/items?type=core.note&limit=200&${query}`,
        { key: ctx.workingKey },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      return body.data
        .map((r) => r.id)
        .filter((id) => seeded.has(id))
        .sort();
    };

    for (const bound of [
      "occurred_after=2023-01-01T00:00:00.000Z",
      "occurred_before=2024-01-01T00:00:00.000Z",
      "occurred_after=2023-01-01T00:00:00.000Z&occurred_before=2024-01-01T00:00:00.000Z",
      // The exclusive edge, landing exactly on a row's own time, where an
      // off-by-one in either store shows up as one door returning a row the
      // other does not.
      "occurred_after=2023-06-15T12:00:00.000Z",
      "occurred_before=2023-06-15T12:00:00.000Z",
      // And the narrower spelling, which is normalized before a lexical
      // comparison sees it — separately in each store.
      "occurred_after=2023-06-15T12:00:00Z",
    ]) {
      expect(
        await searchIds(`q=${TOKEN}&${bound}`),
        `search and the item listing disagree under ${bound}`,
      ).toEqual(await listedIds(bound));
    }
  });

  it("refuses a bound name this door does not declare", async () => {
    // Stripped in silence, a misspelled bound returns the whole corpus at
    // 200 — a long answer that looks filtered. The refusal names what the
    // door does accept, so the caller can see the spelling it wanted.
    for (const wrong of ["since", "until", "occurred_at_after"]) {
      const res = await request(
        ctx.app,
        "GET",
        `/search?q=${TOKEN}&${wrong}=2023-01-01T00:00:00.000Z`,
        { key: ctx.workingKey },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { message: string; details?: { unknown_parameters?: string[] } };
      };
      expect(body.error.details?.unknown_parameters).toEqual([wrong]);
      expect(body.error.message).toContain("occurred_after");
    }
  });
});
