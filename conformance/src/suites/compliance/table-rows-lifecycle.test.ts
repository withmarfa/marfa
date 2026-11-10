import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  BulkActionJob,
  RowOperation,
  TestContext,
} from "../../client/types.js";
import { callTool, connectMcp, toolError } from "../../utils/mcp.js";
import {
  createTestContext,
  getManagementClient,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "table-rows-lifecycle",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

let counter = 0;

function typeId(label: string): string {
  counter += 1;
  return `user.rows-life-${label}-${counter}-${ctx.runId}`;
}

const LINES = {
  lines: { columns: { amount: { type: "number" }, memo: { type: "string" } } },
};

async function register(
  id: string,
  tables: Record<string, unknown> = LINES,
): Promise<string> {
  const made = await client.registerType({
    id,
    fields: { title: { type: "string" } },
    tables,
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return id;
}

async function itemOf(type: string, title = "Ledger") {
  const made = await client.createItem({
    type,
    properties: { title },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

async function put(
  item: string,
  values: Record<string, unknown>[],
  table = "lines",
) {
  const res = await client.writeRows(item, table, {
    operations: values.map((v) => ({ op: "put", values: v }) as RowOperation),
  });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data;
}

async function narrowReader(
  types: Record<string, string>,
): Promise<MarfaClient> {
  counter += 1;
  const made = await client.createKey({
    label: `table-rows-life-${counter}`,
    source: `${ctx.source}-life-${counter}`,
    type_permissions: types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
}

describe("activity", () => {
  it("moves last_activity_at, and not updated_at or version, when a row changes", async () => {
    const made = await itemOf(await register(typeId("activity")));
    expect(made.last_activity_at).toBe(made.updated_at);
    await new Promise((r) => setTimeout(r, 5));
    const written = await put(made.id, [{ amount: 1 }]);
    const read = (await client.getItem(made.id)).data.item;
    expect(read.version).toBe(made.version);
    expect(read.updated_at).toBe(made.updated_at);
    expect(read.last_activity_at).toBe(written.last_activity_at);
    expect(read.last_activity_at! > made.updated_at!).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    const updated = await client.updateItem(made.id, {
      properties: { title: "Renamed" },
      version: read.version,
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect(updated.data.item.last_activity_at).toBe(
      updated.data.item.updated_at,
    );
  });

  it("lists items by last_activity_at", async () => {
    const type = await register(typeId("listing"));
    const older = await itemOf(type, "older");
    const newer = await itemOf(type, "newer");
    await new Promise((r) => setTimeout(r, 5));
    await put(older.id, [{ amount: 1 }]);
    const listed = async (direction: "asc" | "desc") =>
      (
        await client.listItems({ type, sort: "last_activity_at", direction })
      ).data.data.map((i) => i.id);
    expect(await listed("desc")).toEqual([older.id, newer.id]);
    expect(await listed("asc")).toEqual([newer.id, older.id]);
    const byCreation = (
      await client.listItems({ type, sort: "created_at", direction: "desc" })
    ).data.data.map((i) => i.id);
    expect(byCreation).toEqual([newer.id, older.id]);
  });
});

describe("rows and the life of an item", () => {
  it("removes a purged item's rows in pages, answering other requests meanwhile", async () => {
    const type = await register(typeId("purge"));
    const big = await itemOf(type, "big");
    const other = await itemOf(type, "other");
    await put(other.id, [{ amount: 1 }]);
    for (let batch = 0; batch < 30; batch++) {
      await put(
        big.id,
        Array.from({ length: 1000 }, (_, n) => ({
          amount: n,
          memo: `row ${batch}-${n}`,
        })),
      );
    }
    expect((await client.listTables(big.id)).data.data[0]?.row_count).toBe(
      30_000,
    );
    expect((await client.deleteItem(big.id)).status).toBe(200);
    const purgedAt = new Date().toISOString();
    expect((await client.purgeItem(big.id)).status).toBe(200);
    expect((await client.getItem(big.id)).status).toBe(404);

    const slowest = { ms: 0 };
    let running = true;
    const reads = (async () => {
      while (running) {
        const started = Date.now();
        const res = await client.listRows(other.id, "lines");
        expect(res.status).toBe(200);
        slowest.ms = Math.max(slowest.ms, Date.now() - started);
      }
    })();
    // The purge brings the job forward, so the scheduler may run it before this fixture asks.
    const management = getManagementClient();
    let result: { removed: number; pages: number } | undefined;
    const deadline = Date.now() + 60_000;
    let asked = false;
    while (!result && Date.now() < deadline) {
      const job = (await management.listHousekeeping()).data.data.find(
        (row) => row.name === "table-row-cleanup",
      );
      if (
        job?.last_started_at &&
        job.last_started_at > purgedAt &&
        job.last_finished_at &&
        !job.running_since
      ) {
        expect(job.last_outcome).toBe("ok");
        result = job.last_result as { removed: number; pages: number };
      } else if (!asked && !job?.running_since) {
        asked = true;
        await management.runHousekeeping("table-row-cleanup");
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    running = false;
    await reads;
    expect(result).toBeDefined();
    expect(result!.removed).toBeGreaterThanOrEqual(30_000);
    expect(result!.pages).toBeGreaterThan(1);
    expect(slowest.ms).toBeLessThan(1_000);

    const again = await management.runHousekeeping("table-row-cleanup");
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect((again.data.result as { removed: number }).removed).toBe(0);
    expect((await client.listRows(other.id, "lines")).data.data).toHaveLength(
      1,
    );
  });

  it("refuses a type move and a retype whose target does not declare the tables an item holds", async () => {
    const from = await register(typeId("from"), {
      ...LINES,
      extra: { columns: { note: { type: "string" } } },
    });
    const to = await register(typeId("to"));
    const empty = await itemOf(from, "no rows");
    const holding = await itemOf(from, "holding");
    await put(holding.id, [{ note: "kept" }], "extra");

    const moved = await client.moveType(from, { to });
    expect(moved.status).toBe(409);
    expect(moved.error?.error).toMatchObject({
      code: "type_move_blocked",
      details: { tables: ["extra"] },
    });
    const retyped = await client.updateItem(holding.id, {
      type: to,
      retype: true,
      version: holding.version,
    });
    expect(retyped.status).toBe(409);
    expect(retyped.error?.error).toMatchObject({
      code: "type_move_blocked",
      details: { tables: ["extra"] },
    });
    expect((await client.getItem(holding.id)).data.item.type).toBe(from);

    const fine = await client.updateItem(empty.id, {
      type: to,
      retype: true,
      version: empty.version,
    });
    expect(fine.status, JSON.stringify(fine.error)).toBe(200);
    const wide = await register(typeId("wide"), {
      ...LINES,
      extra: { columns: { note: { type: "string" } } },
    });
    const job = await client.moveType(from, { to: wide });
    expect(job.status, JSON.stringify(job.error)).toBe(202);
    const id = (job.data as BulkActionJob).id;
    for (let tries = 0; tries < 100; tries++) {
      const state = await client.rawRequest<BulkActionJob>(
        `/items/bulk-actions/jobs/${id}`,
      );
      if (state.data.status === "completed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await client.getItem(holding.id)).data.item.type).toBe(wide);
    expect(
      (await client.listRows(holding.id, "extra")).data.data[0]?.values,
    ).toEqual({ note: "kept" });
  });

  it("refuses to remove a table or a column that holds rows unless forced, and keeps the rows when forced", async () => {
    const id = typeId("change");
    await register(id, {
      lines: {
        columns: {
          amount: { type: "number" },
          memo: { type: "string" },
          spare: { type: "string" },
        },
      },
      notes: { columns: { text: { type: "string" } } },
      unused: { columns: { text: { type: "string" } } },
    });
    const item = await itemOf(id);
    const row = (await put(item.id, [{ amount: 1, memo: "kept" }])).results[0]!
      .id;
    await put(item.id, [{ text: "a note" }], "notes");

    const narrowed = {
      id,
      fields: { title: { type: "string" } },
      tables: {
        lines: {
          columns: { amount: { type: "string" }, spare: { type: "string" } },
        },
      },
    };
    const refused = await client.replaceType(id, narrowed);
    expect(refused.status).toBe(409);
    expect(refused.error?.error).toMatchObject({
      code: "type_in_use",
      details: { tables: ["lines.amount", "lines.memo", "notes"] },
    });
    const free = await client.replaceType(id, {
      ...narrowed,
      tables: {
        lines: {
          columns: { amount: { type: "number" }, memo: { type: "string" } },
        },
        notes: { columns: { text: { type: "string" } } },
      },
    });
    expect(free.status, JSON.stringify(free.error)).toBe(200);

    const forced = await client.replaceType(id, narrowed, true);
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    expect((await client.getRow(item.id, "lines", row)).data.values).toEqual({
      amount: 1,
      memo: "kept",
    });
    expect((await client.listRows(item.id, "notes")).status).toBe(404);
    const back = await client.replaceType(id, {
      ...narrowed,
      tables: {
        ...narrowed.tables,
        notes: { columns: { text: { type: "string" } } },
      },
    });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
    expect(
      (await client.listRows(item.id, "notes")).data.data[0]?.values,
    ).toEqual({ text: "a note" });
  });

  it("refuses a marfa_save_type change that removes what rows hold", async () => {
    const id = typeId("tool-change");
    await register(id, {
      lines: {
        columns: { amount: { type: "number" }, memo: { type: "string" } },
      },
      notes: { columns: { text: { type: "string" } } },
    });
    const item = await itemOf(id);
    await put(item.id, [{ amount: 1 }]);
    await put(item.id, [{ text: "a note" }], "notes");
    const schema = await connectMcp(
      apiUrl,
      apiKey,
      "2026-07-28",
      "/mcp/schema",
    );
    try {
      const refused = toolError(
        await callTool(schema, "marfa_save_type", {
          action: "change",
          id,
          tables: {
            lines: { columns: { amount: { type: "string" } } },
            notes: null,
          },
        }),
      );
      expect(refused).toMatchObject({
        code: "type_in_use",
        details: { tables: ["lines.amount", "notes"] },
      });
      const kept = await client.getType(id);
      expect(Object.keys(kept.data.tables ?? {}).sort()).toEqual([
        "lines",
        "notes",
      ]);
      expect(kept.data.tables?.lines.columns.amount.type).toBe("number");
    } finally {
      await schema.close();
    }
  });

  it("withholds an item id a row holds after its column is removed or retyped, or its item is retyped", async () => {
    const hiddenType = typeId("hidden");
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const hidden = (await itemOf(hiddenType, "hidden")).id;
    const withItem = {
      lines: {
        columns: { amount: { type: "number" }, about: { type: "item" } },
      },
    };
    const removed = await register(typeId("removed"), withItem);
    const retyped = await register(typeId("retyped"), withItem);
    const moving = await register(typeId("moving"), withItem);
    const plain = await register(typeId("plain"), {
      lines: {
        columns: { amount: { type: "number" }, about: { type: "string" } },
      },
    });
    const reader = await narrowReader({
      [removed]: "read",
      [retyped]: "read",
      [moving]: "read",
      [plain]: "read",
    });
    const holding = async (type: string) => {
      const item = await itemOf(type);
      const row = (await put(item.id, [{ amount: 1, about: hidden }]))
        .results[0]!.id;
      const before = await reader.getRow(item.id, "lines", row);
      expect(before.data.withheld).toEqual(["about"]);
      return { item, row };
    };
    const a = await holding(removed);
    const b = await holding(retyped);
    const c = await holding(moving);

    const replaced = (type: string, columns: Record<string, unknown>) =>
      client.replaceType(
        type,
        {
          id: type,
          fields: { title: { type: "string" } },
          tables: { lines: { columns } },
        },
        true,
      );
    expect(
      (await replaced(removed, { amount: { type: "number" } })).status,
    ).toBe(200);
    expect(
      (
        await replaced(retyped, {
          amount: { type: "number" },
          about: { type: "string" },
        })
      ).status,
    ).toBe(200);
    const moved = await client.updateItem(c.item.id, {
      type: plain,
      retype: true,
      version: c.item.version,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    for (const { item, row } of [a, b, c]) {
      const one = (await reader.getRow(item.id, "lines", row)).data;
      expect(one.values).toEqual({ amount: 1 });
      expect(one.withheld).toEqual(["about"]);
      const listed = (await reader.listRows(item.id, "lines")).data.data;
      expect(listed[0]?.values).toEqual({ amount: 1 });
      expect(JSON.stringify(listed)).not.toContain(hidden);
      expect((await client.getRow(item.id, "lines", row)).data.values).toEqual({
        amount: 1,
        about: hidden,
      });
    }
  });

  it("refuses a write naming an item id the key may not read after its column is retyped, whatever value it sends", async () => {
    const hiddenType = typeId("hidden-write");
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const hidden = (await itemOf(hiddenType, "hidden")).id;
    const type = await register(typeId("retyped-write"), {
      lines: {
        columns: { amount: { type: "number" }, about: { type: "item" } },
      },
    });
    const item = await itemOf(type);
    const row = (await put(item.id, [{ amount: 1, about: hidden }])).results[0]!
      .id;
    const retyped = await client.replaceType(
      type,
      {
        id: type,
        fields: { title: { type: "string" } },
        tables: {
          lines: {
            columns: { amount: { type: "number" }, about: { type: "string" } },
          },
        },
      },
      true,
    );
    expect(retyped.status, JSON.stringify(retyped.error)).toBe(200);
    const writer = await narrowReader({ [type]: "write" });
    for (const about of [hidden, "a guess"]) {
      for (const op of [
        { op: "patch", id: row, values: { about } },
        { op: "put", id: row, values: { amount: 1, about } },
      ] as RowOperation[]) {
        const res = await writer.writeRows(item.id, "lines", {
          operations: [op],
        });
        expect(res.status, JSON.stringify(op)).toBe(403);
        expect(res.error?.error).toMatchObject({
          code: "forbidden",
          details: { operation: 0, column: "about" },
        });
      }
    }
    expect((await client.getRow(item.id, "lines", row)).data.values).toEqual({
      amount: 1,
      about: hidden,
    });
    const owner = await client.writeRows(item.id, "lines", {
      operations: [{ op: "patch", id: row, values: { about: hidden } }],
    });
    expect(owner.data.results[0]?.outcome).toBe("unchanged");
  });

  it("shows the id of a purged item to a key that reads every type, and withholds it from any other", async () => {
    const type = await register(typeId("purged-ref"), {
      lines: {
        columns: { amount: { type: "number" }, about: { type: "item" } },
      },
    });
    const item = await itemOf(type);
    const note = await client.createItem({
      type: "core.note",
      properties: { title: "to purge" },
    } as never);
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    const gone = note.data.item.id;
    const row = (await put(item.id, [{ amount: 1, about: gone }])).results[0]!
      .id;
    const reader = await narrowReader({ [type]: "read", "core.note": "read" });
    expect((await reader.getRow(item.id, "lines", row)).data.values).toEqual({
      amount: 1,
      about: gone,
    });
    expect((await client.deleteItem(gone)).status).toBe(200);
    expect((await client.purgeItem(gone)).status).toBe(200);

    const filter = `values.about eq "${gone}"`;
    const owned = await client.getRow(item.id, "lines", row);
    expect(owned.data.values).toEqual({ amount: 1, about: gone });
    expect(owned.data).not.toHaveProperty("withheld");
    expect(
      (await client.listRows(item.id, "lines", { filter })).data.data.map(
        (r) => r.id,
      ),
    ).toEqual([row]);
    const read = await reader.getRow(item.id, "lines", row);
    expect(read.data.values).toEqual({ amount: 1 });
    expect(read.data.withheld).toEqual(["about"]);
    expect(
      (await reader.listRows(item.id, "lines", { filter })).data.data,
    ).toEqual([]);
  });

  it("shows a purged item's id to a key that reads every type after its column is removed or retyped, and withholds it from any other", async () => {
    const withItem = {
      lines: {
        columns: { amount: { type: "number" }, about: { type: "item" } },
      },
    };
    const removed = await register(typeId("purged-removed"), withItem);
    const retyped = await register(typeId("purged-retyped"), withItem);
    const reader = await narrowReader({
      [removed]: "read",
      [retyped]: "read",
      "core.note": "read",
    });
    const holding = async (type: string) => {
      const item = await itemOf(type);
      const note = await client.createItem({
        type: "core.note",
        properties: { title: "to purge" },
      } as never);
      expect(note.status, JSON.stringify(note.error)).toBe(201);
      const gone = note.data.item.id;
      const row = (await put(item.id, [{ amount: 1, about: gone }])).results[0]!
        .id;
      expect((await client.deleteItem(gone)).status).toBe(200);
      expect((await client.purgeItem(gone)).status).toBe(200);
      return { item, row, gone };
    };
    const a = await holding(removed);
    const b = await holding(retyped);
    const replaced = (type: string, columns: Record<string, unknown>) =>
      client.replaceType(
        type,
        {
          id: type,
          fields: { title: { type: "string" } },
          tables: { lines: { columns } },
        },
        true,
      );
    expect(
      (await replaced(removed, { amount: { type: "number" } })).status,
    ).toBe(200);
    expect(
      (
        await replaced(retyped, {
          amount: { type: "number" },
          about: { type: "string" },
        })
      ).status,
    ).toBe(200);

    for (const { item, row, gone } of [a, b]) {
      const owned = (await client.getRow(item.id, "lines", row)).data;
      expect(owned.values).toEqual({ amount: 1, about: gone });
      expect(owned).not.toHaveProperty("withheld");
      const read = (await reader.getRow(item.id, "lines", row)).data;
      expect(read.values).toEqual({ amount: 1 });
      expect(read.withheld).toEqual(["about"]);
    }
  });

  it("refuses to delete a type a column constrains to unless forced", async () => {
    const target = typeId("target");
    expect(
      (
        await client.registerType({
          id: target,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const holder = await register(typeId("holder"), {
      links: { columns: { to: { type: "item", type_constraints: [target] } } },
    });
    const refused = await client.deleteType(target);
    expect(refused.status).toBe(409);
    expect(refused.error?.error).toMatchObject({
      code: "type_in_use",
      details: { columns: [`${holder}.links.to`] },
    });
    const forced = await client.deleteType(target, true);
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    expect((await client.getType(target)).status).toBe(404);
  });
});
