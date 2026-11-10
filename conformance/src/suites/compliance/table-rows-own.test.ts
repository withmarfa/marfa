import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { RowOperation, TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import {
  callTool,
  connectMcp,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";
import type { SseEvent } from "../../utils/sse.js";
import { tapStream } from "../../utils/stream-tap.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let mcp: McpConnection;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "table-rows-own",
  ));
  mcp = await connectMcp(apiUrl, apiKey);
});

afterAll(async () => {
  await mcp?.close();
  await cleanup(ctx);
});

let counter = 0;

const COLUMNS = {
  name: { type: "string" },
  amount: { type: "number", adds_up: "sum" },
  paid: { type: "boolean" },
};

async function tableItem(
  columns: Record<string, unknown> = COLUMNS,
  type = "core.table",
): Promise<{ id: string; version: number }> {
  const made = await client.createItem({
    type,
    properties: { title: "Ledger", columns },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

async function put(item: string, values: Record<string, unknown>[]) {
  const res = await client.writeRows(item, "table", {
    operations: values.map((v) => ({ op: "put", values: v }) as RowOperation),
  });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data;
}

async function setColumns(id: string, columns: Record<string, unknown>) {
  const held = await client.getItem(id);
  const res = await client.updateItem(id, {
    properties: { columns },
    version: held.data.item.version,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
}

async function subtype(): Promise<string> {
  counter += 1;
  const id = `user.own-rows-${counter}-${ctx.runId}`;
  const made = await client.registerType({
    id,
    parent: "core.table",
    fields: { owner: { type: "string" } },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackType(ctx, id);
  return id;
}

async function narrowKey(types: Record<string, string>): Promise<string> {
  counter += 1;
  const made = await client.createKey({
    label: `rows-own-${counter}`,
    source: `${ctx.source}-own-${counter}`,
    type_permissions: types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return made.data.key;
}

async function hiddenItem(): Promise<string> {
  counter += 1;
  const id = `user.own-rows-hidden-${counter}-${ctx.runId}`;
  const made = await client.registerType({
    id,
    fields: { title: { type: "string" } },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackType(ctx, id);
  const item = await client.createItem({
    type: id,
    properties: { title: "hidden" },
  } as never);
  expect(item.status, JSON.stringify(item.error)).toBe(201);
  trackItem(ctx, item.data.item.id);
  return item.data.item.id;
}

describe("the table an item keeps", () => {
  it("lists the table an item keeps, with what it holds", async () => {
    const own = await tableItem();
    const empty = await client.listTables(own.id);
    expect(empty.status, JSON.stringify(empty.error)).toBe(200);
    expect(empty.data.data).toEqual([
      {
        name: "table",
        label: "Table",
        row_count: 0,
        bytes: 0,
        last_batch: null,
        changed_at: null,
      },
    ]);
    const written = await put(own.id, [{ name: "a" }, { name: "b" }]);
    const listed = (await client.listTables(own.id)).data.data;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "table",
      row_count: 2,
      last_batch: written.batch,
    });
    const child = await tableItem(COLUMNS, await subtype());
    expect((await client.listTables(child.id)).data.data[0]?.name).toBe(
      "table",
    );
    const note = await client.createItem({
      type: "core.note",
      properties: { title: "plain" },
    } as never);
    trackItem(ctx, note.data.item.id);
    expect((await client.listTables(note.data.item.id)).data.data).toEqual([]);
  });

  it("answers table_not_found for a table other than the one the item keeps", async () => {
    const own = await tableItem();
    const witness = await client.listRows(own.id, "table");
    expect(witness.status).toBe(200);
    for (const other of ["rows", "lines"]) {
      const read = await client.listRows(own.id, other);
      expect(read.status).toBe(404);
      expect(read.error?.error.code).toBe("table_not_found");
      const written = await client.writeRows(own.id, other, {
        operations: [{ op: "put", values: { name: "x" } }],
      });
      expect(written.status).toBe(404);
      expect(written.error?.error.code).toBe("table_not_found");
    }
  });

  it("writes rows against the item's columns, answering each operation in order", async () => {
    for (const type of ["core.table", await subtype()]) {
      const own = await tableItem(COLUMNS, type);
      const res = await client.writeRows(own.id, "table", {
        operations: [
          { op: "put", values: { name: "rent", amount: 900 } },
          { op: "put", values: { name: "tea", amount: 4, paid: true } },
        ],
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      expect(res.data.results.map((r) => r.outcome)).toEqual([
        "created",
        "created",
      ]);
      const id = res.data.results[1]!.id;
      expect((await client.getRow(own.id, "table", id)).data.values).toEqual({
        name: "tea",
        amount: 4,
        paid: true,
      });
      const patched = await client.writeRows(own.id, "table", {
        operations: [
          { op: "patch", id, values: { paid: false } },
          { op: "delete", id: res.data.results[0]!.id },
        ],
      });
      expect(patched.data.results.map((r) => r.outcome)).toEqual([
        "patched",
        "deleted",
      ]);
    }
  });

  it("refuses a value the item's columns do not take, and writes nothing", async () => {
    const own = await tableItem();
    const refused = await client.writeRows(own.id, "table", {
      operations: [
        { op: "put", values: { name: "fine" } },
        { op: "put", values: { amount: "many" } },
      ],
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error).toMatchObject({
      code: "validation_error",
      details: { operation: 1 },
    });
    expect(JSON.stringify(refused.error)).toContain(
      "operations.1.values.amount",
    );
    const unknown = await client.writeRows(own.id, "table", {
      operations: [{ op: "put", values: { colour: "red" } }],
    });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.error)).toContain(
      "operations.0.values.colour",
    );
    expect((await client.listRows(own.id, "table")).data.data).toEqual([]);
  });

  it("reads, filters and sorts rows by the item's columns", async () => {
    const own = await tableItem();
    const written = await put(own.id, [
      { name: "rent", amount: 900 },
      { name: "tea", amount: 4 },
      { name: "bus", amount: 30 },
    ]);
    const all = await client.listRows(own.id, "table");
    expect(all.data.data).toHaveLength(3);
    const some = await client.listRows(own.id, "table", {
      filter: "values.amount lt 100",
      sort: "values.amount",
      direction: "desc",
    });
    expect(some.status, JSON.stringify(some.error)).toBe(200);
    expect(some.data.data.map((row) => row.values.name)).toEqual([
      "bus",
      "tea",
    ]);
    const one = await client.getRow(own.id, "table", written.results[0]!.id);
    expect(one.data.values).toEqual({ name: "rent", amount: 900 });
    const refused = await client.listRows(own.id, "table", {
      filter: "values.colour eq 'red'",
    });
    expect(refused.status).toBe(400);
  });

  it("totals the columns the item says add up", async () => {
    const own = await tableItem();
    expect((await client.rowTotals(own.id, "table")).data).toEqual({
      row_count: 0,
      totals: { amount: { sum: 0 } },
    });
    await put(own.id, [
      { name: "rent", amount: 900 },
      { name: "tea", amount: 4 },
    ]);
    const all = await client.rowTotals(own.id, "table");
    expect(all.status, JSON.stringify(all.error)).toBe(200);
    expect(all.data).toEqual({
      row_count: 2,
      totals: { amount: { sum: 904 } },
    });
    const some = await client.rowTotals(
      own.id,
      "table",
      "values.amount lt 100",
    );
    expect(some.data).toEqual({ row_count: 1, totals: { amount: { sum: 4 } } });
  });

  it("judges rows by the columns as last updated", async () => {
    const own = await tableItem({ name: { type: "string" } });
    const before = await client.writeRows(own.id, "table", {
      operations: [{ op: "put", values: { score: 1 } }],
    });
    expect(before.status).toBe(400);
    await setColumns(own.id, {
      name: { type: "string" },
      score: { type: "integer", adds_up: "max" },
    });
    await put(own.id, [{ name: "a", score: 7 }]);
    expect((await client.rowTotals(own.id, "table")).data.totals).toEqual({
      score: { max: 7 },
    });
    const wrong = await client.writeRows(own.id, "table", {
      operations: [{ op: "put", values: { score: "high" } }],
    });
    expect(wrong.status).toBe(400);
  });

  it("keeps every row and value when a column is removed or retyped, and keeps withholding an item id", async () => {
    const hidden = await hiddenItem();
    const own = await tableItem({
      name: { type: "string" },
      qty: { type: "number" },
      about: { type: "item" },
    });
    const row = (await put(own.id, [{ name: "a", qty: 3, about: hidden }]))
      .results[0]!.id;
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: await narrowKey({ "core.table": "read" }),
    });
    expect((await reader.getRow(own.id, "table", row)).data.withheld).toEqual([
      "about",
    ]);

    await setColumns(own.id, {
      name: { type: "string" },
      qty: { type: "string" },
    });
    const kept = (await client.getRow(own.id, "table", row)).data;
    expect(kept.values).toEqual({ name: "a", qty: 3, about: hidden });
    const seen = (await reader.getRow(own.id, "table", row)).data;
    expect(seen.values).toEqual({ name: "a", qty: 3 });
    expect(seen.withheld).toEqual(["about"]);
    expect(
      JSON.stringify((await reader.listRows(own.id, "table")).data),
    ).not.toContain(hidden);
    expect((await client.listRows(own.id, "table")).data.data).toHaveLength(1);
    expect((await client.listTables(own.id)).data.data[0]?.row_count).toBe(1);
  });
});

describe("rows of the table an item keeps", () => {
  const rowsFor =
    (item: string) =>
    (event: SseEvent): boolean =>
      event.event === "rows.changed" &&
      (event.data as { item?: { id?: string } }).item?.id === item;

  interface Frame {
    table: string;
    batch: string;
    item: { id: string; type: string };
    rows: {
      id: string;
      values?: Record<string, unknown>;
      withheld?: string[];
    }[];
  }

  it("announces a rows.changed for a batch on the table an item keeps", async () => {
    const own = await tableItem();
    const tap = await tapStream(apiUrl, apiKey);
    try {
      await tap.until(
        (seen) => seen.some((e) => e.event === "stream_live"),
        "the stream going live",
      );
      const written = await client.writeRows(own.id, "table", {
        operations: [{ op: "put", values: { name: "rent", amount: 900 } }],
      });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      const frame = (
        await tap.until((seen) => seen.some(rowsFor(own.id)), "a rows frame")
      ).find(rowsFor(own.id))!.data as Frame;
      expect(frame).toMatchObject({
        table: "table",
        batch: written.data.batch,
        item: { id: own.id, type: "core.table" },
      });
      expect(frame.rows).toEqual([
        {
          id: written.data.results[0]!.id,
          values: { name: "rent", amount: 900 },
        },
      ]);
    } finally {
      await tap.close();
    }
  });

  it("withholds an item column's id from a key that may not read the item, in a read and an event", async () => {
    const hidden = await hiddenItem();
    const own = await tableItem({
      name: { type: "string" },
      about: { type: "item" },
    });
    const key = await narrowKey({ "core.table": "read" });
    const reader = new MarfaClient({ baseUrl: apiUrl, apiKey: key });
    const narrow = await tapStream(apiUrl, key);
    try {
      await narrow.until(
        (seen) => seen.some((e) => e.event === "stream_live"),
        "the narrow stream going live",
      );
      const written = await client.writeRows(own.id, "table", {
        operations: [{ op: "put", values: { name: "a", about: hidden } }],
      });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      const row = written.data.results[0]!.id;
      const one = (await reader.getRow(own.id, "table", row)).data;
      expect(one.values).toEqual({ name: "a" });
      expect(one.withheld).toEqual(["about"]);
      expect(
        JSON.stringify((await reader.listRows(own.id, "table")).data),
      ).not.toContain(hidden);
      expect((await client.getRow(own.id, "table", row)).data.values).toEqual({
        name: "a",
        about: hidden,
      });
      const frame = (
        await narrow.until((seen) => seen.some(rowsFor(own.id)), "a frame")
      ).find(rowsFor(own.id))!.data as Frame;
      expect(frame.rows[0]).toMatchObject({
        values: { name: "a" },
        withheld: ["about"],
      });
      expect(JSON.stringify(frame)).not.toContain(hidden);
    } finally {
      await narrow.close();
    }
  });
});

describe("an item that keeps a table, and the types around it", () => {
  it("refuses a retype of an item holding rows to a type that keeps no table, and takes one to a type that does", async () => {
    const own = await tableItem();
    await put(own.id, [{ name: "kept" }]);
    const below = await subtype();
    const note = await client.updateItem(own.id, {
      type: "core.note",
      retype: true,
      version: own.version,
    });
    expect(note.status).toBe(409);
    expect(note.error?.error).toMatchObject({
      code: "type_move_blocked",
      details: { tables: ["table"] },
    });
    expect((await client.getItem(own.id)).data.item.type).toBe("core.table");

    const moved = await client.updateItem(own.id, {
      type: below,
      retype: true,
      version: own.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(
      (await client.listRows(own.id, "table")).data.data[0]?.values,
    ).toEqual({ name: "kept" });
    const empty = await tableItem();
    const free = await client.updateItem(empty.id, {
      type: "core.note",
      properties: { title: "now a note" },
      retype: true,
      version: empty.version,
    } as never);
    expect(free.status, JSON.stringify(free.error)).toBe(200);
  });

  it("refuses to delete a type an item's column constrains to unless forced", async () => {
    counter += 1;
    const target = `user.own-rows-target-${counter}-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: target,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const own = await tableItem({
      link: { type: "item", type_constraints: [target] },
      other: { type: "item", type_constraints: ["core.note"] },
    });
    const refused = await client.deleteType(target);
    expect(refused.status).toBe(409);
    expect(refused.error?.error).toMatchObject({
      code: "type_in_use",
      details: { columns: [`${own.id}.table.link`] },
    });
    const forced = await client.deleteType(target, true);
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    expect((await client.getType(target)).status).toBe(404);
    const held = await client.getItem(own.id);
    expect(
      (held.data.item.properties.columns as Record<string, unknown>).link,
    ).toBeDefined();
  });

  it("refuses a type below core.table that declares a table named table", async () => {
    counter += 1;
    const id = `user.own-rows-reserved-${counter}-${ctx.runId}`;
    const tables = { table: { columns: { a: { type: "string" } } } };
    const refused = await client.registerType({
      id,
      parent: "core.table",
      fields: { owner: { type: "string" } },
      tables,
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect(JSON.stringify(refused.error)).toContain("tables.table");
    expect((await client.getType(id)).status).toBe(404);

    const named = await client.registerType({
      id,
      parent: "core.table",
      fields: { owner: { type: "string" } },
      tables: { lines: tables.table },
    } as never);
    expect(named.status, JSON.stringify(named.error)).toBe(201);
    trackType(ctx, id);
    const replaced = await client.replaceType(id, {
      id,
      parent: "core.table",
      fields: { owner: { type: "string" } },
      tables,
    });
    expect(replaced.status).toBe(400);

    counter += 1;
    const plain = `user.own-rows-plain-${counter}-${ctx.runId}`;
    const fine = await client.registerType({
      id: plain,
      fields: { title: { type: "string" } },
      tables,
    } as never);
    expect(fine.status, JSON.stringify(fine.error)).toBe(201);
    trackType(ctx, plain);
  });
  async function plainType(): Promise<string> {
    counter += 1;
    const id = `user.own-rows-plain-${counter}-${ctx.runId}`;
    const made = await client.registerType({
      id,
      fields: { owner: { type: "string" } },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackType(ctx, id);
    return id;
  }

  it("refuses a replacement that takes a type away from core.table while its items hold rows in the table they keep, unless forced", async () => {
    const below = await subtype();
    const own = await tableItem(COLUMNS, below);
    await put(own.id, [{ name: "kept", amount: 2 }]);
    const away = { id: below, fields: { owner: { type: "string" } } };

    const refused = await client.replaceType(below, away as never);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error).toMatchObject({
      code: "type_in_use",
      details: { tables: ["table"] },
    });
    expect((await client.getType(below)).data.parent).toBe("core.table");

    const empty = await subtype();
    await tableItem(COLUMNS, empty);
    const free = await client.replaceType(empty, {
      id: empty,
      fields: { owner: { type: "string" } },
    } as never);
    expect(free.status, JSON.stringify(free.error)).toBe(200);

    const forced = await client.replaceType(below, away as never, true);
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    const back = await client.replaceType(below, {
      ...away,
      parent: "core.table",
    } as never);
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    expect(
      (await client.listRows(own.id, "table")).data.data.map((r) => r.values),
    ).toEqual([{ name: "kept", amount: 2 }]);
  });

  it("refuses a replacement that judges rows an item keeps by a table its type declares in their place, unless the column types agree", async () => {
    const below = await subtype();
    const own = await tableItem(COLUMNS, below);
    await put(own.id, [{ name: "kept", amount: 2 }]);
    const declaring = (amount: string) => ({
      id: below,
      fields: { owner: { type: "string" } },
      tables: {
        table: {
          columns: { name: { type: "string" }, amount: { type: amount } },
        },
      },
    });
    const refused = await client.replaceType(
      below,
      declaring("string") as never,
    );
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error).toMatchObject({
      code: "type_in_use",
      details: { tables: ["table.amount"] },
    });
    const alike = await client.replaceType(below, declaring("number") as never);
    expect(alike.status, JSON.stringify(alike.error)).toBe(200);
  });

  it("refuses a replacement that places a type under core.table while a type below it declares a table named table", async () => {
    const top = await plainType();
    counter += 1;
    const leaf = `user.own-rows-leaf-${counter}-${ctx.runId}`;
    const tables = { table: { columns: { a: { type: "string" } } } };
    const made = await client.registerType({
      id: leaf,
      parent: top,
      fields: { extra: { type: "string" } },
      tables,
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackType(ctx, leaf);

    const moved = {
      id: top,
      parent: "core.table",
      fields: { owner: { type: "string" } },
    };
    const refused = await client.replaceType(top, moved as never);
    expect(refused.status, JSON.stringify(refused.data)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    const fields = (
      refused.error?.error.details as { errors: { field: string }[] }
    ).errors.map((e) => e.field);
    expect(fields).toEqual(["parent"]);
    expect((await client.getType(top)).data.parent).not.toBe("core.table");

    const renamed = await client.replaceType(leaf, {
      id: leaf,
      parent: top,
      fields: { extra: { type: "string" } },
      tables: { lines: tables.table },
    } as never);
    expect(renamed.status, JSON.stringify(renamed.error)).toBe(200);
    const taken = await client.replaceType(top, moved as never);
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("refuses a replacement that places a type under core.table while its items hold columns a table cannot take", async () => {
    const top = await plainType();
    const held = await client.createItem({
      type: top,
      properties: { title: "odd", columns: { a: { type: "money" } } },
    } as never);
    expect(held.status, JSON.stringify(held.error)).toBe(201);
    trackItem(ctx, held.data.item.id);
    const moved = {
      id: top,
      parent: "core.table",
      fields: { owner: { type: "string" } },
    };

    const refused = await client.replaceType(top, moved as never);
    expect(refused.status, JSON.stringify(refused.data)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    const fields = (
      refused.error?.error.details as { errors: { field: string }[] }
    ).errors.map((e) => e.field);
    expect(fields).toEqual(["parent"]);
    expect((await client.getType(top)).data.parent).not.toBe("core.table");

    const fixed = await client.updateItem(held.data.item.id, {
      properties: { columns: { a: { type: "number" } } },
      version: held.data.item.version,
    });
    expect(fixed.status, JSON.stringify(fixed.error)).toBe(200);
    const taken = await client.replaceType(top, moved as never);
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("takes a type under core.table whose items name an unregistered type in a column, and refuses one whose column has an empty type_constraints", async () => {
    const named = await plainType();
    const emptied = await plainType();
    const columns = (constraints: string[]) => ({
      link: { type: "item", type_constraints: constraints },
    });
    for (const [type, constraints] of [
      [named, ["user.nothing_registers_this"]],
      [emptied, []],
    ] as const) {
      const held = await client.createItem({
        type,
        properties: { title: "odd", columns: columns([...constraints]) },
      } as never);
      expect(held.status, JSON.stringify(held.error)).toBe(201);
      trackItem(ctx, held.data.item.id);
    }
    const moved = (id: string) =>
      ({
        id,
        parent: "core.table",
        fields: { owner: { type: "string" } },
      }) as never;

    const taken = await client.replaceType(named, moved(named));
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
    const refused = await client.replaceType(emptied, moved(emptied));
    expect(refused.status, JSON.stringify(refused.data)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    const fields = (
      refused.error?.error.details as { errors: { field: string }[] }
    ).errors.map((e) => e.field);
    expect(fields).toEqual(["parent"]);
  });
});

describe("the table an item keeps, through undo and MCP", () => {
  const rowsOf = async (item: string) => {
    const listed = await client.listRows(item, "table", { limit: 1000 });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    return Object.fromEntries(
      listed.data.data.map((row) => [row.id, row.values]),
    );
  };

  it("undoes and redoes a batch on the table an item keeps, and lists its batches", async () => {
    const own = await tableItem();
    const seeded = await put(own.id, [{ name: "a", amount: 1 }]);
    const [kept] = seeded.results.map((r) => r.id);
    const before = await rowsOf(own.id);
    const changed = await client.writeRows(own.id, "table", {
      operations: [
        { op: "patch", id: kept!, values: { amount: 2 } },
        { op: "put", values: { name: "b", amount: 3 } },
      ],
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    const batch = changed.data.batch!;
    expect(Object.keys(await rowsOf(own.id))).toHaveLength(2);
    const held = await client.listBatches(own.id, "table");
    expect(held.status, JSON.stringify(held.error)).toBe(200);
    expect(held.data.data.map((entry) => entry.id)).toEqual([
      batch,
      seeded.batch,
    ]);

    const undone = await client.undoBatch(own.id, "table", batch);
    expect(undone.status, JSON.stringify(undone.error)).toBe(200);
    expect(undone.data.undoes).toBe(batch);
    expect(await rowsOf(own.id)).toEqual(before);

    const redone = await client.undoBatch(own.id, "table", undone.data.batch!);
    expect(redone.status, JSON.stringify(redone.error)).toBe(200);
    expect(Object.keys(await rowsOf(own.id))).toHaveLength(2);

    const listed = await client.listBatches(own.id, "table");
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.data.map((entry) => entry.undoes)).toEqual([
      undone.data.batch,
      batch,
      null,
    ]);

    const elsewhere = await client.undoBatch(own.id, "lines", batch);
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.error?.error.code).toBe("table_not_found");
  });

  it("lists the table an item keeps with marfa_get, and reads and writes its rows through MCP", async () => {
    const own = await tableItem();
    const plain = await client.createItem({
      type: "core.note",
      properties: { body: "plain" },
    });
    trackItem(ctx, plain.data.item.id);
    const written = toolResult(
      await callTool(mcp, "marfa_write_rows", {
        id: own.id,
        table: "table",
        operations: [
          { op: "put", values: { name: "a", amount: 4 } },
          { op: "put", values: { name: "b", amount: 5 } },
        ],
      }),
    );
    expect(written.batch).toEqual(expect.any(String));
    expect(Object.keys(await rowsOf(own.id))).toHaveLength(2);

    const read = toolResult(
      await callTool(mcp, "marfa_read_rows", {
        id: own.id,
        table: "table",
        filter: "values.amount gt 4",
        totals: true,
      }),
    );
    expect(read.rows).toMatchObject([{ values: { name: "b", amount: 5 } }]);
    expect(read.totals).toMatchObject({ amount: { sum: 5 } });

    const got = toolResult(
      await callTool(mcp, "marfa_get", { ids: [own.id, plain.data.item.id] }),
    );
    const items = got.items as { id: string; tables?: unknown }[];
    expect(items.find((i) => i.id === own.id)?.tables).toEqual([
      {
        name: "table",
        label: "Table",
        columns: ["name", "amount", "paid"],
        row_count: 2,
      },
    ]);
    expect(items.find((i) => i.id === plain.data.item.id)).not.toHaveProperty(
      "tables",
    );
  });
});
