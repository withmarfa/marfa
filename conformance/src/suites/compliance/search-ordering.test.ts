import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

/**
 * What a search takes beside its words: an update-time bound, a sort and a
 * direction (`search-and-filters/search-sort-relevance` to
 * `search-and-filters/search-cursor-parameters`).
 *
 * Four rows share a word. They are made oldest first, so `created_at` and
 * `updated_at` run in that order, `occurred_at` runs the other way, a
 * shorter body ranks higher, `title` orders them alphabetically and the last
 * has none. Two further rows hold the same body and no title, so they tie on
 * relevance and on the property.
 */
let client: MarfaClient;
let ctx: TestContext;
let word: string;

interface Row {
  id: string;
  updated_at: string;
}
const rows: Row[] = [];
const twins: Row[] = [];
let all: string[];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed(
  properties: Record<string, unknown>,
  occurredAt: string,
): Promise<Row> {
  const made = await client.createItem({
    type: "core.note",
    source: ctx.source,
    tier: "library",
    properties,
    occurred_at: occurredAt,
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return { id: made.data.item.id, updated_at: made.data.item.updated_at };
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "search-ordering"));
  word = `searchordering${ctx.runId}`;
  const specs: [Record<string, unknown>, string][] = [
    [{ title: "pear", body: word }, "2026-04-01T00:00:00.000Z"],
    [
      { title: "apple", body: `${word} with some other words around it` },
      "2026-03-01T00:00:00.000Z",
    ],
    [
      {
        title: "quince",
        body: `${word} a longer run of words around it that dilutes the match`,
      },
      "2026-02-01T00:00:00.000Z",
    ],
    [
      {
        body: `${word} among a much longer run of further words that dilute the match for this one row of the four`,
      },
      "2026-01-01T00:00:00.000Z",
    ],
  ];
  for (const [properties, occurredAt] of specs) {
    rows.push(await seed(properties, occurredAt));
    await wait(8);
  }
  for (let i = 0; i < 2; i++) {
    twins.push(
      await seed(
        { body: `${word} identical twin body of the pair, unlike the others` },
        "2025-12-01T00:00:00.000Z",
      ),
    );
    await wait(8);
  }
  all = [...rows, ...twins].map((row) => row.id);
});

afterAll(async () => {
  await cleanup(ctx);
});

const enc = encodeURIComponent;

async function ids(
  filters: Parameters<MarfaClient["search"]>[1] = {},
): Promise<string[]> {
  const res = await client.search(word, filters);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data.data.map((hit) => hit.item.id);
}

