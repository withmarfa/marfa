import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { RowOperation, TestContext } from "../../client/types.js";
import {
  createTestContext,
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
