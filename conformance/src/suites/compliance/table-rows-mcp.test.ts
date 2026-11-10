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
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let mcp: McpConnection;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "table-rows-mcp",
  ));
  mcp = await connectMcp(apiUrl, apiKey);
});

afterAll(async () => {
  await mcp?.close();
  await cleanup(ctx);
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUDGET = 40_000;

let counter = 0;

async function ledger(
  extra: Record<string, unknown> = {},
): Promise<{ type: string; item: string }> {
  counter += 1;
  const type = `user.rows-mcp-${counter}-${ctx.runId}`;
  const made = await client.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: {
      lines: {
        label: "Lines",
        columns: {
          amount: { type: "number", adds_up: "sum" },
          memo: { type: "string" },
          kind: { type: "enum", enum_values: ["food", "travel"] },
          ...extra,
        },
      },
    },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const item = await client.createItem({
    type,
    properties: { title: "Ledger" },
  } as never);
  expect(item.status, JSON.stringify(item.error)).toBe(201);
  trackItem(ctx, item.data.item.id);
  return { type, item: item.data.item.id };
}

async function put(
  item: string,
  rows: Record<string, unknown>[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let at = 0; at < rows.length; at += 1000) {
    const operations: RowOperation[] = rows
      .slice(at, at + 1000)
      .map((values) => ({ op: "put", values }));
    const res = await client.writeRows(item, "lines", { operations });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    ids.push(...res.data.results.map((r) => r.id));
  }
  return ids;
}

async function narrow(
  types: Record<string, "read" | "write">,
): Promise<{ client: MarfaClient; key: string }> {
  counter += 1;
  const made = await client.createKey({
    label: `rows-mcp-narrow-${counter}`,
    source: `${ctx.source}-narrow-${counter}`,
    type_permissions: types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return {
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key }),
    key: made.data.key,
  };
}

describe("marfa_read_rows", () => {
  it("reads rows as the page door does, by filter, sort and cursor", async () => {
    const { item } = await ledger();
    await put(
      item,
      Array.from({ length: 120 }, (_, n) => ({ amount: n, memo: `m${n}` })),
    );

    const defaults = toolResult(
      await callTool(mcp, "marfa_read_rows", { id: item, table: "lines" }),
    );
    const door = (await client.listRows(item, "lines", { limit: 50 })).data;
    expect(defaults.rows).toHaveLength(50);
    expect(defaults.rows).toEqual(door.data);
    expect(defaults.next_cursor).toBe(door.next_cursor);
    expect(defaults.id).toBe(item);
    expect(defaults.table).toBe("lines");

    const asked = {
      filter: "values.amount gt 100",
      sort: "values.amount",
      direction: "desc" as const,
      limit: 7,
    };
    let cursor: string | undefined;
    const seen: unknown[] = [];
    for (let page = 0; page < 5; page++) {
      const read = toolResult(
        await callTool(mcp, "marfa_read_rows", {
          id: item,
          table: "lines",
          ...asked,
          ...(cursor ? { cursor } : {}),
        }),
      );
      const same = (
        await client.listRows(item, "lines", {
          ...asked,
          ...(cursor ? { cursor } : {}),
        })
      ).data;
      expect(read.rows).toEqual(same.data);
      expect(read.next_cursor).toBe(same.next_cursor);
      seen.push(...(read.rows as unknown[]));
      if (!read.next_cursor) break;
      cursor = read.next_cursor as string;
    }
    expect(seen).toHaveLength(19);
    expect(
      (seen as { values: { amount: number } }[]).map((r) => r.values.amount),
    ).toEqual(Array.from({ length: 19 }, (_, n) => 119 - n));
  });

  it("refuses a read as the page door does", async () => {
    const { item } = await ledger();
    const { item: other } = await ledger();
    await put(item, [{ amount: 1 }]);
    const first = await client.listRows(item, "lines", { limit: 1 });
    await put(other, [{ amount: 1 }, { amount: 2 }]);
    const foreign = (await client.listRows(other, "lines", { limit: 1 })).data
      .next_cursor;
    expect(foreign).toBeTruthy();
    expect(first.status).toBe(200);

    const cases: [string, Record<string, unknown>, Record<string, string>][] = [
      ["a table the type does not declare", { table: "nothing" }, {}],
      ["a filter on an unknown column", { filter: "values.colour eq 1" }, {}],
      ["a filter that does not parse", { filter: "values.amount eq" }, {}],
      ["a sort on an unknown column", { sort: "values.colour" }, {}],
      ["a cursor answered for another table", { cursor: foreign }, {}],
      ["a cursor that is not one", { cursor: "nonsense" }, {}],
    ];
    for (const [label, args] of cases) {
      const { table = "lines", ...query } = args as {
        table?: string;
        [k: string]: unknown;
      };
      const door = await client.listRows(item, table, query as never);
      expect(door.ok, label).toBe(false);
      const refused = toolError(
        await callTool(mcp, "marfa_read_rows", { id: item, table, ...query }),
      );
      expect(refused.code, label).toBe(door.error?.error.code);
    }

    const limit = await callTool(mcp, "marfa_read_rows", {
      id: item,
      table: "lines",
      limit: 0,
    });
    expect(toolError(limit).code).toBe("validation_error");

    const missing = await callTool(mcp, "marfa_read_rows", {
      id: uuidv7(),
      table: "lines",
    });
    expect(toolError(missing).code).toBe("item_not_found");

    const { type } = await ledger();
    const { key } = await narrow({ "core.note": "read" });
    const unreadable = await connectMcp(apiUrl, key);
    try {
      const hidden = await client.createItem({
        type,
        properties: { title: "Hidden" },
      } as never);
      trackItem(ctx, hidden.data.item.id);
      const refusedItem = await callTool(unreadable, "marfa_read_rows", {
        id: hidden.data.item.id,
        table: "lines",
      });
      expect(toolError(refusedItem).code).toBe("item_not_found");
    } finally {
      await unreadable.close();
    }
  });

  it("answers totals only when asked", async () => {
    const { item } = await ledger();
    await put(item, [{ amount: 1 }, { amount: 2 }, { amount: 4 }]);
    const base = { id: item, table: "lines", filter: "values.amount gt 1" };

    const asked = toolResult(
      await callTool(mcp, "marfa_read_rows", { ...base, totals: true }),
    );
    const door = (await client.rowTotals(item, "lines", base.filter)).data;
    expect(asked.row_count).toBe(2);
    expect(asked.row_count).toBe(door.row_count);
    expect(asked.totals).toEqual(door.totals);
    expect(asked.totals).toEqual({ amount: { sum: 6 } });

    for (const args of [base, { ...base, totals: false }]) {
      const unasked = toolResult(await callTool(mcp, "marfa_read_rows", args));
      expect(unasked).not.toHaveProperty("row_count");
      expect(unasked).not.toHaveProperty("totals");
      expect(unasked.rows).toHaveLength(2);
    }
  });

  it("stops a page at the answer budget and continues by next_cursor", async () => {
    const { item } = await ledger();
    const ids = await put(
      item,
      Array.from({ length: 60 }, (_, n) => ({
        amount: n,
        memo: `${n}-`.padEnd(3000, "x"),
      })),
    );
    const walk = async (sort?: string) => {
      const read = async (cursor?: string) => {
        const answered = await callTool(mcp, "marfa_read_rows", {
          id: item,
          table: "lines",
          limit: 60,
          ...(sort ? { sort } : {}),
          ...(cursor ? { cursor } : {}),
        });
        expect(answered.text.length).toBeLessThanOrEqual(BUDGET);
        return toolResult(answered);
      };
      const first = await read();
      const rows = first.rows as { id: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(60);
      expect(first.next_cursor).toEqual(expect.any(String));
      expect(first.hint).toEqual(expect.stringContaining("stopped early"));
      expect(first.hint).toEqual(expect.stringContaining("next_cursor"));
      expect(first).not.toHaveProperty("cut");

      const seen = rows.map((r) => r.id);
      let cursor = first.next_cursor as string | null;
      for (let page = 0; cursor && page < 60; page++) {
        const next = await read(cursor);
        seen.push(...(next.rows as { id: string }[]).map((r) => r.id));
        cursor = next.next_cursor as string | null;
      }
      return seen;
    };

    expect(await walk()).toEqual([...ids].sort());
    const sorted = (
      await client.listRows(item, "lines", {
        sort: "values.memo",
        limit: 1000,
      })
    ).data.data.map((r) => r.id);
    expect(await walk("values.memo")).toEqual(sorted);
  });

  it("keeps next_cursor short and exact when rows sort on a 54,000-character value", async () => {
    const { item } = await ledger();
    const long = (tail: string) => `${"a".repeat(54_000 - tail.length)}${tail}`;
    const ids = await put(
      item,
      ["0003", "0001", "0004", "0002"].map((tail) => ({
        amount: 1,
        memo: long(tail),
      })),
    );
    for (const direction of ["asc", "desc"] as const) {
      const whole = (
        await client.listRows(item, "lines", {
          sort: "values.memo",
          direction,
          limit: 1000,
        })
      ).data.data.map((r) => r.id);
      expect([...whole].sort()).toEqual([...ids].sort());
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const answered = await callTool(mcp, "marfa_read_rows", {
          id: item,
          table: "lines",
          sort: "values.memo",
          direction,
          ...(cursor ? { cursor } : {}),
        });
        expect(answered.text.length).toBeLessThanOrEqual(BUDGET);
        const read = toolResult(answered);
        const rows = read.rows as { id: string }[];
        expect(rows).toHaveLength(1);
        seen.push(rows[0]!.id);
        const next = read.next_cursor as string | null;
        if (next) expect(next.length).toBeLessThanOrEqual(512);
        cursor = next ?? undefined;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(4);
      expect(seen).toEqual(whole);
    }
  });

  it("cuts the text of a row too long to fit and reads the rest by offset", async () => {
    const { item } = await ledger();
    const memo = Array.from({ length: 6000 }, (_, n) =>
      String(n).padStart(9, "0"),
    ).join("");
    expect(memo.length).toBe(54_000);
    const [row] = await put(item, [{ amount: 3, memo }]);

    const answered = await callTool(mcp, "marfa_read_rows", {
      id: item,
      table: "lines",
    });
    expect(answered.text.length).toBeLessThanOrEqual(BUDGET);
    const read = toolResult(answered);
    const shown = (
      read.rows as { values: { amount: number; memo: string } }[]
    )[0];
    expect(shown?.values.amount).toBe(3);
    expect(read.next_cursor).toBeNull();
    expect(read.hint).toEqual(expect.stringContaining("next_offset"));
    expect(read.hint).not.toEqual(expect.stringContaining("stopped early"));
    const cut = read.cut as {
      id: string;
      column: string;
      returned_chars: number;
      total_chars: number;
      next_offset: number;
    }[];
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({
      id: row,
      column: "memo",
      total_chars: memo.length,
      returned_chars: shown?.values.memo.length,
    });
    expect(shown?.values.memo).toBe(memo.slice(0, cut[0]?.next_offset));

    let text = shown?.values.memo ?? "";
    let offset: number | null = cut[0]?.next_offset ?? 0;
    for (let part = 0; offset !== null && part < 10; part++) {
      const piece = toolResult(
        await callTool(mcp, "marfa_read_rows", {
          id: item,
          table: "lines",
          row,
          column: "memo",
          offset,
        }),
      );
      expect(piece.offset).toBe(offset);
      text += piece.text as string;
      offset = piece.next_offset as number | null;
    }
    expect(offset).toBeNull();
    expect(text).toBe(memo);
  });
});

describe("marfa_write_rows", () => {
  it("writes a batch through marfa_write_rows as the write door does", async () => {
    const { item } = await ledger();
    const kept = uuidv7();
    const replaced = uuidv7();
    const gone = uuidv7();
    const seeded = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id: kept, values: { amount: 1, memo: "a" } },
        { op: "put", id: replaced, values: { amount: 2, memo: "b" } },
        { op: "put", id: gone, values: { amount: 3 } },
      ],
    });
    expect(seeded.status).toBe(200);

    const fresh = uuidv7();
    const answer = toolResult(
      await callTool(mcp, "marfa_write_rows", {
        id: item,
        table: "lines",
        operations: [
          { op: "put", id: fresh, values: { amount: 9, kind: "food" } },
          { op: "put", values: { amount: 8 } },
          { op: "put", id: replaced, values: { amount: 5 } },
          { op: "patch", id: kept, values: { amount: 7 } },
          { op: "delete", id: gone },
        ],
      }),
    );
    expect(answer.batch).toMatch(UUID);
    expect(answer.last_activity_at).toEqual(expect.any(String));
    const results = answer.results as { id: string; outcome: string }[];
    expect(results.map((r) => r.outcome)).toEqual([
      "created",
      "created",
      "replaced",
      "patched",
      "deleted",
    ]);
    expect(results[0]?.id).toBe(fresh);
    expect(results[1]?.id).toMatch(UUID);

    const rows = (await client.listRows(item, "lines")).data.data;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.values]));
    expect(byId[fresh]).toEqual({ amount: 9, kind: "food" });
    expect(byId[results[1]?.id ?? ""]).toEqual({ amount: 8 });
    expect(byId[replaced]).toEqual({ amount: 5 });
    expect(byId[kept]).toEqual({ amount: 7, memo: "a" });
    expect(byId[gone]).toBeUndefined();

    const unchanged = toolResult(
      await callTool(mcp, "marfa_write_rows", {
        id: item,
        table: "lines",
        operations: [
          { op: "put", id: fresh, values: { amount: 9, kind: "food" } },
        ],
      }),
    );
    expect(unchanged.batch).toBeNull();
    expect((unchanged.results as { outcome: string }[])[0]?.outcome).toBe(
      "unchanged",
    );
  });

  it("records a rows write made through MCP with the caller's key and address and via mcp", async () => {
    const { item } = await ledger();
    const direct = await client.writeRows(item, "lines", {
      operations: [{ op: "put", values: { amount: 1 } }],
    });
    expect(direct.status).toBe(200);
    toolResult(
      await callTool(mcp, "marfa_write_rows", {
        id: item,
        table: "lines",
        operations: [{ op: "put", values: { amount: 2 } }],
      }),
    );
    const audit = await client.listAudit({
      action: "rows.write",
      resource_id: item,
    });
    expect(audit.status, JSON.stringify(audit.error)).toBe(200);
    expect(audit.data.data).toHaveLength(2);
    const via = audit.data.data.map((entry) => entry.details?.via);
    expect(via.filter((v) => v === "mcp")).toHaveLength(1);
    expect(via.filter((v) => v === undefined)).toHaveLength(1);
    expect(new Set(audit.data.data.map((entry) => entry.key_id)).size).toBe(1);
    const addresses = new Set(audit.data.data.map((entry) => entry.client_ip));
    expect(addresses.size).toBe(1);
    expect([...addresses][0]).not.toBeNull();
  });

  it("refuses a batch as the write door does and writes none of it", async () => {
    const { item } = await ledger();
    const [existing] = await put(item, [{ amount: 1 }]);
    const fresh = uuidv7();
    const bad: [string, RowOperation | Record<string, unknown>][] = [
      ["an unknown op", { op: "upsert", id: fresh, values: {} }],
      ["a member it does not take", { op: "put", version: 1, values: {} }],
      ["a delete that sends values", { op: "delete", id: fresh, values: {} }],
      ["an id that is not a UUID", { op: "put", id: "nope", values: {} }],
      ["no values", { op: "put", id: fresh }],
      ["an unknown column", { op: "put", values: { colour: 1 } }],
      ["a value of the wrong kind", { op: "put", values: { amount: "x" } }],
      [
        "a patch of a row the table lacks",
        { op: "patch", id: uuidv7(), values: {} },
      ],
    ];
    for (const [label, op] of bad) {
      const operations = [{ op: "put", id: fresh, values: { amount: 2 } }, op];
      const door = await client.writeRows(item, "lines", {
        operations: operations as RowOperation[],
      });
      expect(door.ok, label).toBe(false);
      const refused = toolError(
        await callTool(mcp, "marfa_write_rows", {
          id: item,
          table: "lines",
          operations,
        }),
      );
      expect(refused.code, label).toBe(door.error?.error.code);
      expect(refused.message, label).toBe(door.error?.error.message);
      expect(refused.details, label).toEqual(door.error?.error.details);
    }
    for (const operations of [[], [{ op: "put", values: { amount: 1 } }, 7]]) {
      const door = await client.writeRows(item, "lines", {
        operations: operations as RowOperation[],
      });
      const refused = toolError(
        await callTool(mcp, "marfa_write_rows", {
          id: item,
          table: "lines",
          operations,
        }),
      );
      expect(refused.code).toBe(door.error?.error.code);
      expect(refused.details).toEqual(door.error?.error.details);
    }
    const missingTable = toolError(
      await callTool(mcp, "marfa_write_rows", {
        id: item,
        table: "nothing",
        operations: [{ op: "put", values: { amount: 1 } }],
      }),
    );
    expect(missingTable.code).toBe("table_not_found");

    const rows = (await client.listRows(item, "lines")).data.data;
    expect(rows.map((r) => r.id)).toEqual([existing]);
  });

  it("refuses a batch that is not a list as the write door does", async () => {
    const { item } = await ledger();
    const shapes: [string, Record<string, unknown>][] = [
      ["no operations", {}],
      ["null", { operations: null }],
      ["an object", { operations: { op: "put", values: { amount: 1 } } }],
      ["a string", { operations: "put" }],
      ["a number", { operations: 7 }],
    ];
    for (const [label, body] of shapes) {
      const door = await client.writeRows(item, "lines", body as never);
      expect(door.status, label).toBe(400);
      expect(door.error?.error.details, label).toMatchObject({
        field: "operations",
        errors: [expect.objectContaining({ path: "operations" })],
      });
      const refused = toolError(
        await callTool(mcp, "marfa_write_rows", {
          id: item,
          table: "lines",
          ...body,
        }),
      );
      expect(refused.code, label).toBe(door.error?.error.code);
      expect(refused.message, label).toBe(door.error?.error.message);
      expect(refused.details, label).toEqual(door.error?.error.details);
    }
    expect((await client.listRows(item, "lines")).data.data).toHaveLength(0);
  });

  async function withheldRow() {
    counter += 1;
    const hiddenType = `user.rows-mcp-private-${counter}-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const hidden = await client.createItem({
      type: hiddenType,
      properties: { title: "Private" },
    } as never);
    trackItem(ctx, hidden.data.item.id);
    const { type, item } = await ledger({ about: { type: "item" } });
    const row = uuidv7();
    const written = await client.writeRows(item, "lines", {
      operations: [
        {
          op: "put",
          id: row,
          values: { amount: 1, about: hidden.data.item.id },
        },
      ],
    });
    expect(written.status, JSON.stringify(written.error)).toBe(200);
    const { key } = await narrow({ [type]: "write", "core.note": "read" });
    return { type, item, row, hidden: hidden.data.item.id, key };
  }

  it("refuses a column whose value the key may not read, as the write door does", async () => {
    const { item, row, hidden, key } = await withheldRow();
    const writer = await connectMcp(apiUrl, key);
    try {
      const fresh = uuidv7();
      const answered = await callTool(writer, "marfa_write_rows", {
        id: item,
        table: "lines",
        operations: [
          { op: "put", id: fresh, values: { amount: 2 } },
          { op: "patch", id: row, values: { about: null } },
        ],
      });
      const refused = toolError(answered);
      expect(refused).toMatchObject({
        code: "forbidden",
        details: { operation: 1, column: "about" },
      });
      expect(answered.text).not.toContain(hidden);
      expect((await client.getRow(item, "lines", fresh)).status).toBe(404);
      expect((await client.getRow(item, "lines", row)).data.values).toEqual({
        amount: 1,
        about: hidden,
      });
    } finally {
      await writer.close();
    }
  });

  it("refuses a write to an item whose type the key may only read", async () => {
    const { type: readable, item } = await ledger();
    const { type: writable } = await ledger();
    const { key } = await narrow({ [readable]: "read", [writable]: "write" });
    const connection = await connectMcp(apiUrl, key);
    try {
      const refused = toolError(
        await callTool(connection, "marfa_write_rows", {
          id: item,
          table: "lines",
          operations: [{ op: "put", values: { amount: 1 } }],
        }),
      );
      expect(refused.code).toBe("type_not_permitted");
    } finally {
      await connection.close();
    }
    expect((await client.listRows(item, "lines")).data.data).toHaveLength(0);
  });

  it("refuses a batch of more than 200 operations", async () => {
    const { item } = await ledger();
    const operations = (count: number) =>
      Array.from({ length: count }, (_, n) => ({
        op: "put",
        values: { amount: n },
      }));
    const refused = toolError(
      await callTool(mcp, "marfa_write_rows", {
        id: item,
        table: "lines",
        operations: operations(201),
      }),
    );
    expect(refused.code).toBe("validation_error");
    expect(refused.message).toEqual(expect.stringContaining("operations"));
    expect(refused.details).toMatchObject({ field: "operations" });
    expect((await client.listRows(item, "lines")).data.data).toHaveLength(0);

    const accepted = toolResult(
      await callTool(mcp, "marfa_write_rows", {
        id: item,
        table: "lines",
        operations: operations(200),
      }),
    );
    expect(accepted.results).toHaveLength(200);
  });
});

describe("marfa_get with tables", () => {
  it("lists an item's tables with marfa_get and answers no row", async () => {
    const { item } = await ledger();
    await put(item, [{ amount: 1 }, { amount: 2 }]);
    const door = (await client.listTables(item)).data.data;
    const got = toolResult(await callTool(mcp, "marfa_get", { ids: [item] }));
    const shown = (got.items as { tables: unknown[] }[])[0];
    expect(shown?.tables).toEqual([
      {
        name: "lines",
        label: "Lines",
        columns: ["amount", "memo", "kind"],
        row_count: 2,
      },
    ]);
    expect(door[0]).toMatchObject({ name: "lines", row_count: 2 });
    expect(JSON.stringify(got)).not.toContain('"values"');
  });

  it("leaves tables out of an item whose type declares none", async () => {
    const note = await client.createItem({
      type: "core.note",
      properties: { body: "plain" },
    });
    trackItem(ctx, note.data.item.id);
    const { item } = await ledger();
    const got = toolResult(
      await callTool(mcp, "marfa_get", { ids: [note.data.item.id, item] }),
    );
    const items = got.items as { id: string; tables?: unknown }[];
    expect(items.find((i) => i.id === note.data.item.id)).not.toHaveProperty(
      "tables",
    );
    expect(items.find((i) => i.id === item)).toHaveProperty("tables");
  });

  it("leaves the columns out of the listed tables before it leaves out an item", async () => {
    counter += 1;
    const type = `user.rows-mcp-wide-${counter}-${ctx.runId}`;
    const columns = Object.fromEntries(
      Array.from({ length: 64 }, (_, n) => [
        `column_${String(n).padStart(55, "0")}`,
        { type: "string" },
      ]),
    );
    const tables = Object.fromEntries(
      Array.from({ length: 32 }, (_, n) => [
        `table_${String(n).padStart(2, "0")}`,
        { columns },
      ]),
    );
    const made = await client.registerType({
      id: type,
      fields: { title: { type: "string" } },
      tables,
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const ids: string[] = [];
    for (let n = 0; n < 2; n++) {
      const item = await client.createItem({
        type,
        properties: { title: `Wide ${n}` },
      } as never);
      expect(item.status, JSON.stringify(item.error)).toBe(201);
      trackItem(ctx, item.data.item.id);
      ids.push(item.data.item.id);
    }

    const answered = await callTool(mcp, "marfa_get", { ids });
    expect(answered.text.length).toBeLessThanOrEqual(BUDGET);
    const got = toolResult(answered);
    const items = got.items as {
      tables: { name: string; columns?: string[]; row_count: number }[];
    }[];
    expect(items).toHaveLength(2);
    expect(got).not.toHaveProperty("not_returned");
    for (const item of items) {
      expect(item.tables).toHaveLength(32);
      expect(item.tables[0]).toEqual({
        name: "table_00",
        label: "Table 00",
        row_count: 0,
      });
    }
    expect(got.hint).toEqual(expect.stringContaining("columns"));
  });
});
