import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient, type UpdateItemInput } from "../../client/api.js";
import type { ApiResponse, TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "table-own-columns",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Columns = Record<string, unknown>;

async function create(columns: unknown, type = "core.table") {
  const res = await client.createItem({
    type,
    source: ctx.source,
    properties: { title: "Budget", columns },
  });
  if (res.ok) trackItem(ctx, res.data.item.id);
  return res;
}

async function made(columns: Columns, type = "core.table") {
  const res = await create(columns, type);
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data.item.id;
}

async function change(
  who: MarfaClient,
  id: string,
  body: Omit<UpdateItemInput, "version">,
) {
  const held = await client.getItem(id);
  return who.updateItem(id, { ...body, version: held.data.item.version });
}

function columnsOf(item: { properties: Record<string, unknown> }): unknown {
  return item.properties.columns;
}

function errorFields(res: ApiResponse<unknown>): string[] {
  const details = res.error?.error.details as
    { errors?: { field: string }[] } | undefined;
  return (details?.errors ?? []).map((e) => e.field).sort();
}

const EVERY_KIND: Columns = {
  name: { type: "string", required: true, maxLength: 80, searchable: true },
  mail: { type: "email", searchable: true },
  site: { type: "url" },
  state: { type: "enum", enum_values: ["open", "done"] },
  paid: { type: "boolean", adds_up: "count" },
  qty: { type: "integer", minimum: 0, maximum: 99, adds_up: "sum" },
  cost: { type: "number", adds_up: "average", label: "Cost (GBP)" },
  due: { type: "date", adds_up: "min" },
  seen: { type: "datetime", adds_up: "max", description: "Last seen." },
  parent: { type: "item", type_constraints: ["core.table", "core.note"] },
};

describe("a table a person keeps", () => {
  it("ships core.table with its columns as a required object and declares no table", async () => {
    const read = await client.getType("core.table");
    expect(read.status).toBe(200);
    expect(read.data.fields?.columns?.type).toBe("object");
    expect(read.data.fields?.title?.type).toBe("string");
    expect(read.data.fields?.description?.type).toBe("string");
    expect(read.data.fields?.columns?.required).toBe(true);
    expect(read.data.fields?.title?.required).toBe(true);
    expect(read.data.fields?.description?.required).not.toBe(true);
    expect(read.data).not.toHaveProperty("tables");
  });

  it("takes the columns a declared table takes, on a create, an update and a subtype", async () => {
    const id = await made(EVERY_KIND);
    const read = await client.getItem(id);
    expect(columnsOf(read.data.item)).toEqual(EVERY_KIND);
    expect(Object.keys(columnsOf(read.data.item) as Columns)).toEqual(
      Object.keys(EVERY_KIND),
    );

    const changed = {
      ...EVERY_KIND,
      extra: { type: "string", description: "Anything else." },
    };
    const updated = await change(client, id, {
      properties: { columns: changed },
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect(columnsOf(updated.data.item)).toEqual(changed);

    const child = `user.own-columns-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: child,
          parent: "core.table",
          fields: { owner: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    trackType(ctx, child);
    await made(EVERY_KIND, child);
  });

  it("takes 64 columns and refuses a 65th", async () => {
    const wide = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`c${i}`, { type: "string" }]),
      );
    await made(wide(64));
    const over = await create(wide(65));
    expect(over.status).toBe(400);
    expect(over.error?.error.code).toBe("invalid_properties");
    expect(errorFields(over)).toEqual(["columns"]);
  });

  const REFUSED: [string, Columns, string[]][] = [
    [
      "a column kind that does not exist",
      { a: { type: "money" } },
      ["columns.a.type"],
    ],
    ["a list column", { a: { type: "array" } }, ["columns.a.type"]],
    ["a column with no kind", { a: {} }, ["columns.a.type"]],
    ["a column that is not an object", { a: "string" }, ["columns.a"]],
    [
      "an unread key",
      { a: { type: "number", addsUp: "sum" } },
      ["columns.a.addsUp"],
    ],
    [
      "a column name that breaks the grammar",
      { Bad: { type: "string" } },
      ["columns.Bad"],
    ],
    [
      "a column name that starts with a digit",
      { "1a": { type: "string" } },
      ["columns.1a"],
    ],
    [
      "an enum with no words",
      { a: { type: "enum" } },
      ["columns.a.enum_values"],
    ],
    [
      "a minimum above a maximum",
      { a: { type: "integer", minimum: 5, maximum: 1 } },
      ["columns.a.minimum"],
    ],
    [
      "a required that is not a boolean",
      { a: { type: "string", required: "yes" } },
      ["columns.a.required"],
    ],
    [
      "an adds_up that is not a way to add up",
      { a: { type: "number", adds_up: "median" } },
      ["columns.a.adds_up"],
    ],
    [
      "a sum of text",
      { a: { type: "string", adds_up: "sum" } },
      ["columns.a.adds_up"],
    ],
    [
      "searchable on a number",
      { a: { type: "number", searchable: true } },
      ["columns.a.searchable"],
    ],
    [
      "an item column naming a type nothing registers",
      { a: { type: "item", type_constraints: ["user.absent-type"] } },
      ["columns.a.type_constraints"],
    ],
    [
      "an item column naming no type",
      { a: { type: "item", type_constraints: [] } },
      ["columns.a.type_constraints"],
    ],
    [
      "type_constraints on a column that is not an item",
      { a: { type: "string", type_constraints: ["core.note"] } },
      ["columns.a.type_constraints"],
    ],
    [
      "a value rule on an item column",
      { a: { type: "item", maxLength: 5 } },
      ["columns.a.maxLength"],
    ],
    [
      "two faults in two columns",
      { a: { type: "money" }, b: { type: "number", adds_up: "median" } },
      ["columns.a.type", "columns.b.adds_up"],
    ],
  ];

  it("refuses the columns a declared table would refuse, naming each fault under columns", async () => {
    const count = async () =>
      (await client.listItems({ type: "core.table", source: ctx.source })).data
        .data.length;
    const held = await count();
    for (const [what, columns, fields] of REFUSED) {
      const res = await create(columns);
      expect(res.status, `${what}: ${JSON.stringify(res.data)}`).toBe(400);
      expect(res.error?.error.code, what).toBe("invalid_properties");
      expect(errorFields(res), what).toEqual(fields);
    }

    expect(await count(), "a refused create left an item").toBe(held);

    const id = await made({ a: { type: "string" } });
    const before = (await client.getItem(id)).data.item;
    for (const [what, columns, fields] of REFUSED) {
      const res = await change(client, id, { properties: { columns } });
      expect(res.status, `${what}: ${JSON.stringify(res.data)}`).toBe(400);
      expect(res.error?.error.code, what).toBe("invalid_properties");
      expect(errorFields(res), what).toEqual(fields);
    }
    const after = (await client.getItem(id)).data.item;
    expect(after.properties).toEqual(before.properties);
    expect(after.version).toBe(before.version);

    expect(await count()).toBe(held + 1);
  });

  it("refuses columns that are missing, cleared, empty, null or not an object", async () => {
    const missing = await client.createItem({
      type: "core.table",
      source: ctx.source,
      properties: { title: "No columns" },
    });
    expect(missing.status).toBe(400);
    expect(missing.error?.error.code).toBe("invalid_properties");
    expect(errorFields(missing)).toEqual(["columns"]);

    for (const columns of [{}, null, [], "text", 5]) {
      const res = await create(columns);
      expect(res.status, JSON.stringify(columns)).toBe(400);
      expect(res.error?.error.code).toBe("invalid_properties");
      expect(errorFields(res)).toEqual(["columns"]);
    }

    const id = await made({ a: { type: "string" } });
    const cleared = await change(client, id, {
      clear_properties: ["columns"],
    });
    expect(cleared.status).toBe(400);
    expect(cleared.error?.error.code).toBe("invalid_properties");
    expect(errorFields(cleared)).toEqual(["columns"]);
    for (const columns of [{}, null, "text"]) {
      const res = await change(client, id, { properties: { columns } });
      expect(res.status, JSON.stringify(columns)).toBe(400);
      expect(errorFields(res)).toEqual(["columns"]);
    }
    expect(columnsOf((await client.getItem(id)).data.item)).toEqual({
      a: { type: "string" },
    });
  });

  it("refuses a retype into core.table whose columns are refused", async () => {
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "A note" },
    });
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);
    const res = await change(client, note.data.item.id, {
      type: "core.table",
      retype: true,
      properties: { title: "A table", columns: { a: { type: "money" } } },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(400);
    expect(res.error?.error.code).toBe("invalid_properties");
    expect(errorFields(res)).toEqual(["columns.a.type"]);
    expect((await client.getItem(note.data.item.id)).data.item.type).toBe(
      "core.note",
    );
  });
});

let keys = 0;

describe("a key changes a table's columns", () => {
  async function writer(grants: string[] = [], types: string[] = []) {
    const made = await client.createKey({
      label: "own-columns-key",
      source: `${ctx.source}-own-columns-${(keys += 1)}`,
      permissions: grants,
      type_permissions: Object.fromEntries(
        ["core.table", ...types].map((type) => [type, "write"]),
      ),
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackKey(ctx, made.data.id);
    return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
  }

  const HELD: Columns = {
    a: { type: "string" },
    b: { type: "string" },
    c: { type: "number" },
  };

  it("lands an added optional column, new labels and a new order for a key without schema.write", async () => {
    const id = await made(HELD);
    const key = await writer();
    const next = {
      c: { type: "number", label: "See", description: "A count." },
      added: { type: "date", adds_up: "max" },
      a: { type: "string", label: "A" },
      b: { type: "string" },
    };
    const res = await change(key, id, { properties: { columns: next } });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const read = (await client.getItem(id)).data.item;
    expect(columnsOf(read)).toEqual(next);
    expect(Object.keys(columnsOf(read) as Columns)).toEqual(Object.keys(next));
  });

  it("refuses a removed column, a changed kind and a required column to a key without schema.write, listing each and changing nothing", async () => {
    const id = await made(HELD);
    const key = await writer();
    const tryChange = async (columns: Columns, changes: string[]) => {
      const res = await change(key, id, { properties: { columns } });
      expect(res.status, JSON.stringify(res.data)).toBe(403);
      expect(res.error?.error.code).toBe("forbidden");
      const details = res.error?.error.details as {
        required_scope: string;
        changes: string[];
      };
      expect(details.required_scope).toBe("schema.write");
      expect(details.changes).toEqual(changes);
    };
    await tryChange({ a: HELD.a, c: HELD.c }, ["columns.b"]);
    await tryChange({ ...HELD, c: { type: "string" } }, ["columns.c"]);
    await tryChange({ ...HELD, c: { type: "number", maximum: 5 } }, [
      "columns.c",
    ]);
    await tryChange({ ...HELD, a: { type: "string", required: true } }, [
      "columns.a",
    ]);
    await tryChange({ ...HELD, d: { type: "string", required: true } }, [
      "columns.d",
    ]);
    await tryChange(
      {
        a: { type: "number" },
        c: HELD.c,
        d: { type: "string", required: true },
      },
      ["columns.a", "columns.b", "columns.d"],
    );
    expect(columnsOf((await client.getItem(id)).data.item)).toEqual(HELD);
  });

  it("lands a removed column, a changed kind and a required column for a key holding schema.write", async () => {
    const id = await made(HELD);
    const key = await writer(["schema.write"]);
    const next = {
      a: { type: "number", required: true },
      d: { type: "string", required: true },
    };
    const res = await change(key, id, { properties: { columns: next } });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(columnsOf((await client.getItem(id)).data.item)).toEqual(next);
  });

  async function declaring(name: string, columns: Columns) {
    const id = `user.own-retype-${name}-${ctx.runId}`;
    const res = await client.registerType({
      id,
      fields: { title: { type: "string" } },
      tables: { table: { columns } },
    });
    expect(res.status, JSON.stringify(res.error)).toBe(201);
    trackType(ctx, id);
    return id;
  }

  function refusedFor(res: ApiResponse<unknown>, changes: string[]) {
    expect(res.status, JSON.stringify(res.data)).toBe(403);
    expect(res.error?.error.code).toBe("forbidden");
    const details = res.error?.error.details as {
      required_scope: string;
      changes: string[];
    };
    expect(details.required_scope).toBe("schema.write");
    expect(details.changes).toEqual(changes);
  }

  it("refuses a retype that reshapes a table the item has before and after to a key without schema.write, listing each and changing nothing", async () => {
    const reshaped = await declaring("reshaped", {
      a: { type: "number" },
      b: { type: "string" },
    });
    const alike = await declaring("alike", { a: { type: "string" } });
    const key = await writer([], [reshaped, alike]);
    const id = await made({ a: { type: "string" } });

    refusedFor(
      await change(key, id, { type: reshaped, retype: true, properties: {} }),
      ["tables.table.columns.a"],
    );
    expect((await client.getItem(id)).data.item.type).toBe("core.table");

    const moved = await change(key, id, {
      type: alike,
      retype: true,
      properties: {},
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    const emptied = await change(key, id, { clear_properties: ["columns"] });
    expect(emptied.status, JSON.stringify(emptied.error)).toBe(200);
    expect(emptied.data.item.properties).not.toHaveProperty("columns");

    refusedFor(
      await change(key, id, {
        type: "core.table",
        retype: true,
        properties: { columns: { a: { type: "number" } } },
      }),
      ["columns.a"],
    );
    const held = (await client.getItem(id)).data.item;
    expect(held.type).toBe(alike);
    expect(held.properties).not.toHaveProperty("columns");

    const back = await change(key, id, {
      type: "core.table",
      retype: true,
      properties: { columns: { a: { type: "string" }, n: { type: "date" } } },
    });
    expect(back.status, JSON.stringify(back.error)).toBe(200);
  });

  it("lands a retype that reshapes a table the item has before and after for a key holding schema.write", async () => {
    const reshaped = await declaring("forced", { a: { type: "number" } });
    const key = await writer(["schema.write"], [reshaped]);
    const id = await made({ a: { type: "string" } });
    const res = await change(key, id, {
      type: reshaped,
      retype: true,
      properties: {},
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.item.type).toBe(reshaped);
  });
});
