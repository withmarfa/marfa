/**
 * `GET /search` takes the filters and the ordering of `GET /items` beside
 * its words: `source`, `updated_after`, `updated_before`, `sort` and
 * `direction`.
 *
 * Every case compares rows by identity against a control that holds all of
 * them, because a filter that is dropped and a filter that matched
 * everything cannot be told apart by status. The ordering cases ask the
 * listing the same question, since "behave as they do on `GET /items`" is
 * the claim.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  cleanupTestContext,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let otherKey: string;
let otherSource: string;
const WORD = `listingfilter${Math.random().toString(36).slice(2, 8)}`;
const TAG = `lf-${Math.random().toString(36).slice(2, 8)}`;

interface Seeded {
  id: string;
  updated_at: string;
}
// Created oldest to newest, so `created_at` and `updated_at` both run in
// this order; `occurred_at` runs the opposite way and `title` is absent on
// the last one.
const rows: Seeded[] = [];
let foreign: Seeded;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed(
  key: string,
  properties: Record<string, unknown>,
  occurredAt: string,
  source?: string,
): Promise<Seeded> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: {
      type: "core.note",
      properties,
      occurred_at: occurredAt,
      tags: [TAG],
      ...(source ? { source } : {}),
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as { item: Seeded };
  return { id: body.item.id, updated_at: body.item.updated_at };
}

beforeAll(async () => {
  ctx = await createTestContext();
  otherKey = await mintWorkingKey(ctx);
  const me = await request(ctx.app, "GET", "/keys/current", { key: otherKey });
  otherSource = ((await me.json()) as { source: string }).source;

  // A short body ranks best for the word, so relevance, `created_at` and
  // `title` each order the rows differently.
  const specs: [Record<string, unknown>, string][] = [
    [{ title: "pear", body: WORD }, "2026-03-01T00:00:00.000Z"],
    [
      { title: "apple", body: `${WORD} with some other words around it` },
      "2026-02-01T00:00:00.000Z",
    ],
    [
      {
        body: `${WORD} among a much longer run of further words that dilute the match for this row`,
      },
      "2026-01-01T00:00:00.000Z",
    ],
  ];
  for (const [properties, occurredAt] of specs) {
    rows.push(await seed(ctx.workingKey, properties, occurredAt));
    await wait(8);
  }
  foreign = await seed(
    otherKey,
    { title: "mango", body: `${WORD} other source` },
    "2026-04-01T00:00:00.000Z",
  );
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

const ids = () => rows.map((r) => r.id);

async function search(query: string): Promise<Response> {
  return request(ctx.app, "GET", `/search?q=${WORD}&${query}`, {
    key: ctx.workingKey,
  });
}

async function searchIds(query: string): Promise<string[]> {
  const res = await search(query);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { data: { item: { id: string } }[] };
  return body.data.map((r) => r.item.id);
}

async function listIds(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/items?tags=${TAG}&${query}`, {
    key: ctx.workingKey,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((r) => r.id);
}

const sorted = (list: string[]) => [...list].sort();

describe("GET /search source", () => {
  it("holds a row of each source without it, and only the named one with it", async () => {
    expect(sorted(await searchIds(""))).toEqual(sorted([...ids(), foreign.id]));
    const me = await request(ctx.app, "GET", "/keys/current", {
      key: ctx.workingKey,
    });
    const mine = ((await me.json()) as { source: string }).source;
    expect(sorted(await searchIds(`source=${mine}`))).toEqual(sorted(ids()));
    expect(await searchIds(`source=${otherSource}`)).toEqual([foreign.id]);
    expect(await searchIds("source=nobody-wrote-this")).toEqual([]);
  });

  it("refuses an empty source rather than answering every source", async () => {
    const res = await search("source=");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { empty_parameters?: string[] } };
    };
    expect(body.error.details?.empty_parameters).toEqual(["source"]);
  });
});

describe("GET /search updated_after and updated_before", () => {
  it("starts at the bound inclusively and ends before the upper bound", async () => {
    const [a, b, c] = rows;
    if (!a || !b || !c) throw new Error("seed");
    // The bound sits exactly on a row's own instant, so an exclusive lower
    // bound or an inclusive upper bound shows up as that row's presence.
    const atLeastB = await searchIds(`updated_after=${b.updated_at}`);
    expect(atLeastB).toContain(b.id);
    expect(atLeastB).toContain(c.id);
    expect(atLeastB).not.toContain(a.id);

    const beforeB = await searchIds(`updated_before=${b.updated_at}`);
    expect(beforeB).toContain(a.id);
    expect(beforeB).not.toContain(b.id);
    expect(beforeB).not.toContain(c.id);

    const window = await searchIds(
      `updated_after=${b.updated_at}&updated_before=${c.updated_at}`,
    );
    expect(window).toEqual([b.id]);
  });

  it("reads a bound in another offset as the instant it names", async () => {
    const b = rows[1];
    if (!b) throw new Error("seed");
    const instant = new Date(b.updated_at);
    const offset = `${new Date(instant.getTime() + 2 * 3_600_000)
      .toISOString()
      .slice(0, -1)}+02:00`;
    const viaOffset = await searchIds(
      `updated_after=${encodeURIComponent(offset)}`,
    );
    const viaUtc = await searchIds(`updated_after=${b.updated_at}`);
    expect(viaOffset).toContain(b.id);
    expect(sorted(viaOffset)).toEqual(sorted(viaUtc));
  });

  it("answers a value the listing would answer the same way, whatever its spelling", async () => {
    // Parity is the claim: for each spelling, both doors agree on whether
    // it is an instant, and on the rows when it is.
    const b = rows[1];
    if (!b) throw new Error("seed");
    for (const field of ["updated_after", "updated_before"]) {
      for (const value of [
        "2000-01-01",
        "2000-01-01T00:00:00",
        "2000-01-01T00:00:00+05:30",
        "yesterday",
        "2000-13-45T00:00:00Z",
      ]) {
        const query = `${field}=${encodeURIComponent(value)}`;
        const found = await search(query);
        const listed = await request(
          ctx.app,
          "GET",
          `/items?tags=${TAG}&${query}`,
          { key: ctx.workingKey },
        );
        expect(found.status, `${query} on search`).toBe(listed.status);
        if (listed.status === 200) {
          expect(sorted(await searchIds(query))).toEqual(
            sorted(await listIds(query)),
          );
        }
      }
    }
  });

  it("does not order the results by the time it bounds", async () => {
    const a = rows[0];
    if (!a) throw new Error("seed");
    // The listing orders a catch-up by `updated_at` ascending and refuses a
    // contradicting sort; a search ranks by its own sort, so both are taken.
    const ordered = await searchIds(
      `updated_after=${a.updated_at}&sort=created_at&direction=desc`,
    );
    expect(ordered).toEqual(
      (await searchIds("sort=created_at&direction=desc")).filter((id) =>
        [...ids(), foreign.id].includes(id),
      ),
    );
  });
});

describe("GET /search sort and direction", () => {
  it("orders by relevance, best match first, unless told otherwise", async () => {
    const res = await search("");
    const body = (await res.json()) as {
      data: { item: { id: string }; relevance_score: number }[];
    };
    const scores = body.data.map((r) => r.relevance_score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(new Set(scores).size).toBeGreaterThan(1);
    expect(await searchIds("sort=relevance")).toEqual(await searchIds(""));
    expect(await searchIds("sort=relevance&direction=desc")).toEqual(
      await searchIds(""),
    );
  });

  it("puts the worst match first for relevance ascending", async () => {
    const best = await searchIds("");
    expect(await searchIds("direction=asc")).toEqual([...best].reverse());
    expect(await searchIds("sort=relevance&direction=asc")).toEqual(
      [...best].reverse(),
    );
  });

  it("orders by a time as the listing does, in either direction", async () => {
    for (const sort of ["created_at", "updated_at", "occurred_at"]) {
      for (const direction of ["asc", "desc"]) {
        const query = `sort=${sort}&direction=${direction}`;
        // The foreign row is in the corpus of the search and not of the
        // listing tag filter's source, so compare the rows both hold.
        const found = (await searchIds(query)).filter((id) =>
          ids().includes(id),
        );
        expect(found, query).toEqual(
          (await listIds(query)).filter((id) => ids().includes(id)),
        );
      }
    }
    // The witness that the three columns disagree, so the cases above can
    // fail: created_at runs the way the rows were made, occurred_at the
    // other way.
    expect(
      (await searchIds("sort=created_at&direction=asc")).filter((id) =>
        ids().includes(id),
      ),
    ).toEqual(ids());
    expect(
      (await searchIds("sort=occurred_at&direction=asc")).filter((id) =>
        ids().includes(id),
      ),
    ).toEqual([...ids()].reverse());
  });

  it("defaults a time sort to newest first, as the listing does", async () => {
    expect(
      (await searchIds("sort=created_at")).filter((id) => ids().includes(id)),
    ).toEqual([...ids()].reverse());
  });

  it("sorts by a property and puts the rows without one last in both directions", async () => {
    const [pear, apple, untitled] = ids();
    if (!pear || !apple || !untitled) throw new Error("seed");
    const mine = (list: string[]) => list.filter((id) => ids().includes(id));
    expect(
      mine(await searchIds("sort=properties.title&direction=asc")),
    ).toEqual([apple, pear, untitled]);
    expect(
      mine(await searchIds("sort=properties.title&direction=desc")),
    ).toEqual([pear, apple, untitled]);
    // The row the other source wrote carries a title too, and sorts with
    // them rather than after.
    const all = await searchIds("sort=properties.title&direction=asc");
    expect(all.at(-1)).toBe(untitled);
    expect(all).toHaveLength(4);
  });

  it("sorts by a property no row holds without dropping or repeating a row", async () => {
    const found = await searchIds("sort=properties.nothing_here&direction=asc");
    expect(sorted(found)).toEqual(sorted([...ids(), foreign.id]));
    // Ties fall to the item ID, ascending.
    expect(found).toEqual(sorted(found));
    expect(
      await searchIds("sort=properties.nothing_here&direction=desc"),
    ).toEqual(found);
  });

  it("refuses a sort the listing refuses", async () => {
    for (const bad of [
      "sort=title",
      "sort=properties.Title",
      "sort=properties.a.b",
      "sort=updated",
      "direction=up",
    ]) {
      const res = await search(bad);
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("GET /search cursor", () => {
  async function page(query: string): Promise<{
    ids: string[];
    next: string | null;
  }> {
    const res = await search(query);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      data: { item: { id: string } }[];
      next_cursor: string | null;
    };
    return { ids: body.data.map((r) => r.item.id), next: body.next_cursor };
  }

  it("walks a sorted search to the end, delivering every row once", async () => {
    for (const query of [
      "sort=updated_at&direction=asc",
      "sort=properties.title&direction=desc",
      "direction=asc",
    ]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const next: { ids: string[]; next: string | null } = await page(
          `${query}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
        seen.push(...next.ids);
        cursor = next.next;
      } while (cursor);
      expect(seen, query).toEqual(await searchIds(query));
      expect(new Set(seen).size, query).toBe(seen.length);
    }
  });

  it("refuses a cursor under another sort, direction or filter", async () => {
    const first = await page("sort=updated_at&direction=asc&limit=1");
    expect(first.next).not.toBeNull();
    const cursor = encodeURIComponent(first.next ?? "");
    for (const changed of [
      "sort=created_at&direction=asc",
      "sort=updated_at&direction=desc",
      "sort=updated_at",
      "direction=asc",
      `sort=updated_at&direction=asc&source=${otherSource}`,
      `sort=updated_at&direction=asc&updated_after=${rows[0]?.updated_at ?? ""}`,
      `sort=updated_at&direction=asc&updated_before=${foreign.updated_at}`,
    ]) {
      const res = await search(`${changed}&limit=1&cursor=${cursor}`);
      expect(res.status, changed).toBe(400);
    }
    // The witness: the same cursor continues where it was issued.
    const same = await search(
      `sort=updated_at&direction=asc&limit=1&cursor=${cursor}`,
    );
    expect(same.status).toBe(200);
  });

  it("continues a cursor whether the default order is spelled out or left out", async () => {
    const first = await page("limit=1");
    const cursor = encodeURIComponent(first.next ?? "");
    const res = await search(
      `sort=relevance&direction=desc&limit=1&cursor=${cursor}`,
    );
    expect(res.status).toBe(200);
  });
});
