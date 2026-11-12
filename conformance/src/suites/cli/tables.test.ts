import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { cleanup, trackItem, trackType } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * An agent with a key declares a type with a table, holds an item of it, and
 * writes, reads, filters, totals, deletes and undoes the item's rows, all
 * from the terminal.
 */

interface Row {
  id: string;
  values: Record<string, unknown>;
  updated_at: string;
}

interface Batch {
  batch: string | null;
  results: { id: string; outcome: string }[];
}

let c: CliContext;
let item: string;

beforeAll(async () => {
  c = await cliContext("tables");
  const type = `user.${unique("cli-ledger")}`;
  await c.cli.json([
    "types",
    "register",
    "--body",
    JSON.stringify({
      id: type,
      fields: { title: { type: "string" } },
      tables: {
        lines: {
          label: "Lines",
          columns: {
            amount: { type: "number", required: true, adds_up: "sum" },
            memo: { type: "string", max_length: 20 },
            kind: { type: "enum", enum_values: ["food", "travel"] },
          },
        },
      },
    }),
  ]);
  trackType(c.ctx, type);
  const made = await c.cli.json<ItemEnvelope>([
    "items",
    "create",
    "--type",
    type,
    "--prop",
    "title=Ledger",
  ]);
  item = made.item.id;
  trackItem(c.ctx, item);
});

afterAll(async () => {
  await cleanup(c.ctx);
});