describe("search ordering", () => {
  it("orders a search by relevance, best match first, and worst first when ascending", async () => {
    const res = await client.search(word);
    expect(res.status).toBe(200);
    const scores = res.data.data.map((hit) => hit.relevance_score);
    // The witness: the rows do not all rank alike, so the order can differ.
    expect(new Set(scores).size).toBeGreaterThan(1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    const best = res.data.data.map((hit) => hit.item.id);
    expect(await ids({ sort: "relevance" })).toEqual(best);
    expect(await ids({ sort: "relevance", direction: "desc" })).toEqual(best);

    const worst = await client.search(word, {
      sort: "relevance",
      direction: "asc",
    });
    const ascending = worst.data.data.map((hit) => hit.relevance_score);
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
    expect(await ids({ direction: "asc" })).toEqual(
      worst.data.data.map((hit) => hit.item.id),
    );
  });

  it("orders a search by a time column, newest first unless told otherwise", async () => {
    const made = [...rows, ...twins].map((row) => row.id);
    const mine = (list: string[]) => list.filter((id) => made.includes(id));
    expect(mine(await ids({ sort: "created_at" }))).toEqual(
      [...made].reverse(),
    );
    expect(mine(await ids({ sort: "created_at", direction: "desc" }))).toEqual(
      [...made].reverse(),
    );
    expect(mine(await ids({ sort: "created_at", direction: "asc" }))).toEqual(
      made,
    );
    expect(mine(await ids({ sort: "updated_at", direction: "asc" }))).toEqual(
      made,
    );
    // The witness that the columns differ: occurred_at runs the other way
    // for the four rows.
    const four = rows.map((row) => row.id);
    expect(
      (await ids({ sort: "occurred_at", direction: "asc" })).filter((id) =>
        four.includes(id),
      ),
    ).toEqual([...four].reverse());
  });

  it("orders a search by a property with the rows that lack one last in both directions", async () => {
    const [pear, apple, quince, untitled] = rows.map((row) => row.id);
    const [twinA, twinB] = twins.map((row) => row.id).sort();
    if (!pear || !apple || !quince || !untitled || !twinA || !twinB)
      throw new Error("seed");
    const nulls = [untitled, twinA, twinB].sort();
    expect(await ids({ sort: "properties.title", direction: "asc" })).toEqual([
      apple,
      pear,
      quince,
      ...nulls,
    ]);
    expect(await ids({ sort: "properties.title", direction: "desc" })).toEqual([
      quince,
      pear,
      apple,
      ...nulls,
    ]);
  });

  it("breaks a tie by item ID, ascending", async () => {
    const [twinA, twinB] = twins.map((row) => row.id).sort();
    if (!twinA || !twinB) throw new Error("seed");
    for (const direction of ["asc", "desc"] as const) {
      const byRelevance = await ids({ direction });
      expect(byRelevance.indexOf(twinA), direction).toBeLessThan(
        byRelevance.indexOf(twinB),
      );
    }
    // A property no row holds ties every hit.
    const none = await ids({ sort: "properties.nothing_here" });
    expect(none).toEqual([...all].sort());
    expect(
      await ids({ sort: "properties.nothing_here", direction: "asc" }),
    ).toEqual(none);
  });

  it("refuses a sort or direction it does not take", async () => {
    for (const bad of [
      "sort=title",
      "sort=properties.Title",
      "sort=properties.a.b",
      "sort=updated",
      "direction=up",
    ]) {
      const res = await client.rawRequest<unknown>(`/search?q=${word}&${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.error?.error.code, bad).toBe("validation_error");
    }
    // The witness: the same search without the bad key is answered.
    expect((await client.search(word)).status).toBe(200);
  });
});

describe("search update-time bounds", () => {
  it("bounds a search by updated_at, inclusive below and exclusive above", async () => {
    const [a, b, c] = rows;
    if (!a || !b || !c) throw new Error("seed");
    const from = await ids({ updated_after: b.updated_at });
    expect(from).toContain(b.id);
    expect(from).toContain(c.id);
    expect(from).not.toContain(a.id);
    const before = await ids({ updated_before: b.updated_at });
    expect(before).toContain(a.id);
    expect(before).not.toContain(b.id);
    expect(
      await ids({ updated_after: b.updated_at, updated_before: c.updated_at }),
    ).toEqual([b.id]);
  });

  it("reads an update bound as the instant it names, in any offset", async () => {
    const b = rows[1];
    if (!b) throw new Error("seed");
    const shifted = `${new Date(
      new Date(b.updated_at).getTime() + 2 * 3_600_000,
    )
      .toISOString()
      .slice(0, -1)}+02:00`;
    expect(await ids({ updated_after: shifted })).toEqual(
      await ids({ updated_after: b.updated_at }),
    );
    expect(await ids({ updated_before: shifted })).toEqual(
      await ids({ updated_before: b.updated_at }),
    );
  });

  it("refuses an update bound that is not an instant", async () => {
    for (const key of ["updated_after", "updated_before"]) {
      for (const value of ["yesterday", "2000-13-45T00:00:00Z"]) {
        const res = await client.rawRequest<unknown>(
          `/search?q=${word}&${key}=${enc(value)}`,
        );
        expect(res.status, `${key}=${value}`).toBe(400);
        expect(res.error?.error.code).toBe("validation_error");
      }
    }
    // The witness: an instant is taken.
    expect(
      (await client.search(word, { updated_after: "2000-01-01" })).status,
    ).toBe(200);
  });

  it("leaves the order to sort and direction when updated_after is named", async () => {
    const a = rows[0];
    if (!a) throw new Error("seed");
    const plain = await ids({ sort: "created_at", direction: "desc" });
    expect(
      await ids({
        updated_after: a.updated_at,
        sort: "created_at",
        direction: "desc",
      }),
    ).toEqual(plain);
    // And with neither, the order is the ranking, not updated_at ascending.
    expect(await ids({ updated_after: a.updated_at })).toEqual(await ids());
  });
});

describe("search cursor", () => {
  async function walk(
    filters: Parameters<MarfaClient["search"]>[1],
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.search(word, { ...filters, limit: 2, cursor });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      seen.push(...res.data.data.map((hit) => hit.item.id));
      cursor = res.data.next_cursor ?? undefined;
    } while (cursor);
    return seen;
  }

  it("walks a sorted search to the end, delivering every hit once", async () => {
    for (const filters of [
      { sort: "updated_at", direction: "asc" as const },
      { sort: "properties.title", direction: "desc" as const },
      { direction: "asc" as const },
    ]) {
      const seen = await walk(filters);
      expect(seen, JSON.stringify(filters)).toEqual(await ids(filters));
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it("refuses a cursor issued under another sort, direction or filter", async () => {
    const first = await client.search(word, {
      sort: "updated_at",
      direction: "asc",
      limit: 2,
    });
    const cursor = first.data.next_cursor;
    expect(cursor).not.toBeNull();
    const [a, , c] = rows;
    const changed = [
      { sort: "created_at", direction: "asc" as const },
      { sort: "updated_at", direction: "desc" as const },
      { sort: "updated_at" },
      { direction: "asc" as const },
      { sort: "updated_at", direction: "asc" as const, source: ctx.source },
      {
        sort: "updated_at",
        direction: "asc" as const,
        updated_after: a?.updated_at,
      },
      {
        sort: "updated_at",
        direction: "asc" as const,
        updated_before: c?.updated_at,
      },
    ];
    for (const filters of changed) {
      const res = await client.search(word, {
        ...filters,
        limit: 2,
        cursor: cursor ?? undefined,
      });
      expect(res.status, JSON.stringify(filters)).toBe(400);
      expect(res.error?.error.code).toBe("validation_error");
    }
    // The witness: the same cursor continues where it was issued.
    const same = await client.search(word, {
      sort: "updated_at",
      direction: "asc",
      limit: 2,
      cursor: cursor ?? undefined,
    });
    expect(same.status).toBe(200);
  });

  it("continues a cursor whether the default order is spelled out or left out", async () => {
    const first = await client.search(word, { limit: 2 });
    const spelled = await client.search(word, {
      sort: "relevance",
      direction: "desc",
      limit: 2,
      cursor: first.data.next_cursor ?? undefined,
    });
    expect(spelled.status, JSON.stringify(spelled.error)).toBe(200);
  });
});
