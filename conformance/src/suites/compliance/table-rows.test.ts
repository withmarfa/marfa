import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  ApiResponse,
  RowOperation,
  TestContext,
} from "../../client/types.js";
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
    "table-rows",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let counter = 0;
function typeId(label: string): string {
  counter += 1;
  return `user.rows-${label}-${counter}-${ctx.runId}`;
}

const rowId = (): string => uuidv7();

async function ledgerType(
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = typeId("ledger");
  const made = await client.registerType({
    id,
    fields: { title: { type: "string" } },
    tables: {
      lines: {
        columns: {
          amount: { type: "number", required: true, adds_up: "sum" },
          memo: { type: "string", maxLength: 20 },
          kind: { type: "enum", enum_values: ["food", "travel"] },
          on: { type: "date" },
          ...extra,
        },
      },
    },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return id;
}

async function itemOf(type: string, as: MarfaClient = client): Promise<string> {
  const made = await as.createItem({
    type,
    properties: { title: "Ledger" },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

function refusedAt(res: ApiResponse<unknown>): {
  code?: string;
  operation?: number;
  paths: string[];
} {
  const details = res.error?.error.details as
    { operation?: number; errors?: { path: string }[] } | undefined;
  return {
    code: res.error?.error.code,
    operation: details?.operation,
    paths: (details?.errors ?? []).map((e) => e.path),
  };
}

async function rowsOf(item: string, table = "lines") {
  const listed = await client.listRows(item, table, { limit: 1000 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data;
}

describe("writing rows", () => {
  it("creates, replaces, patches and deletes rows in one batch, answering each in order", async () => {
    const item = await itemOf(await ledgerType());
    const kept = rowId();
    const gone = rowId();
    const first = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", values: { amount: 1 } },
        { op: "put", id: kept, values: { amount: 2, memo: "two" } },
        { op: "put", id: gone, values: { amount: 3 } },
      ],
    });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.data.results.map((r) => r.outcome)).toEqual([
      "created",
      "created",
      "created",
    ]);
    expect(first.data.results[0]?.id).toMatch(UUID);
    expect(first.data.results[1]?.id).toBe(kept);

    const second = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id: kept, values: { amount: 20 } },
        { op: "patch", id: first.data.results[0]!.id, values: { memo: "one" } },
        { op: "delete", id: gone },
      ],
    });
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/items/{id}/tables/{table}/rows",
      200,
      second.data,
    );
    expect(second.data.results).toEqual([
      { id: kept, outcome: "replaced" },
      { id: first.data.results[0]!.id, outcome: "patched" },
      { id: gone, outcome: "deleted" },
    ]);

    const rows = await rowsOf(item);
    expect(rows.map((r) => r.id).sort()).toEqual(
      [first.data.results[0]!.id, kept].sort(),
    );
    expect(rows.find((r) => r.id === kept)?.values).toEqual({ amount: 20 });
    expect(rows.find((r) => r.id !== kept)?.values).toEqual({
      amount: 1,
      memo: "one",
    });
  });

  it("keeps the id a client sends for a new row", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    const res = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 5 } }],
    });
    expect(res.data.results).toEqual([{ id, outcome: "created" }]);
    expect((await client.getRow(item, "lines", id)).data.values).toEqual({
      amount: 5,
    });
  });

  it("takes a put sent twice as one row, the second unchanged", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    const batch = {
      operations: [
        { op: "put", id, values: { amount: 7, memo: "same" } },
      ] as RowOperation[],
    };
    const first = await client.writeRows(item, "lines", batch);
    expect(first.data.results[0]?.outcome).toBe("created");
    expect(first.data.batch).toMatch(UUID);
    const before = (await client.getRow(item, "lines", id)).data;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await client.writeRows(item, "lines", batch);
    expect(again.status).toBe(200);
    expect(again.data.results).toEqual([{ id, outcome: "unchanged" }]);
    expect(again.data.batch).toBeNull();
    expect(await rowsOf(item)).toEqual([before]);
  });

  it("holds a column a put sends as null as one it leaves out", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    const first = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 7, memo: null } }],
    });
    expect(first.data.results).toEqual([{ id, outcome: "created" }]);
    expect((await client.getRow(item, "lines", id)).data.values).toEqual({
      amount: 7,
    });
    const again = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 7, kind: null } }],
    });
    expect(again.data.results).toEqual([{ id, outcome: "unchanged" }]);
  });

  it("patches only the columns it names", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id, values: { amount: 1, memo: "a", kind: "food" } },
      ],
    });
    const patched = await client.writeRows(item, "lines", {
      operations: [{ op: "patch", id, values: { memo: "b", kind: null } }],
    });
    expect(patched.data.results).toEqual([{ id, outcome: "patched" }]);
    expect((await client.getRow(item, "lines", id)).data.values).toEqual({
      amount: 1,
      memo: "b",
    });
  });

  it("leaves a row a patch would not change as it is, answering unchanged", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 1, memo: "a" } }],
    });
    const before = (await client.getRow(item, "lines", id)).data;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const same = await client.writeRows(item, "lines", {
      operations: [{ op: "patch", id, values: { memo: "a", kind: null } }],
    });
    expect(same.status, JSON.stringify(same.error)).toBe(200);
    expect(same.data.results).toEqual([{ id, outcome: "unchanged" }]);
    expect(same.data.batch).toBeNull();
    expect((await client.getRow(item, "lines", id)).data).toEqual(before);
  });

  it("refuses a patch of a row the table does not hold, and writes nothing of its batch", async () => {
    const item = await itemOf(await ledgerType());
    const res = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", values: { amount: 1 } },
        { op: "patch", id: rowId(), values: { amount: 2 } },
      ],
    });
    expect(res.status).toBe(404);
    expect(refusedAt(res)).toMatchObject({
      code: "row_not_found",
      operation: 1,
    });
    expect(await rowsOf(item)).toEqual([]);
  });

  it("acknowledges a delete of a row the table does not hold", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    const res = await client.writeRows(item, "lines", {
      operations: [{ op: "delete", id }],
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.results).toEqual([{ id, outcome: "absent" }]);
    expect(res.data.batch).toBeNull();
  });

  it("applies operations on one row in the order they are sent", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    const res = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id, values: { amount: 1 } },
        { op: "patch", id, values: { memo: "later" } },
        { op: "delete", id },
        { op: "put", id, values: { amount: 9 } },
      ],
    });
    expect(res.data.results.map((r) => r.outcome)).toEqual([
      "created",
      "patched",
      "deleted",
      "created",
    ]);
    expect((await client.getRow(item, "lines", id)).data.values).toEqual({
      amount: 9,
    });
  });

  it("writes nothing of a batch with one bad operation among many", async () => {
    const item = await itemOf(await ledgerType());
    const operations: RowOperation[] = Array.from({ length: 500 }, (_, n) => ({
      op: "put",
      values: { amount: n },
    }));
    operations[317] = { op: "put", values: { amount: "many" } };
    const res = await client.writeRows(item, "lines", { operations });
    expect(res.status).toBe(400);
    expect(refusedAt(res)).toEqual({
      code: "validation_error",
      operation: 317,
      paths: ["operations.317.values.amount"],
    });
    expect(await rowsOf(item)).toEqual([]);
    const tables = await client.listTables(item);
    expect(tables.data.data[0]).toMatchObject({ name: "lines", row_count: 0 });
  });

  it("refuses a batch with no operations", async () => {
    const item = await itemOf(await ledgerType());
    for (const body of [
      {},
      { operations: [] },
      { operations: "put" },
      { operations: [1] },
    ]) {
      const res = await client.writeRows(item, "lines", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.error?.error.code).toBe("validation_error");
      expect(JSON.stringify(res.error?.error.details)).toContain("operations");
    }
  });

  it("refuses a row id that is not a UUID and an operation it does not know", async () => {
    const item = await itemOf(await ledgerType());
    const notUuid = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id: "row-1", values: { amount: 1 } }],
    });
    expect(notUuid.status).toBe(400);
    expect(refusedAt(notUuid)).toMatchObject({
      code: "validation_error",
      operation: 0,
      paths: ["operations.0.id"],
    });
    const unknownOp = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", values: { amount: 1 } },
        { op: "upsert", values: { amount: 1 } },
      ],
    } as never);
    expect(refusedAt(unknownOp)).toMatchObject({
      code: "validation_error",
      operation: 1,
      paths: ["operations.1.op"],
    });
    const noId = await client.writeRows(item, "lines", {
      operations: [{ op: "delete" }],
    } as never);
    expect(refusedAt(noId)).toMatchObject({
      code: "validation_error",
      operation: 0,
      paths: ["operations.0.id"],
    });
    expect(await rowsOf(item)).toEqual([]);
  });

  it("refuses an operation with a member it does not take, or a delete that sends values", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    const stray = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id, values: { amount: 1 } },
        { op: "put", values: { amount: 2 }, version: 3 },
      ],
    } as never);
    expect(stray.status).toBe(400);
    expect(refusedAt(stray)).toMatchObject({
      code: "validation_error",
      operation: 1,
      paths: ["operations.1.version"],
    });
    const deleteValues = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id, values: { amount: 1 } },
        { op: "delete", id, values: { amount: 1 } },
      ],
    } as never);
    expect(deleteValues.status).toBe(400);
    expect(refusedAt(deleteValues)).toMatchObject({
      code: "validation_error",
      operation: 1,
      paths: ["operations.1.values"],
    });
    expect(await rowsOf(item)).toEqual([]);

    const plain = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id, values: { amount: 1 } },
        { op: "delete", id },
      ],
    });
    expect(plain.status, JSON.stringify(plain.error)).toBe(200);
  });

  it("refuses a put or patch whose values is missing or not an object", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 1 } }],
    });
    for (const sent of [
      { op: "put" },
      { op: "put", values: [1] },
      { op: "put", values: "amount" },
      { op: "patch", id },
      { op: "patch", id, values: null },
      { op: "patch", id, values: [{ amount: 2 }] },
    ]) {
      const res = await client.writeRows(item, "lines", {
        operations: [{ op: "patch", id, values: { amount: 9 } }, sent],
      } as never);
      expect(res.status, JSON.stringify(sent)).toBe(400);
      expect(refusedAt(res), JSON.stringify(sent)).toMatchObject({
        code: "validation_error",
        operation: 1,
        paths: ["operations.1.values"],
      });
    }
    expect((await client.getRow(item, "lines", id)).data.values).toEqual({
      amount: 1,
    });
  });

  it("refuses a value of the wrong kind, a missing required column and an unknown column, naming each", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 1 } }],
    });
    const cases: [RowOperation, string][] = [
      [{ op: "put", values: { amount: "1" } }, "operations.0.values.amount"],
      [{ op: "put", values: { memo: "x" } }, "operations.0.values.amount"],
      [
        { op: "patch", id, values: { amount: null } },
        "operations.0.values.amount",
      ],
      [
        { op: "put", values: { amount: 1, colour: "red" } },
        "operations.0.values.colour",
      ],
      [
        { op: "put", values: { amount: 1, kind: "rent" } },
        "operations.0.values.kind",
      ],
      [
        { op: "put", values: { amount: 1, memo: "x".repeat(21) } },
        "operations.0.values.memo",
      ],
      [
        { op: "put", values: { amount: 1, on: "tomorrow" } },
        "operations.0.values.on",
      ],
    ];
    for (const [operation, path] of cases) {
      const res = await client.writeRows(item, "lines", {
        operations: [operation],
      });
      expect(res.status, JSON.stringify(operation)).toBe(400);
      expect(refusedAt(res), JSON.stringify(operation)).toEqual({
        code: "validation_error",
        operation: 0,
        paths: [path],
      });
    }
    expect((await client.getRow(item, "lines", id)).data.values).toEqual({
      amount: 1,
    });
  });

  it("refuses an item column naming an item that does not exist or that the key may not read", async () => {
    const hiddenType = typeId("hidden");
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const hidden = await itemOf(hiddenType);
    const type = await ledgerType({ about: { type: "item" } });
    const narrow = await narrowClient({ [type]: "write" });
    const item = await itemOf(type);

    const missing = await narrow.writeRows(item, "lines", {
      operations: [{ op: "put", values: { amount: 1, about: rowId() } }],
    });
    expect(refusedAt(missing)).toEqual({
      code: "validation_error",
      operation: 0,
      paths: ["operations.0.values.about"],
    });
    const unreadable = await narrow.writeRows(item, "lines", {
      operations: [{ op: "put", values: { amount: 1, about: hidden } }],
    });
    expect(refusedAt(unreadable)).toEqual({
      code: "validation_error",
      operation: 0,
      paths: ["operations.0.values.about"],
    });
    const readable = await client.writeRows(item, "lines", {
      operations: [{ op: "put", values: { amount: 1, about: hidden } }],
    });
    expect(readable.status, JSON.stringify(readable.error)).toBe(200);
  });

  it("refuses an item column naming an item of a type its constraints do not admit", async () => {
    const fileType = typeId("receipt");
    expect(
      (
        await client.registerType({
          id: fileType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const type = await ledgerType({
      receipt: { type: "item", type_constraints: [fileType] },
    });
    const item = await itemOf(type);
    const receipt = await itemOf(fileType);
    const other = await client.createItem({
      type: "core.note",
      properties: { title: "Not a receipt" },
    } as never);
    trackItem(ctx, other.data.item.id);
    const refused = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", values: { amount: 1, receipt: other.data.item.id } },
      ],
    });
    expect(refusedAt(refused)).toEqual({
      code: "validation_error",
      operation: 0,
      paths: ["operations.0.values.receipt"],
    });
    const taken = await client.writeRows(item, "lines", {
      operations: [{ op: "put", values: { amount: 1, receipt } }],
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("refuses a row over 64 KiB and a batch over 1000 operations", async () => {
    const type = typeId("wide");
    expect(
      (
        await client.registerType({
          id: type,
          fields: { title: { type: "string" } },
          tables: { notes: { columns: { text: { type: "string" } } } },
        } as never)
      ).status,
    ).toBe(201);
    const item = await itemOf(type);
    const fits = "x".repeat(65_536 - '{"text":""}'.length);
    const atLimit = await client.writeRows(item, "notes", {
      operations: [{ op: "put", values: { text: fits } }],
    });
    expect(atLimit.status, JSON.stringify(atLimit.error)).toBe(200);
    const over = await client.writeRows(item, "notes", {
      operations: [
        { op: "put", values: { text: "small" } },
        { op: "put", values: { text: `${fits}x` } },
      ],
    });
    expect(refusedAt(over)).toEqual({
      code: "validation_error",
      operation: 1,
      paths: ["operations.1.values"],
    });

    const many = (count: number): RowOperation[] =>
      Array.from({ length: count }, (_, n) => ({
        op: "put",
        values: { text: String(n) },
      }));
    const thousand = await client.writeRows(item, "notes", {
      operations: many(1000),
    });
    expect(thousand.status, JSON.stringify(thousand.error)).toBe(200);
    const tooMany = await client.writeRows(item, "notes", {
      operations: many(1001),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.error?.error.code).toBe("validation_error");
    expect(JSON.stringify(tooMany.error?.error.details)).toContain(
      "operations",
    );
    const tables = await client.listTables(item);
    expect(tables.data.data[0]?.row_count).toBe(1001);
  });

  it("refuses a patch that would leave a row over 64 KiB", async () => {
    const type = typeId("patched-wide");
    expect(
      (
        await client.registerType({
          id: type,
          fields: { title: { type: "string" } },
          tables: {
            notes: {
              columns: { one: { type: "string" }, two: { type: "string" } },
            },
          },
        } as never)
      ).status,
    ).toBe(201);
    const item = await itemOf(type);
    const id = rowId();
    const half = "x".repeat(40_000);
    const first = await client.writeRows(item, "notes", {
      operations: [{ op: "put", id, values: { one: half } }],
    });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const fits = "y".repeat(
      65_536 - JSON.stringify({ one: half, two: "" }).length,
    );
    const atLimit = await client.writeRows(item, "notes", {
      operations: [{ op: "patch", id, values: { two: fits } }],
    });
    expect(atLimit.status, JSON.stringify(atLimit.error)).toBe(200);
    const over = await client.writeRows(item, "notes", {
      operations: [
        { op: "put", values: { one: "small" } },
        { op: "patch", id, values: { two: half } },
      ],
    });
    expect(over.status).toBe(400);
    expect(refusedAt(over)).toEqual({
      code: "validation_error",
      operation: 1,
      paths: ["operations.1.values"],
    });
    expect((await client.getRow(item, "notes", id)).data.values).toEqual({
      one: half,
      two: fits,
    });
    expect(await rowsOf(item, "notes")).toHaveLength(1);
  });

  it("answers table_not_found for a table the type does not declare", async () => {
    const item = await itemOf(await ledgerType());
    const write = await client.writeRows(item, "other", {
      operations: [{ op: "put", values: { amount: 1 } }],
    });
    expect(write.status).toBe(404);
    expect(write.error?.error.code).toBe("table_not_found");
    for (const res of [
      await client.listRows(item, "other"),
      await client.getRow(item, "other", rowId()),
      await client.rowTotals(item, "other"),
    ]) {
      expect(res.status).toBe(404);
      expect(res.error?.error.code).toBe("table_not_found");
    }
  });
});

async function narrowClient(
  types: Record<string, string>,
): Promise<MarfaClient> {
  counter += 1;
  const made = await client.createKey({
    label: `table-rows-narrow-${counter}`,
    source: `${ctx.source}-narrow-${counter}`,
    type_permissions: types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
}

describe("who may read and write rows", () => {
  it("reads rows as the item is read, and refuses a key with read but not write", async () => {
    const type = await ledgerType();
    const item = await itemOf(type);
    const id = rowId();
    await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 3 } }],
    });

    const reader = await narrowClient({ [type]: "read" });
    expect((await reader.getRow(item, "lines", id)).data.values).toEqual({
      amount: 3,
    });
    const refused = await reader.writeRows(item, "lines", {
      operations: [{ op: "delete", id }],
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    expect((await client.getRow(item, "lines", id)).status).toBe(200);

    const stranger = await narrowClient({ "core.note": "write" });
    for (const res of [
      await stranger.listTables(item),
      await stranger.listRows(item, "lines"),
      await stranger.getRow(item, "lines", id),
      await stranger.rowTotals(item, "lines"),
      await stranger.writeRows(item, "lines", {
        operations: [{ op: "delete", id }],
      }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.error?.error.code).toBe("item_not_found");
    }
    const nobody = await client.listRows(rowId(), "lines");
    expect(nobody.status).toBe(404);
    expect(nobody.error?.error.code).toBe("item_not_found");
  });

  it("refuses to read or write the rows of an item in the bin", async () => {
    const item = await itemOf(await ledgerType());
    const id = rowId();
    await client.writeRows(item, "lines", {
      operations: [{ op: "put", id, values: { amount: 3 } }],
    });
    expect((await client.deleteItem(item)).status).toBe(200);
    for (const res of [
      await client.listTables(item),
      await client.listRows(item, "lines"),
      await client.getRow(item, "lines", id),
      await client.rowTotals(item, "lines"),
    ]) {
      expect(res.status).toBe(404);
      expect(res.error?.error.code).toBe("item_not_found");
      expect(res.error?.error.details).toBeUndefined();
    }
    const write = await client.writeRows(item, "lines", {
      operations: [{ op: "delete", id }],
    });
    expect(write.status).toBe(404);
    expect(write.error?.error).toMatchObject({
      code: "item_not_found",
      details: { trashed: true },
    });
    expect((await client.restoreItem(item)).status).toBe(200);
    expect((await client.getRow(item, "lines", id)).data.values).toEqual({
      amount: 3,
    });
  });

  it("withholds an item column's id from a key that may not read the item, and keeps the row", async () => {
    const hiddenType = typeId("private");
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const hidden = await itemOf(hiddenType);
    const shownNote = await client.createItem({
      type: "core.note",
      properties: { title: "Shown" },
    } as never);
    trackItem(ctx, shownNote.data.item.id);
    const type = await ledgerType({ about: { type: "item" } });
    const item = await itemOf(type);
    const secret = rowId();
    const plain = rowId();
    await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id: secret, values: { amount: 1, about: hidden } },
        {
          op: "put",
          id: plain,
          values: { amount: 2, about: shownNote.data.item.id },
        },
      ],
    });
    expect(
      (await client.getRow(item, "lines", secret)).data,
    ).not.toHaveProperty("withheld");

    const reader = await narrowClient({ [type]: "read", "core.note": "read" });
    const row = (await reader.getRow(item, "lines", secret)).data;
    expect(row.values).toEqual({ amount: 1 });
    expect(row.withheld).toEqual(["about"]);
    const listed = (await reader.listRows(item, "lines")).data.data;
    expect(listed.find((r) => r.id === secret)?.withheld).toEqual(["about"]);
    expect(listed.find((r) => r.id === plain)?.values).toEqual({
      amount: 2,
      about: shownNote.data.item.id,
    });
  });

  async function withheldRow(about: Record<string, unknown> = {}) {
    const hiddenType = typeId("private");
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const hidden = await itemOf(hiddenType);
    const shown = await client.createItem({
      type: "core.note",
      properties: { title: "Shown" },
    } as never);
    trackItem(ctx, shown.data.item.id);
    const type = await ledgerType({ about: { type: "item", ...about } });
    const item = await itemOf(type);
    const row = rowId();
    const written = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id: row, values: { amount: 1, about: hidden } },
      ],
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    const writer = await narrowClient({ [type]: "write", "core.note": "read" });
    const seen = await writer.getRow(item, "lines", row);
    expect(seen.data.withheld).toEqual(["about"]);
    return { item, row, hidden, note: shown.data.item.id, writer };
  }

  it("refuses a put or patch naming a column whose value the key may not read, and writes nothing of its batch", async () => {
    const { item, row, hidden, note, writer } = await withheldRow();
    const fresh = rowId();
    const naming: RowOperation[] = [
      { op: "patch", id: row, values: { about: note } },
      { op: "patch", id: row, values: { about: null } },
      { op: "patch", id: row, values: { about: hidden } },
      { op: "put", id: row, values: { amount: 1, about: note } },
      { op: "put", id: row, values: { amount: 1, about: null } },
    ];
    for (const op of naming) {
      const res = await writer.writeRows(item, "lines", {
        operations: [{ op: "put", id: fresh, values: { amount: 2 } }, op],
      });
      expect(res.status, JSON.stringify(op)).toBe(403);
      expect(res.error?.error).toMatchObject({
        code: "forbidden",
        details: { operation: 1, column: "about" },
      });
      expect(res.error?.error.details).not.toHaveProperty("grant");
      expect(JSON.stringify(res.error)).not.toContain(hidden);
    }
    expect((await client.getRow(item, "lines", row)).data.values).toEqual({
      amount: 1,
      about: hidden,
    });
    expect((await client.getRow(item, "lines", fresh)).status).toBe(404);

    const other = await writer.writeRows(item, "lines", {
      operations: [{ op: "patch", id: row, values: { amount: 4 } }],
    });
    expect(other.data.results[0]?.outcome).toBe("patched");
    const owner = await client.writeRows(item, "lines", {
      operations: [{ op: "patch", id: row, values: { about: note } }],
    });
    expect(owner.data.results[0]?.outcome).toBe("patched");
    const now = await writer.writeRows(item, "lines", {
      operations: [{ op: "patch", id: row, values: { about: null } }],
    });
    expect(now.data.results[0]?.outcome).toBe("patched");
  });

  it("keeps a value the key may not read in each column a put leaves out", async () => {
    const { item, row, hidden, writer } = await withheldRow({ required: true });
    const read = (await writer.getRow(item, "lines", row)).data;
    const same = await writer.writeRows(item, "lines", {
      operations: [{ op: "put", id: row, values: read.values }],
    });
    expect(same.status, JSON.stringify(same.error)).toBe(200);
    expect(same.data.results[0]?.outcome).toBe("unchanged");
    expect(same.data.batch).toBeNull();

    const edited = await writer.writeRows(item, "lines", {
      operations: [
        { op: "put", id: row, values: { amount: 7, memo: "kept" } },
      ],
    });
    expect(edited.status, JSON.stringify(edited.error)).toBe(200);
    expect(edited.data.results[0]?.outcome).toBe("replaced");
    expect((await client.getRow(item, "lines", row)).data.values).toEqual({
      amount: 7,
      memo: "kept",
      about: hidden,
    });
    const cleared = await writer.writeRows(item, "lines", {
      operations: [{ op: "put", id: row, values: { amount: 7 } }],
    });
    expect(cleared.data.results[0]?.outcome).toBe("replaced");
    expect((await client.getRow(item, "lines", row)).data.values).toEqual({
      amount: 7,
      about: hidden,
    });
    const after = (await writer.getRow(item, "lines", row)).data;
    expect(after.values).toEqual({ amount: 7 });
    expect(after.withheld).toEqual(["about"]);

    const owner = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id: row, values: { amount: 7 } }],
    });
    expect(owner.status).toBe(400);
    expect(refusedAt(owner).paths).toEqual(["operations.0.values.about"]);
  });

  it("deletes a row holding a value the key may not read", async () => {
    const { item, row, writer } = await withheldRow();
    const res = await writer.writeRows(item, "lines", {
      operations: [{ op: "delete", id: row }],
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.results[0]?.outcome).toBe("deleted");
    const gone = await client.getRow(item, "lines", row);
    expect(gone.status).toBe(404);
    expect(gone.error?.error.code).toBe("row_not_found");
  });
});