describe("tables and rows from the terminal", () => {
  it("names the tables an item's type declares, each with how many rows the item holds", async () => {
    const tables = await c.cli.json<{
      data: { name: string; label: string; row_count: number }[];
      next_cursor: null;
    }>(["tables", "list", item]);
    expect(tables.data).toMatchObject([
      { name: "lines", label: "Lines", row_count: 0 },
    ]);
  });

  it("writes a batch from standard input, then one row at a time, reads them back and totals them", async () => {
    const first = uuidv7();
    const second = uuidv7();
    const batch = await c.cli.json<Batch>(
      ["rows", "write", item, "lines", "--file", "-"],
      {
        stdin: JSON.stringify({
          operations: [
            {
              op: "put",
              id: first,
              values: { amount: 12.5, memo: "Coffee", kind: "food" },
            },
            {
              op: "put",
              id: second,
              values: { amount: 8, memo: "Train", kind: "travel" },
            },
          ],
        }),
      },
    );
    expect(batch.batch).not.toBeNull();
    expect(batch.results).toEqual([
      { id: first, outcome: "created" },
      { id: second, outcome: "created" },
    ]);

    const put = await c.cli.json<Batch>([
      "rows",
      "put",
      item,
      "lines",
      "--values",
      JSON.stringify({ amount: 1, kind: "food" }),
    ]);
    expect(put.results).toHaveLength(1);
    expect(put.results[0]!.outcome).toBe("created");
    const third = put.results[0]!.id;

    const patch = await c.cli.json<Batch>([
      "rows",
      "patch",
      item,
      "lines",
      third,
      "--values",
      JSON.stringify({ memo: "Tea", kind: null }),
    ]);
    expect(patch.results).toEqual([{ id: third, outcome: "patched" }]);

    const row = await c.cli.json<Row>(["rows", "get", item, "lines", third]);
    expect(row.values).toEqual({ amount: 1, memo: "Tea" });

    const listed = await c.cli.json<{ data: Row[]; next_cursor: null }>([
      "rows",
      "list",
      item,
      "lines",
    ]);
    expect(listed.data.map((r) => r.id).sort()).toEqual(
      [first, second, third].sort(),
    );

    const foods = await c.cli.json<{ data: Row[] }>([
      "rows",
      "list",
      item,
      "lines",
      "--filter",
      'values.kind eq "food"',
    ]);
    expect(foods.data.map((r) => r.id)).toEqual([first]);

    const everything = await c.cli.json<{
      row_count: number;
      totals: Record<string, Record<string, number>>;
    }>(["rows", "totals", item, "lines"]);
    expect(everything.row_count).toBe(3);
    expect(everything.totals.amount).toEqual({ sum: 21.5 });
    const some = await c.cli.json<{
      row_count: number;
      totals: Record<string, Record<string, number>>;
    }>(["rows", "totals", item, "lines", "--filter", "values.amount gt 5"]);
    expect(some.row_count).toBe(2);
    expect(some.totals.amount).toEqual({ sum: 20.5 });

    const tables = await c.cli.json<{ data: { row_count: number }[] }>([
      "tables",
      "list",
      item,
    ]);
    expect(tables.data[0]!.row_count).toBe(3);
  });

  it("lists a page at a time in the order asked, and deletes rows, answering absent for one that is not there", async () => {
    const page = await c.cli.json<{ data: Row[]; next_cursor: string | null }>([
      "rows",
      "list",
      item,
      "lines",
      "--sort",
      "values.amount",
      "--direction",
      "desc",
      "--limit",
      "2",
    ]);
    expect(page.data.map((r) => r.values.amount)).toEqual([12.5, 8]);
    expect(page.next_cursor).not.toBeNull();
    const rest = await c.cli.json<{ data: Row[]; next_cursor: string | null }>([
      "rows",
      "list",
      item,
      "lines",
      "--sort",
      "values.amount",
      "--direction",
      "desc",
      "--limit",
      "2",
      "--cursor",
      page.next_cursor!,
    ]);
    expect(rest.data.map((r) => r.values.amount)).toEqual([1]);
    expect(rest.next_cursor).toBeNull();

    const gone = uuidv7();
    const removed = await c.cli.json<Batch>([
      "rows",
      "delete",
      item,
      "lines",
      page.data[0]!.id,
      gone,
    ]);
    expect(removed.results).toEqual([
      { id: page.data[0]!.id, outcome: "deleted" },
      { id: gone, outcome: "absent" },
    ]);
    const left = await c.cli.json<{ data: Row[] }>([
      "rows",
      "list",
      item,
      "lines",
    ]);
    expect(left.data).toHaveLength(2);
  });

  it("lists the table's batches newest first, undoes one and redoes it by undoing the undo", async () => {
    const row = uuidv7();
    const written = await c.cli.json<Batch>([
      "rows",
      "put",
      item,
      "lines",
      "--id",
      row,
      "--values",
      JSON.stringify({ amount: 3 }),
    ]);
    const listed = await c.cli.json<{
      data: { id: string; rows: number; undoes: string | null }[];
      next_cursor: string | null;
    }>(["rows", "batches", item, "lines", "--limit", "1"]);
    expect(listed.data).toMatchObject([
      { id: written.batch, rows: 1, undoes: null },
    ]);
    expect(listed.next_cursor).not.toBeNull();

    const undone = await c.cli.json<Batch & { undoes: string }>([
      "rows",
      "undo",
      item,
      "lines",
      written.batch!,
    ]);
    expect(undone.undoes).toBe(written.batch);
    expect(undone.results).toEqual([{ id: row, outcome: "deleted" }]);
    const missing = await c.cli.refused(["rows", "get", item, "lines", row]);
    expect(missing.envelope.error.server?.code).toBe("row_not_found");

    const redone = await c.cli.json<Batch & { undoes: string }>([
      "rows",
      "undo",
      item,
      "lines",
      undone.batch!,
    ]);
    expect(redone.results).toEqual([{ id: row, outcome: "created" }]);
    const back = await c.cli.json<Row>(["rows", "get", item, "lines", row]);
    expect(back.values).toEqual({ amount: 3 });
    await c.cli.json(["rows", "delete", item, "lines", row]);

    const unknown = await c.cli.refused([
      "rows",
      "undo",
      item,
      "lines",
      uuidv7(),
    ]);
    expect(unknown.envelope.error.server?.code).toBe("batch_not_found");
  });

  it("refuses a row that is not there, a column the table does not declare and a batch that is not one", async () => {
    const missing = await c.cli.refused([
      "rows",
      "get",
      item,
      "lines",
      uuidv7(),
    ]);
    expect(missing.envelope.error.server?.code).toBe("row_not_found");
    const noTable = await c.cli.refused(["rows", "list", item, "ledger"]);
    expect(noTable.envelope.error.server?.code).toBe("table_not_found");
    const unknownColumn = await c.cli.refused([
      "rows",
      "put",
      item,
      "lines",
      "--values",
      JSON.stringify({ amount: 1, colour: "red" }),
    ]);
    expect(unknownColumn.envelope.error.server?.code).toBe("validation_error");
    const notABatch = await c.cli.refused(
      ["rows", "write", item, "lines", "--file", "-"],
      { stdin: JSON.stringify([{ op: "delete", id: uuidv7() }]) },
    );
    expect(notABatch.envelope.error.server).toBeNull();
    const after = await c.cli.json<{ row_count: number }>([
      "rows",
      "totals",
      item,
      "lines",
    ]);
    expect(after.row_count).toBe(2);
  });

  it("names the column of a refused put or patch, where a batch names the operation too", async () => {
    const bad = JSON.stringify({ amount: "lots" });
    const batch = await c.cli.refused(
      ["rows", "write", item, "lines", "--file", "-"],
      {
        stdin: JSON.stringify({
          operations: [{ op: "put", values: JSON.parse(bad) as unknown }],
        }),
      },
    );
    expect(batch.envelope.error.message).toContain(
      "operations.0.values.amount",
    );
    expect(batch.envelope.error.server?.details).toMatchObject({
      operation: 0,
      errors: [{ path: "operations.0.values.amount" }],
    });

    const listed = await c.cli.json<{ data: Row[] }>([
      "rows",
      "list",
      item,
      "lines",
    ]);
    const row = listed.data[0]!.id;
    for (const args of [
      ["rows", "put", item, "lines", "--values", bad],
      ["rows", "patch", item, "lines", row, "--values", bad],
    ]) {
      const refused = await c.cli.refused(args);
      expect(refused.envelope.error.server?.code, args[1]).toBe(
        "validation_error",
      );
      expect(refused.envelope.error.message, args[1]).toContain(
        "values.amount: ",
      );
      expect(refused.envelope.error.message, args[1]).not.toContain(
        "operations.",
      );
      expect(refused.envelope.error.server?.details, args[1]).toEqual({
        errors: [
          { path: "values.amount", message: expect.any(String) as unknown },
        ],
      });
    }
  });
});
