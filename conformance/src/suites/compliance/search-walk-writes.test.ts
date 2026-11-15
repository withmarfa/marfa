import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { SearchResult, TestContext } from "../../client/types.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";

/**
 * A walk of a sorted search while items and rows are written between its
 * pages (`search-and-filters/search-cursor-sorted-writes`, `tables/search-row-cursor-writes`):
 * every hit that exists throughout the walk, and whose sort value does not
 * change, is delivered once.
 */
let client: MarfaClient;
let ctx: TestContext;
let type: string;
let counter = 0;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "search-walk"));
  type = `user.search-walk-${ctx.runId}`;
  const made = await client.registerType({
    id: type,
    fields: { title: { type: "string" }, body: { type: "string" } },
    tables: {
      notes: { columns: { body: { type: "string", searchable: true } } },
    },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
});

afterAll(async () => {
  await cleanup(ctx);
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A word no other fixture writes, which the tokenizer keeps whole. */
function word(): string {
  counter += 1;
  return `walk${String(counter)}x${ctx.runId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

interface Made {
  id: string;
  version: number;
}

async function item(title: string, body: string): Promise<Made> {
  const made = await client.createItem({
    type,
    source: ctx.source,
    tier: "library",
    properties: { title, body },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return { id: made.data.item.id, version: made.data.item.version };
}

async function edit(made: Made, properties: Record<string, unknown>) {
  const res = await client.updateItem(made.id, {
    properties,
    version: made.version,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  made.version = res.data.item.version;
}

async function remove(made: Made) {
  const res = await client.deleteItem(made.id);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
}

/** Walk by two, running `between` once after the first page. */
async function walk(
  q: string,
  filters: Parameters<MarfaClient["search"]>[1],
  between: () => Promise<void>,
): Promise<SearchResult[]> {
  const seen: SearchResult[] = [];
  let cursor: string | undefined;
  let first = true;
  do {
    const res = await client.search(q, { ...filters, limit: 2, cursor });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    seen.push(...res.data.data);
    cursor = res.data.next_cursor ?? undefined;
    if (first) {
      expect(cursor, "the first page has a next page").toBeDefined();
      first = false;
      await between();
    }
  } while (cursor);
  return seen;
}

const ids = (hits: SearchResult[]) => hits.map((hit) => hit.item.id);

function once(hits: SearchResult[], ...want: Made[]) {
  const found = ids(hits);
  for (const made of want) {
    expect(
      found.filter((id) => id === made.id),
      made.id,
    ).toHaveLength(1);
  }
}

function never(hits: SearchResult[], ...want: Made[]) {
  const found = ids(hits);
  for (const made of want) expect(found).not.toContain(made.id);
}

describe("a sorted search walked while items change", () => {
  it("delivers each item that exists throughout once when items are created, edited and deleted between pages, in property order", async () => {
    const w = word();
    const t = (n: string) => `${w} title ${n}`;
    const made: Record<string, Made> = {};
    for (const n of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
      made[n] = await item(t(n), `${w} body ${n}`);
    }
    let before!: Made;
    let after!: Made;
    const hits = await walk(
      w,
      { sort: "properties.title", direction: "asc" },
      async () => {
        before = await item(t("00"), `${w} body before`);
        after = await item(t("09"), `${w} body after`);
        await remove(made["05"]!);
        await remove(made["01"]!);
        await edit(made["03"]!, { body: `${w} body three, edited` });
        // Moved from before the cursor to after it, so it may come twice.
        await edit(made["02"]!, { title: t("10") });
      },
    );
    once(hits, made["01"]!, made["03"]!, made["04"]!, made["06"]!);
    once(hits, made["07"]!, made["08"]!, after);
    never(hits, before, made["05"]!);
    expect(
      ids(hits).filter((id) => id === made["02"]!.id).length,
    ).toBeGreaterThanOrEqual(1);
    // The witness: the same words answer a plain read, so the walk was no
    // read of an empty result.
    const plain = await client.search(w, {
      sort: "properties.title",
      direction: "asc",
      limit: 100,
    });
    expect(ids(plain.data.data).length).toBeGreaterThanOrEqual(8);
  });

  it("delivers each item that exists throughout once while the ties of a value are split by a page and joined by a new item", async () => {
    const w = word();
    const same = `${w} same`;
    const tied: Made[] = [];
    for (let n = 0; n < 5; n++) tied.push(await item(same, `${w} tie ${n}`));
    const hits = await walk(
      w,
      { sort: "properties.title", direction: "desc" },
      async () => {
        await item(same, `${w} tie joined`);
        await remove(tied[4]!);
      },
    );
    once(hits, tied[0]!, tied[1]!, tied[2]!, tied[3]!);
    const found = ids(hits);
    expect(new Set(found).size).toBe(found.length);
  });

  it("delivers each item that exists throughout once, in last_activity_at order, whichever way and with new items at either end", async () => {
    for (const direction of ["asc", "desc"] as const) {
      const w = word();
      const made: Made[] = [];
      for (let n = 0; n < 7; n++) {
        made.push(await item(`${w} ${n}`, `${w} activity ${n}`));
        await wait(5);
      }
      let created!: Made;
      const hits = await walk(
        w,
        { sort: "last_activity_at", direction },
        async () => {
          created = await item(`${w} new`, `${w} activity new`);
          await remove(made[3]!);
          await remove(direction === "asc" ? made[0]! : made[6]!);
        },
      );
      for (const n of [1, 2, 4, 5]) once(hits, made[n]!);
      once(hits, direction === "asc" ? made[6]! : made[0]!);
      if (direction === "asc") once(hits, created);
      const found = ids(hits);
      expect(new Set(found).size, direction).toBe(found.length);
      never(hits, made[3]!);
    }
  });

  it("delivers each item that exists throughout once when a sort value changes between pages, never delivering an item that was not changed twice", async () => {
    const w = word();
    const made: Made[] = [];
    for (let n = 0; n < 6; n++) {
      made.push(await item(`${w} ${n}`, `${w} touched ${n}`));
      await wait(5);
    }
    const hits = await walk(
      w,
      { sort: "last_activity_at", direction: "asc" },
      async () => {
        await edit(made[0]!, { body: `${w} touched again` });
        await edit(made[4]!, { body: `${w} touched again` });
      },
    );
    once(hits, made[1]!, made[2]!, made[3]!, made[5]!);
    // An item that moved ahead of the cursor may come twice, one that moved
    // behind it once, and neither may be lost.
    for (const moved of [made[0]!, made[4]!]) {
      expect(ids(hits)).toContain(moved.id);
    }
  });
});

describe("a sorted search whose hits include rows, walked while rows change", () => {
  it("delivers each row that exists throughout once when rows are added and removed between pages", async () => {
    const w = word();
    const owner = await item(`${w} owner`, `${w} body`);
    const other = await item(`${w} other`, `${w} body`);
    const rowIds = Array.from({ length: 6 }, () => uuidv7()).sort();
    const put = async (on: Made, at: string[]) => {
      const res = await client.writeRows(on.id, "notes", {
        operations: at.map((id) => ({
          op: "put" as const,
          id,
          values: { body: `${w} row` },
        })),
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
    };
    await put(owner, rowIds);
    let late = "";
    const hits = await walk(
      w,
      { sort: "created_at", direction: "asc" },
      async () => {
        late = uuidv7();
        await put(owner, [late]);
        const gone = await client.writeRows(owner.id, "notes", {
          operations: [
            { op: "delete", id: rowIds[5]! },
            { op: "delete", id: rowIds[0]! },
          ],
        });
        expect(gone.status, JSON.stringify(gone.error)).toBe(200);
      },
    );
    const rows = hits.flatMap((hit) => (hit.row ? [hit.row.id] : []));
    for (const id of rowIds.slice(1, 5)) {
      expect(
        rows.filter((row) => row === id),
        id,
      ).toHaveLength(1);
    }
    expect(rows.filter((row) => row === late).length).toBeLessThanOrEqual(1);
    expect(rows).not.toContain(rowIds[5]);
    const found = hits.map((hit) => `${hit.item.id} ${hit.row?.id ?? ""}`);
    expect(new Set(found).size).toBe(found.length);
    once(hits, other);
    // The item's own hit comes once beside its row hits.
    expect(
      hits.filter((hit) => hit.item.id === owner.id && !hit.row),
    ).toHaveLength(1);
  });
});

describe("a search sorted by last_activity_at", () => {
  it("orders a search by last_activity_at, which a row moves and updated_at does not", async () => {
    const w = word();
    const first = await item(`${w} one`, `${w} body`);
    await wait(5);
    const second = await item(`${w} two`, `${w} body`);
    await wait(5);
    const third = await item(`${w} three`, `${w} body`);
    await wait(5);
    const row = uuidv7();
    const written = await client.writeRows(first.id, "notes", {
      operations: [{ op: "put", id: row, values: { body: `${w} row` } }],
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    const search = async (sort: string, direction: "asc" | "desc") => {
      const res = await client.search(w, { sort, direction, limit: 100 });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data.data;
    };
    // The witness: updated_at does not see the row, so the item stays first.
    expect(ids(await search("updated_at", "asc"))).toEqual([
      first.id,
      first.id,
      second.id,
      third.id,
    ]);
    const active = await search("last_activity_at", "desc");
    expect(active.map((hit) => `${hit.item.id} ${hit.row?.id ?? ""}`)).toEqual([
      `${first.id} `,
      `${first.id} ${row}`,
      `${third.id} `,
      `${second.id} `,
    ]);
    const quiet = await search("last_activity_at", "asc");
    expect(quiet.map((hit) => hit.item.id)).toEqual([
      second.id,
      third.id,
      first.id,
      first.id,
    ]);
  });
});
