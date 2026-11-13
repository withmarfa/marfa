import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { RowOperation, TestContext } from "../../client/types.js";
import {
  createTestContext,
  getManagementClient,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "table-rows-reads",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

let counter = 0;

async function spendingItem(): Promise<{ type: string; item: string }> {
  counter += 1;
  const type = `user.rows-reads-${counter}-${ctx.runId}`;
  const made = await client.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: {
      spend: {
        label: "Spending",
        columns: {
          amount: { type: "number", adds_up: "sum" },
          mean: { type: "number", adds_up: "average" },
          units: { type: "integer", adds_up: "max" },
          memo: { type: "string", adds_up: "count" },
          at: { type: "datetime", adds_up: "min" },
          on: { type: "date", adds_up: "max" },
        },
      },
      empty: { columns: { note: { type: "string" } } },
    },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const item = await client.createItem({
    type,
    properties: { title: "Spending" },
  } as never);
  expect(item.status, JSON.stringify(item.error)).toBe(201);
  trackItem(ctx, item.data.item.id);
  return { type, item: item.data.item.id };
}

async function put(
  item: string,
  rows: Record<string, unknown>[],
  ids?: string[],
) {
  const operations: RowOperation[] = rows.map((values, n) => ({
    op: "put",
    ...(ids ? { id: ids[n] } : {}),
    values,
  }));
  const res = await client.writeRows(item, "spend", { operations });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data;
}

describe("reading rows", () => {
  it("lists the tables an item's type declares with what each holds", async () => {
    const { item } = await spendingItem();
    const before = await client.listTables(item);
    expect(before.status, JSON.stringify(before.error)).toBe(200);
    await expectMatchesSchema("GET", "/items/{id}/tables", 200, before.data);
    expect(before.data.data).toEqual([
      {
        name: "empty",
        label: "Empty",
        row_count: 0,
        bytes: 0,
        last_batch: null,
        changed_at: null,
      },
      {
        name: "spend",
        label: "Spending",
        row_count: 0,
        bytes: 0,
        last_batch: null,
        changed_at: null,
      },
    ]);
    const written = await put(item, [
      { amount: 1 },
      { amount: 2, memo: "two" },
    ]);
    const after = (await client.listTables(item)).data.data;
    const spend = after.find((t) => t.name === "spend");
    expect(spend).toMatchObject({ row_count: 2, last_batch: written.batch });
    expect(spend?.bytes).toBeGreaterThan(0);
    expect(spend?.changed_at).toBe(written.last_activity_at);
    expect(after.find((t) => t.name === "empty")?.row_count).toBe(0);
  });

  it("pages a table's rows by id, continuing by a signed cursor", async () => {
    const { item } = await spendingItem();
    const ids = Array.from({ length: 25 }, () => uuidv7());
    await put(
      item,
      ids.map((_, n) => ({ amount: n })),
      [...ids].reverse(),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await client.listRows(item, "spend", { limit: 10, cursor });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      await expectMatchesSchema(
        "GET",
        "/items/{id}/tables/{table}/rows",
        200,
        res.data,
      );
      seen.push(...res.data.data.map((r) => r.id));
      if (!res.data.next_cursor) break;
      cursor = res.data.next_cursor;
    }
    expect(seen).toEqual([...ids].sort());

    const first = await client.listRows(item, "spend", { limit: 10 });
    const other = await spendingItem();
    await put(other.item, [{ amount: 1 }]);
    for (const res of [
      await client.listRows(other.item, "spend", {
        cursor: first.data.next_cursor!,
      }),
      await client.listRows(item, "empty", { cursor: first.data.next_cursor! }),
      await client.listRows(item, "spend", {
        cursor: first.data.next_cursor!,
        filter: "values.amount gt 3",
      }),
      await client.listRows(item, "spend", {
        cursor: first.data.next_cursor!,
        sort: "updated_at",
      }),
      await client.listRows(item, "spend", { cursor: "not-a-cursor" }),
    ]) {
      expect(res.status).toBe(400);
      expect(res.error?.error.code).toBe("validation_error");
      expect(res.error?.error.details).toMatchObject({ field: "cursor" });
    }
    for (const limit of [0, 1001, 1.5]) {
      const res = await client.listRows(item, "spend", { limit });
      expect(res.status, String(limit)).toBe(400);
      expect(res.error?.error.details).toMatchObject({ field: "limit" });
    }
    expect(
      (await client.listRows(item, "spend", { limit: 1000 })).data.data,
    ).toHaveLength(25);
  });

  it("refuses a cursor answered for the other direction", async () => {
    const { item } = await spendingItem();
    await put(
      item,
      Array.from({ length: 5 }, (_, n) => ({ amount: n })),
    );
    for (const direction of ["asc", "desc"] as const) {
      const first = await client.listRows(item, "spend", {
        limit: 2,
        sort: "values.amount",
        direction,
      });
      expect(first.data.next_cursor).toEqual(expect.any(String));
      const same = await client.listRows(item, "spend", {
        limit: 2,
        sort: "values.amount",
        direction,
        cursor: first.data.next_cursor!,
      });
      expect(same.status, JSON.stringify(same.error)).toBe(200);
      const res = await client.listRows(item, "spend", {
        limit: 2,
        sort: "values.amount",
        direction: direction === "asc" ? "desc" : "asc",
        cursor: first.data.next_cursor!,
      });
      expect(res.status).toBe(400);
      expect(res.error?.error.code).toBe("validation_error");
      expect(res.error?.error.details).toMatchObject({ field: "cursor" });
    }
  });

  it("keeps a cursor short however long the sort value is, and follows the row it names", async () => {
    const { item } = await spendingItem();
    const long = (tail: string) => `${"a".repeat(54_000 - tail.length)}${tail}`;
    const written = await put(
      item,
      ["0004", "0002", "0005", "0001", "0003"].map((tail) => ({
        amount: 1,
        memo: long(tail),
      })),
    );
    const ids = written.results.map((r) => r.id);
    for (const direction of ["asc", "desc"] as const) {
      const whole = (
        await client.listRows(item, "spend", {
          sort: "values.memo",
          direction,
          limit: 1000,
        })
      ).data.data.map((r) => r.id);
      expect([...whole].sort()).toEqual([...ids].sort());
      const paged: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await client.listRows(item, "spend", {
          sort: "values.memo",
          direction,
          limit: 2,
          cursor,
        });
        expect(res.status, JSON.stringify(res.error)).toBe(200);
        paged.push(...res.data.data.map((r) => r.id));
        cursor = res.data.next_cursor ?? undefined;
        if (cursor) expect(cursor.length).toBeLessThanOrEqual(512);
        pages += 1;
      } while (cursor);
      expect(pages).toBe(3);
      expect(paged).toEqual(whole);
    }

    const first = await client.listRows(item, "spend", {
      sort: "values.memo",
      limit: 2,
    });
    const cursor = first.data.next_cursor!;
    const last = first.data.data[1]!.id;
    const follows = async () =>
      client.listRows(item, "spend", {
        sort: "values.memo",
        limit: 2,
        cursor,
      });
    expect((await follows()).status).toBe(200);

    const changed = await client.writeRows(item, "spend", {
      operations: [{ op: "patch", id: last, values: { memo: long("0009") } }],
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    const moved = await follows();
    expect(moved.status).toBe(400);
    expect(moved.error?.error.code).toBe("validation_error");
    expect(moved.error?.error.details).toMatchObject({ field: "cursor" });

    const restored = await client.writeRows(item, "spend", {
      operations: [{ op: "patch", id: last, values: { memo: long("0002") } }],
    });
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect((await follows()).status).toBe(200);

    const removed = await client.writeRows(item, "spend", {
      operations: [{ op: "delete", id: last }],
    });
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    const gone = await follows();
    expect(gone.status).toBe(400);
    expect(gone.error?.error.details).toMatchObject({ field: "cursor" });
  });

  it("pages rows that share a long sort value without skipping or repeating one", async () => {
    const { item } = await spendingItem();
    const a = "a".repeat(200);
    const b = "b".repeat(200);
    const written = await put(
      item,
      [a, a, a, a, a, b, b, b, "short", "short", "é".repeat(100)].map(
        (memo) => ({ amount: 1, memo }),
      ),
    );
    const ids = written.results.map((r) => r.id);
    for (const direction of ["asc", "desc"] as const) {
      const whole = (
        await client.listRows(item, "spend", {
          sort: "values.memo",
          direction,
          limit: 1000,
        })
      ).data.data.map((r) => r.id);
      expect([...whole].sort()).toEqual([...ids].sort());
      for (const limit of [1, 2, 3]) {
        const paged: string[] = [];
        let cursor: string | undefined;
        do {
          const res = await client.listRows(item, "spend", {
            sort: "values.memo",
            direction,
            limit,
            cursor,
          });
          expect(res.status, JSON.stringify(res.error)).toBe(200);
          paged.push(...res.data.data.map((r) => r.id));
          cursor = res.data.next_cursor ?? undefined;
        } while (cursor);
        expect(paged, `${direction} ${limit}`).toEqual(whole);
      }
    }
  });

  it("filters rows on columns with the item filter grammar", async () => {
    const { item } = await spendingItem();
    const written = await put(item, [
      { amount: 5, memo: "Coffee beans" },
      { amount: 50, memo: "Train" },
      { amount: 500 },
    ]);
    const ids = written.results.map((r) => r.id);
    const select = async (filter: string) => {
      const res = await client.listRows(item, "spend", { filter });
      expect(res.status, `${filter}: ${JSON.stringify(res.error)}`).toBe(200);
      return res.data.data.map((r) => r.id);
    };
    expect(await select("values.amount gt 10")).toEqual(
      [ids[1], ids[2]].sort(),
    );
    expect(await select("values.amount lte 50 AND values.memo exists")).toEqual(
      [ids[0], ids[1]].sort(),
    );
    expect(await select('values.memo contains "coffee"')).toEqual([ids[0]]);
    expect(await select("values.memo not_exists")).toEqual([ids[2]]);
    expect(await select(`id eq "${ids[1]}" OR values.amount eq 500`)).toEqual(
      [ids[1], ids[2]].sort(),
    );
    expect(await select('updated_at gte "2000-01-01T00:00:00Z"')).toHaveLength(
      3,
    );
    const totals = await client.rowTotals(
      item,
      "spend",
      "values.amount lt 100",
    );
    expect(totals.data.row_count).toBe(2);

    for (const filter of [
      "values.colour eq 1",
      "properties.amount eq 1",
      'state eq "active"',
      "values.amount eq",
      "tags exists",
    ]) {
      for (const res of [
        await client.listRows(item, "spend", { filter }),
        await client.rowTotals(item, "spend", filter),
      ]) {
        expect(res.status, filter).toBe(400);
        expect(res.error?.error.code).toBe("validation_error");
        expect(res.error?.error.details).toMatchObject({ field: "filter" });
      }
    }
  });

  it("sorts rows on a column, rows without it last", async () => {
    const { item } = await spendingItem();
    const written = await put(item, [
      { amount: 2 },
      { memo: "none" },
      { amount: 10 },
      { amount: 2 },
    ]);
    const [two, none, ten, twoAgain] = written.results.map((r) => r.id);
    const order = async (direction: "asc" | "desc") =>
      (
        await client.listRows(item, "spend", {
          sort: "values.amount",
          direction,
        })
      ).data.data.map((r) => r.id);
    const ties = [two!, twoAgain!].sort();
    expect(await order("asc")).toEqual([...ties, ten, none]);
    expect(await order("desc")).toEqual([ten, ...ties, none]);
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.listRows(item, "spend", {
        sort: "values.amount",
        direction: "desc",
        limit: 1,
        cursor,
      });
      paged.push(...res.data.data.map((r) => r.id));
      cursor = res.data.next_cursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual([ten, ...ties, none]);
    const byId = (
      await client.listRows(item, "spend", { sort: "id", direction: "desc" })
    ).data.data.map((r) => r.id);
    expect(byId).toEqual([two, none, ten, twoAgain].sort().reverse());
    const refused = await client.listRows(item, "spend", {
      sort: "values.colour",
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.details).toMatchObject({ field: "sort" });
  });

  it("reads one row, and answers row_not_found for a row the table does not hold", async () => {
    const { item } = await spendingItem();
    const written = await put(item, [{ amount: 3, memo: "three" }]);
    const id = written.results[0]!.id;
    const row = await client.getRow(item, "spend", id);
    expect(row.status).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/items/{id}/tables/{table}/rows/{row}",
      200,
      row.data,
    );
    expect(row.data).toEqual({
      id,
      values: { amount: 3, memo: "three" },
      updated_at: written.last_activity_at,
    });
    const missing = await client.getRow(item, "spend", uuidv7());
    expect(missing.status).toBe(404);
    expect(missing.error?.error.code).toBe("row_not_found");
    const malformed = await client.getRow(item, "spend", "row-1");
    expect(malformed.status).toBe(404);
    expect(malformed.error?.error.code).toBe("row_not_found");
  });

  it("totals each column that adds up, over the rows a filter selects", async () => {
    const { item } = await spendingItem();
    await put(item, [
      {
        amount: 1.5,
        mean: 2,
        units: 3,
        memo: "a",
        at: "2026-01-01T10:00:00+02:00",
        on: "2026-01-02",
      },
      {
        amount: 2.5,
        mean: 4,
        units: 7,
        at: "2026-01-01T09:00:00Z",
        on: "2026-03-01",
      },
      { amount: 10, memo: "c" },
    ]);
    const all = await client.rowTotals(item, "spend");
    expect(all.status, JSON.stringify(all.error)).toBe(200);
    await expectMatchesSchema(
      "GET",
      "/items/{id}/tables/{table}/totals",
      200,
      all.data,
    );
    expect(all.data).toEqual({
      row_count: 3,
      totals: {
        amount: { sum: 14 },
        mean: { average: 3 },
        units: { max: 7 },
        memo: { count: 2 },
        at: { min: "2026-01-01T08:00:00.000Z" },
        on: { max: "2026-03-01" },
      },
    });
    const some = await client.rowTotals(item, "spend", "values.amount lt 5");
    expect(some.data.row_count).toBe(2);
    expect(some.data.totals.amount).toEqual({ sum: 4 });
    expect(some.data.totals.memo).toEqual({ count: 1 });
  });

  it("totals nothing as zero or null", async () => {
    const { item } = await spendingItem();
    const none = await client.rowTotals(item, "spend");
    expect(none.data).toEqual({
      row_count: 0,
      totals: {
        amount: { sum: 0 },
        mean: { average: null },
        units: { max: null },
        memo: { count: 0 },
        at: { min: null },
        on: { max: null },
      },
    });
  });

  it("filters, sorts, totals and pages a withheld item id as no value", async () => {
    counter += 1;
    const hiddenType = `user.rows-reads-hidden-${counter}-${ctx.runId}`;
    const shownType = `user.rows-reads-shown-${counter}-${ctx.runId}`;
    const type = `user.rows-reads-links-${counter}-${ctx.runId}`;
    for (const id of [hiddenType, shownType]) {
      const made = await client.registerType({
        id,
        fields: { title: { type: "string" } },
      } as never);
      expect(made.status, JSON.stringify(made.error)).toBe(201);
    }
    const made = await client.registerType({
      id: type,
      fields: { title: { type: "string" } },
      tables: {
        links: {
          columns: {
            amount: { type: "number" },
            about: { type: "item", adds_up: "count" },
          },
        },
      },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const itemOf = async (of: string) => {
      const res = await client.createItem({
        type: of,
        properties: { title: of },
      } as never);
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      trackItem(ctx, res.data.item.id);
      return res.data.item.id;
    };
    const hidden = await itemOf(hiddenType);
    const shown = await itemOf(shownType);
    const item = await itemOf(type);
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    const written = await client.writeRows(item, "links", {
      operations: [
        { op: "put", id: ids[0], values: { amount: 1, about: hidden } },
        { op: "put", id: ids[1], values: { amount: 2, about: shown } },
        { op: "put", id: ids[2], values: { amount: 3 } },
      ],
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    const [withHidden, withShown, without] = ids as [string, string, string];
    counter += 1;
    const key = await client.createKey({
      label: `rows-reads-${counter}`,
      source: `${ctx.source}-reads-${counter}`,
      type_permissions: { [type]: "read", [shownType]: "read" },
    });
    expect(key.ok, JSON.stringify(key.error)).toBe(true);
    trackKey(ctx, key.data.id);
    const reader = new MarfaClient({ baseUrl: apiUrl, apiKey: key.data.key });

    const selected = async (as: MarfaClient, filter: string) =>
      (await as.listRows(item, "links", { filter })).data.data.map((r) => r.id);
    const named = `values.about eq "${hidden}"`;
    expect(await selected(client, named)).toEqual([withHidden]);
    expect(await selected(reader, named)).toEqual([]);
    expect(await selected(client, "values.about exists")).toEqual([
      withHidden,
      withShown,
    ]);
    expect(await selected(reader, "values.about exists")).toEqual([withShown]);
    expect(await selected(reader, "values.about not_exists")).toEqual([
      withHidden,
      without,
    ]);

    const totals = async (as: MarfaClient, filter?: string) =>
      (await as.rowTotals(item, "links", filter)).data;
    expect(await totals(client)).toMatchObject({
      totals: { about: { count: 2 } },
    });
    expect(await totals(reader)).toMatchObject({
      totals: { about: { count: 1 } },
    });
    expect(await totals(client, named)).toMatchObject({ row_count: 1 });
    expect(await totals(reader, named)).toMatchObject({
      row_count: 0,
      totals: { about: { count: 0 } },
    });

    const paged = async (as: MarfaClient) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await as.listRows(item, "links", {
          sort: "values.about",
          limit: 1,
          cursor,
        });
        expect(res.status, JSON.stringify(res.error)).toBe(200);
        seen.push(...res.data.data.map((r) => r.id));
        cursor = res.data.next_cursor ?? undefined;
      } while (cursor);
      return seen;
    };
    expect(await paged(client)).toEqual([withHidden, withShown, without]);
    expect(await paged(reader)).toEqual([withShown, withHidden, without]);
  });
});

describe("sorting by a table's order", () => {
  async function ordered(
    columns: Record<string, unknown>,
    order: string,
  ): Promise<{ type: string; item: string; table: Record<string, unknown> }> {
    counter += 1;
    const type = `user.rows-order-${counter}-${ctx.runId}`;
    const table = { columns, order };
    const made = await client.registerType({
      id: type,
      fields: { title: { type: "string" } },
      tables: { lines: table },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const item = await client.createItem({
      type,
      properties: { title: "Ordered" },
    } as never);
    expect(item.status, JSON.stringify(item.error)).toBe(201);
    trackItem(ctx, item.data.item.id);
    return { type, item: item.data.item.id, table };
  }

  async function write(item: string, operations: RowOperation[]) {
    const res = await client.writeRows(item, "lines", { operations });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    return res.data.results.map((r) => r.id);
  }

  async function walk(
    as: MarfaClient,
    item: string,
    sort: string,
    direction: "asc" | "desc",
    limit = 1000,
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await as.listRows(item, "lines", {
        sort,
        direction,
        limit,
        cursor,
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      seen.push(...res.data.data.map((r) => r.id));
      cursor = res.data.next_cursor ?? undefined;
    } while (cursor);
    return seen;
  }

  it("sorts a datetime column by its instant, whatever the offset", async () => {
    const { item } = await ordered(
      { at: { type: "datetime" }, seen: { type: "datetime" } },
      "at",
    );
    const times = [
      "2026-01-01T10:00:00+05:00",
      "2026-01-01T06:00:00Z",
      "2026-01-01",
      "2026-01-01T01:00:00.500-03:00",
      "2025-12-31T23:30+00:00",
    ];
    const ids = await write(
      item,
      times.map(
        (at) => ({ op: "put", values: { at, seen: at } }) as RowOperation,
      ),
    );
    const [plus5, utc, date, minus3, before] = ids;
    const instants = [before, date, minus3, plus5, utc];
    for (const sort of ["values.at", "values.seen"]) {
      expect(await walk(client, item, sort, "asc", 2)).toEqual(instants);
      expect(await walk(client, item, sort, "desc", 2)).toEqual(
        [...instants].reverse(),
      );
    }
  });

  async function walkDefault(
    item: string,
    direction: "asc" | "desc" | undefined,
    limit: number,
    table = "lines",
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await client.listRows(item, table, {
        direction,
        limit,
        cursor,
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      seen.push(...res.data.data.map((r) => r.id));
      cursor = res.data.next_cursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 50);
    return seen;
  }

  it("reads a table's rows in its declared order when no sort is named", async () => {
    counter += 1;
    const type = `user.rows-default-${counter}-${ctx.runId}`;
    const made = await client.registerType({
      id: type,
      fields: { title: { type: "string" } },
      tables: {
        lines: {
          columns: { at: { type: "datetime" }, memo: { type: "string" } },
          order: "at",
        },
        plain: { columns: { at: { type: "datetime" } } },
      },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const created = await client.createItem({
      type,
      properties: { title: "Default" },
    } as never);
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const item = created.data.item.id;
    trackItem(ctx, item);
    const times = [
      "2026-01-01T10:00:00+05:00",
      "2026-01-01T06:00:00Z",
      "2026-01-01",
      "2026-01-01T01:00:00.500-03:00",
      "2025-12-31T23:30+00:00",
    ];
    const operations = times.map(
      (at) => ({ op: "put", values: { at } }) as RowOperation,
    );
    const ids: string[] = [];
    for (const table of ["lines", "plain"]) {
      const res = await client.writeRows(item, table, { operations });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      ids.push(...res.data.results.map((r) => r.id));
    }
    const [plus5, utc, date, minus3, before] = ids.slice(0, 5);
    const byInstant = [before, date, minus3, plus5, utc];
    expect(await walkDefault(item, undefined, 1000)).toEqual(byInstant);
    expect(await walkDefault(item, "asc", 1000)).toEqual(byInstant);
    const byId = [...ids.slice(0, 5)].sort();
    expect(
      byId,
      "the instants must differ from the id order for this test to tell them apart",
    ).not.toEqual(byInstant);
    expect(
      await walkDefault(item, undefined, 1000, "plain"),
      "a table that names no order reads by id",
    ).toEqual([...ids.slice(5)].sort());
  });

  it("reads a declared order descending, rows without a value last and ties by id", async () => {
    const { item } = await ordered(
      { rank: { type: "number" }, label: { type: "string" } },
      "rank",
    );
    const plan: (number | null)[] = [2, null, 1, 2, 3, null, 2, 1.5];
    const ids = await write(
      item,
      plan.map(
        (rank) =>
          ({
            op: "put",
            values: rank === null ? { label: "none" } : { rank },
          }) as RowOperation,
      ),
    );
    const rows = plan.map((rank, n) => ({ id: ids[n]!, rank }));
    const byId = (a: { id: string }, b: { id: string }) =>
      a.id < b.id ? -1 : 1;
    const valued = rows.filter((r) => r.rank !== null);
    const empty = rows.filter((r) => r.rank === null).sort(byId);
    const sorted = (sign: 1 | -1) => [
      ...[...valued]
        .sort((a, b) =>
          a.rank === b.rank ? byId(a, b) : (a.rank! - b.rank!) * sign,
        )
        .map((r) => r.id),
      ...empty.map((r) => r.id),
    ];
    expect(await walkDefault(item, undefined, 1000)).toEqual(sorted(1));
    expect(await walkDefault(item, "desc", 1000)).toEqual(sorted(-1));
  });

  it("continues a declared order across pages by its cursor, skipping none and repeating none", async () => {
    const { item } = await ordered(
      { rank: { type: "integer" }, label: { type: "string" } },
      "rank",
    );
    const plan: (number | null)[] = [3, 1, null, 2, 2, 3, null, 1, 2, 4];
    await write(
      item,
      plan.map(
        (rank) =>
          ({
            op: "put",
            values: rank === null ? { label: "none" } : { rank },
          }) as RowOperation,
      ),
    );
    for (const direction of ["asc", "desc"] as const) {
      const whole = await walkDefault(item, direction, 1000);
      expect(whole).toHaveLength(plan.length);
      const listed = await client.listRows(item, "lines", {
        direction,
        limit: 1000,
      });
      expect(
        listed.data.data.map((r) => r.values.rank ?? null),
        direction,
      ).toEqual(
        direction === "asc"
          ? [1, 1, 2, 2, 2, 3, 3, 4, null, null]
          : [4, 3, 3, 2, 2, 2, 1, 1, null, null],
      );
      for (const limit of [1, 3, 4]) {
        expect(
          await walkDefault(item, direction, limit),
          `${direction}, ${limit} to a page`,
        ).toEqual(whole);
      }
      const first = await client.listRows(item, "lines", {
        direction,
        limit: 4,
      });
      const second = await client.listRows(item, "lines", {
        direction,
        limit: 4,
        cursor: first.data.next_cursor!,
      });
      const third = await client.listRows(item, "lines", {
        direction,
        limit: 4,
        cursor: second.data.next_cursor!,
      });
      expect(
        [first, second, third].map((page) => page.data.data.length),
        `${direction} in three pages`,
      ).toEqual([4, 4, 2]);
      expect(third.data.next_cursor).toBeNull();
    }
  });

  it("answers a sort that is named, whatever the table's order", async () => {
    const { item } = await ordered(
      { rank: { type: "integer" }, label: { type: "string" } },
      "rank",
    );
    const ids = await write(
      item,
      [3, 1, 2].map(
        (rank) =>
          ({
            op: "put",
            values: { rank, label: `l${4 - rank}` },
          }) as RowOperation,
      ),
    );
    const named = async (sort: string, cursor?: string) =>
      client.listRows(item, "lines", { sort, limit: 100, cursor });
    expect((await named("id")).data.data.map((r) => r.id)).toEqual(
      [...ids].sort(),
    );
    expect((await named("values.label")).data.data.map((r) => r.id)).toEqual([
      ids[0],
      ids[2],
      ids[1],
    ]);
    const byDefault = await client.listRows(item, "lines", { limit: 1 });
    expect(byDefault.data.data.map((r) => r.id)).toEqual([ids[1]]);
    const crossed = await named("id", byDefault.data.next_cursor!);
    expect(crossed.status).toBe(400);
    expect(crossed.error?.error.code).toBe("validation_error");
  });

  it("refuses a cursor of a default listing once the table's order has changed", async () => {
    const columns = { rank: { type: "integer" }, other: { type: "integer" } };
    const { type, item } = await ordered(columns, "rank");
    await write(
      item,
      [1, 2, 3].map(
        (n) =>
          ({ op: "put", values: { rank: n, other: 4 - n } }) as RowOperation,
      ),
    );
    const first = await client.listRows(item, "lines", { limit: 1 });
    expect(first.data.next_cursor).not.toBeNull();
    const changed = await client.replaceType(type, {
      id: type,
      fields: { title: { type: "string" } },
      tables: { lines: { columns, order: "other" } },
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    const stale = await client.listRows(item, "lines", {
      limit: 1,
      cursor: first.data.next_cursor!,
    });
    expect(stale.status).toBe(400);
    expect(stale.error?.error.code).toBe("validation_error");
    expect(stale.error?.error.details).toMatchObject({ field: "cursor" });
    const fresh = await client.listRows(item, "lines", { limit: 1 });
    expect(fresh.status, JSON.stringify(fresh.error)).toBe(200);
    expect(fresh.data.data[0]?.values.other).toBe(1);
  });

  it("sorts a value a forced change left of another type as no value", async () => {
    const columns = {
      kept: { type: "number" },
      loose: { type: "number" },
      label: { type: "string" },
    };
    const { type, item, table } = await ordered(columns, "kept");
    const numbered = await write(
      item,
      [3, 1, 2].map(
        (n) =>
          ({
            op: "put",
            values: { kept: n, loose: n, label: `n${n}` },
          }) as RowOperation,
      ),
    );
    const changed = {
      ...table,
      columns: {
        ...columns,
        kept: { type: "string" },
        loose: { type: "string" },
      },
    };
    const forced = await client.replaceType(
      type,
      {
        id: type,
        fields: { title: { type: "string" } },
        tables: { lines: changed },
      },
      true,
    );
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    const texts = await write(item, [
      { op: "put", values: { kept: "b", loose: "b" } },
      { op: "put", values: { kept: "a", loose: "a" } },
    ]);
    const expected = [texts[1], texts[0], ...[...numbered].sort()];
    expect(await walk(client, item, "values.kept", "asc", 2)).toEqual(expected);
    expect(await walk(client, item, "values.loose", "asc", 2)).toEqual(
      expected,
    );
    expect(await walk(client, item, "values.kept", "desc", 2)).toEqual([
      texts[0],
      texts[1],
      ...[...numbered].sort(),
    ]);
  });

  it("sorts an item id a forced change left in the order column as no value", async () => {
    counter += 1;
    const pointed = `user.rows-order-pointed-${counter}-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: pointed,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const target = await client.createItem({
      type: pointed,
      properties: { title: "Pointed at" },
    } as never);
    expect(target.status, JSON.stringify(target.error)).toBe(201);
    trackItem(ctx, target.data.item.id);
    const columns = { name: { type: "string" }, about: { type: "item" } };
    const { type, item, table } = await ordered(columns, "name");
    const pointing = await write(item, [
      { op: "put", values: { name: "m", about: target.data.item.id } },
    ]);
    const forced = await client.replaceType(
      type,
      {
        id: type,
        fields: { title: { type: "string" } },
        tables: {
          lines: {
            ...table,
            columns: { ...columns, about: { type: "string" } },
            order: "about",
          },
        },
      },
      true,
    );
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    const plain = await write(item, [
      { op: "put", values: { name: "z", about: "zzzzzzzz" } },
      { op: "put", values: { name: "a", about: "00000000" } },
    ]);
    counter += 1;
    const key = await client.createKey({
      label: `rows-order-${counter}`,
      source: `${ctx.source}-order-${counter}`,
      type_permissions: { [type]: "read" },
    });
    expect(key.ok, JSON.stringify(key.error)).toBe(true);
    trackKey(ctx, key.data.id);
    const reader = new MarfaClient({ baseUrl: apiUrl, apiKey: key.data.key });
    for (const as of [client, reader]) {
      expect(await walk(as, item, "values.about", "asc", 1)).toEqual([
        plain[1],
        plain[0],
        pointing[0],
      ]);
      expect(await walk(as, item, "values.about", "desc", 1)).toEqual([
        plain[0],
        plain[1],
        pointing[0],
      ]);
    }
    const shown = (await client.getRow(item, "lines", pointing[0]!)).data;
    expect(shown.values.about).toBe(target.data.item.id);
  });

  it("sorts by a new order at once, while table-row-cleanup rewrites the kept order of a large table", async () => {
    const columns = { rank: { type: "integer" }, label: { type: "string" } };
    const { type, item, table } = await ordered(columns, "rank");
    const count = 1_500;
    const label = (n: number) =>
      `l${String((n * 7_919) % count).padStart(5, "0")}`;
    const ids: string[] = [];
    for (let start = 0; start < count; start += 750) {
      ids.push(
        ...(await write(
          item,
          Array.from(
            { length: 750 },
            (_, n) =>
              ({
                op: "put",
                values: { rank: start + n, label: label(start + n) },
              }) as RowOperation,
          ),
        )),
      );
    }
    const byRank = [...ids];
    expect(await walk(client, item, "values.rank", "asc")).toEqual(byRank);

    const changedAt = new Date().toISOString();
    const moved = await client.replaceType(type, {
      id: type,
      fields: { title: { type: "string" } },
      tables: { lines: { ...table, order: "label" } },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    const added = await write(item, [
      { op: "put", values: { rank: -1, label: "l00000a" } },
      { op: "patch", id: ids[0]!, values: { label: "l99999" } },
    ]);
    const labels = new Map(ids.map((id, n) => [id, label(n)]));
    labels.set(ids[0]!, "l99999");
    labels.set(added[0]!, "l00000a");
    const byLabel = [...labels.keys()].sort((a, b) =>
      labels.get(a)! < labels.get(b)! ? -1 : 1,
    );
    const ranks = new Map(ids.map((id, n) => [id, n]));
    ranks.set(added[0]!, -1);
    const byRankNow = [...ranks.keys()].sort(
      (a, b) => ranks.get(a)! - ranks.get(b)!,
    );
    const sorted = async () => {
      expect(await walk(client, item, "values.label", "asc")).toEqual(byLabel);
      expect(await walk(client, item, "values.label", "desc")).toEqual(
        [...byLabel].reverse(),
      );
      expect(await walk(client, item, "values.rank", "asc")).toEqual(byRankNow);
    };
    await sorted();

    // The change brings the job forward, so the scheduler may run it before this fixture asks.
    const management = getManagementClient();
    const deadline = Date.now() + 60_000;
    let asked = false;
    for (;;) {
      const job = (await management.listHousekeeping()).data.data.find(
        (row) => row.name === "table-row-cleanup",
      );
      if (
        job?.last_started_at &&
        job.last_started_at > changedAt &&
        job.last_finished_at &&
        job.last_finished_at >= job.last_started_at &&
        !job.running_since
      ) {
        expect(job.last_outcome).toBe("ok");
        break;
      }
      if (!asked && !job?.running_since) {
        asked = (await management.runHousekeeping("table-row-cleanup")).ok;
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(Date.now()).toBeLessThan(deadline);
    }
    await sorted();
  });

  it("refuses a cursor answered before the sorted column changed type", async () => {
    const columns = { at: { type: "string" }, other: { type: "string" } };
    const { type, item, table } = await ordered(columns, "at");
    await write(
      item,
      [1, 2, 3, 4, 5].map(
        (n) =>
          ({
            op: "put",
            values: { at: `2026-01-0${n}`, other: `2026-01-0${n}` },
          }) as RowOperation,
      ),
    );
    const cursors = new Map<string, string>();
    for (const sort of ["values.at", "values.other"]) {
      const first = await client.listRows(item, "lines", { sort, limit: 2 });
      expect(first.data.next_cursor).toEqual(expect.any(String));
      cursors.set(sort, first.data.next_cursor!);
    }
    const forced = await client.replaceType(
      type,
      {
        id: type,
        fields: { title: { type: "string" } },
        tables: {
          lines: {
            ...table,
            columns: {
              at: { type: "datetime" },
              other: { type: "datetime" },
            },
          },
        },
      },
      true,
    );
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    for (const [sort, cursor] of cursors) {
      const res = await client.listRows(item, "lines", {
        sort,
        limit: 2,
        cursor,
      });
      expect(res.status, sort).toBe(400);
      expect(res.error?.error.code).toBe("validation_error");
      expect(res.error?.error.details).toMatchObject({ field: "cursor" });
      expect(await walk(client, item, sort, "asc", 2)).toHaveLength(5);
    }
  });

  it("rewrites the kept order of many small tables mostly in table-row-cleanup, sorting every page right meanwhile", async () => {
    const columns = { rank: { type: "integer" }, label: { type: "string" } };
    const { type, item: first, table } = await ordered(columns, "rank");
    const items = [first];
    for (let n = 1; n < 50; n++) {
      const made = await client.createItem({
        type,
        properties: { title: `Ordered ${n}` },
      } as never);
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      trackItem(ctx, made.data.item.id);
      items.push(made.data.item.id);
    }
    const rows = 30;
    const label = (n: number) => `l${String((n * 7) % rows).padStart(3, "0")}`;
    const held: string[][] = [];
    for (const item of items) {
      held.push(
        await write(
          item,
          Array.from(
            { length: rows },
            (_, n) =>
              ({
                op: "put",
                values: { rank: n, label: label(n) },
              }) as RowOperation,
          ),
        ),
      );
    }
    const byLabel = (ids: string[]) =>
      [...ids].sort((a, b) =>
        label(ids.indexOf(a)) < label(ids.indexOf(b)) ? -1 : 1,
      );
    const sorted = async () => {
      for (const [at, item] of items.entries()) {
        expect(await walk(client, item, "values.label", "asc", 7)).toEqual(
          byLabel(held[at]!),
        );
        expect(await walk(client, item, "values.rank", "asc", 7)).toEqual(
          held[at],
        );
      }
    };

    const changedAt = new Date().toISOString();
    const moved = await client.replaceType(type, {
      id: type,
      fields: { title: { type: "string" } },
      tables: { lines: { ...table, order: "label" } },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    await sorted();

    const management = getManagementClient();
    const deadline = Date.now() + 60_000;
    const runs = new Map<string, number>();
    let asked = false;
    for (;;) {
      const job = (await management.listHousekeeping()).data.data.find(
        (row) => row.name === "table-row-cleanup",
      );
      if (job?.last_started_at && job.last_started_at > changedAt) {
        runs.set(
          job.last_started_at,
          (job.last_result as { reordered: number }).reordered,
        );
      }
      if (
        job?.last_started_at &&
        job.last_started_at > changedAt &&
        job.last_finished_at &&
        job.last_finished_at >= job.last_started_at &&
        !job.running_since
      ) {
        expect(job.last_outcome).toBe("ok");
        break;
      }
      if (!asked && !job?.running_since) {
        asked = (await management.runHousekeeping("table-row-cleanup")).ok;
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(Date.now()).toBeLessThan(deadline);
    }
    // The type write rewrites at most one page of rows itself and leaves the rest to the job.
    const left = [...runs.values()].reduce((sum, n) => sum + n, 0);
    expect(left).toBeGreaterThanOrEqual(items.length * rows - 1_000);
    await sorted();
  });
});
