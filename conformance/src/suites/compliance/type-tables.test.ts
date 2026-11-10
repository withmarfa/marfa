import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse, TestContext } from "../../client/types.js";
import { archiveLines, editLineFile } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import {
  callTool,
  connectMcp,
  toolError,
  toolResult,
} from "../../utils/mcp.js";
import { createTestContext, trackKey, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "type-tables",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Definition = Record<string, unknown>;
type Tables = Record<string, unknown>;

let counter = 0;
function typeId(label: string): string {
  counter += 1;
  return `user.tables-${label}-${counter}-${ctx.runId}`;
}

function declared(id: string, tables: Tables, extra: Definition = {}) {
  return {
    id,
    fields: { title: { type: "string" } },
    tables,
    ...extra,
  } as never;
}

const LINES = {
  lines: {
    label: "Lines",
    description: "What was spent.",
    columns: {
      amount: { type: "number", adds_up: "sum" },
      memo: { type: "string", searchable: true },
      seen: { type: "date", adds_up: "max" },
    },
  },
};

function errorFields(res: ApiResponse<unknown>): string[] {
  const details = res.error?.error.details as
    { errors?: { field: string }[] } | undefined;
  return (details?.errors ?? []).map((e) => e.field);
}

async function refused(
  tables: Tables,
  expected: string[],
  status = 400,
  code = "invalid_schema",
): Promise<ApiResponse<unknown>> {
  const id = typeId("refused");
  const res = await client.registerType(declared(id, tables));
  expect(res.status, JSON.stringify(res.data)).toBe(status);
  expect(res.error?.error.code).toBe(code);
  expect(errorFields(res)).toEqual(expected);
  expect((await client.getType(id)).status).toBe(404);
  return res;
}

describe("a type declares tables", () => {
  it("answers the tables a type declares on a read and a listing", async () => {
    const id = typeId("read");
    const made = await client.registerType(declared(id, LINES));
    expect(made.status, JSON.stringify(made.error)).toBe(201);

    const read = await client.getType(id);
    expect(read.data.tables?.lines.label).toBe("Lines");
    expect(read.data.tables?.lines.columns.amount).toMatchObject({
      type: "number",
      adds_up: "sum",
    });

    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === id,
    );
    expect(listed?.tables?.lines.columns.memo).toEqual({
      type: "string",
      searchable: true,
    });
  });

  it("answers no tables for a type that declares none", async () => {
    const id = typeId("none");
    expect(
      (await client.registerType({ id, fields: { title: { type: "string" } } }))
        .ok,
    ).toBe(true);
    expect((await client.getType(id)).data).not.toHaveProperty("tables");
    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === id,
    );
    expect(listed).not.toHaveProperty("tables");
  });

  const LABELLED = {
    line_items: {
      columns: {
        due_at: { type: "date" },
        named: { type: "string", label: "Called" },
      },
    },
  };

  it("answers a label made from its name for a table and a column that declare none on a read", async () => {
    const id = typeId("labels-read");
    const made = await client.registerType(declared(id, LABELLED));
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const read = (await client.getType(id)).data.tables?.line_items;
    expect(read?.label).toBe("Line Items");
    expect(read?.columns.due_at.label).toBe("Due At");
    expect(read?.columns.named.label).toBe("Called");
  });

  it("answers only the declared label for a table and a column in the listing", async () => {
    const id = typeId("labels-listed");
    const made = await client.registerType(declared(id, LABELLED));
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const listed = (await client.listTypes()).data.data.find((t) => t.id === id)
      ?.tables?.line_items;
    expect(listed).not.toHaveProperty("label");
    expect(listed?.columns.due_at).not.toHaveProperty("label");
    expect(listed?.columns.named.label).toBe("Called");
  });

  it("writes a column's defaults down when a type is normalized", async () => {
    const id = typeId("normalized");
    const res = await normalize(declared(id, LINES));
    const columns = res.type.tables.lines.columns;
    expect(columns.amount).toMatchObject({
      required: false,
      searchable: false,
    });
    expect(columns.memo).toMatchObject({ required: false, searchable: true });
  });
});

async function normalize(body: object) {
  const res = await client.rawRequest<{
    type: { tables: Record<string, { columns: Record<string, unknown> }> };
  }>("/types/normalize", { method: "POST", body });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data;
}

describe("a table the server refuses", () => {
  it("refuses an unread key in a table and in a column, naming the key meant", async () => {
    const res = await refused(
      {
        lines: {
          Label: "Lines",
          columns: { amount: { type: "number", addsUp: "sum" } },
        },
      },
      ["tables.lines.Label", "tables.lines.columns.amount.addsUp"],
    );
    const hints = (
      res.error?.error.details as { errors: { hint: string }[] }
    ).errors.map((e) => e.hint);
    expect(hints[0]).toContain('"label"');
    expect(hints[1]).toContain('"adds_up"');
  });

  it("refuses a table or a column whose name is not a lowercase letter then lowercase letters, digits and underscores", async () => {
    await refused({ Lines: { columns: { a: { type: "string" } } } }, [
      "tables.Lines",
    ]);
    await refused({ lines: { columns: { "Due At": { type: "string" } } } }, [
      "tables.lines.columns.Due At",
    ]);
    await refused(
      {
        lines: { columns: { a_1: { type: "string" } } },
        "9x": { columns: { a: { type: "string" } } },
      },
      ["tables.9x"],
    );
  });

  it("refuses a column of a kind that does not exist or that nests", async () => {
    await refused(
      {
        lines: {
          columns: {
            a: { type: "decimal" },
            b: { type: "array" },
            c: { type: "object" },
            d: { type: "status" },
            e: {},
            f: { type: "string", format: "thumbnail" },
          },
        },
      },
      ["a", "b", "c", "d", "e", "f"].map(
        (c) => `tables.lines.columns.${c}.type`,
      ),
    );
  });

  it("refuses a table with no columns", async () => {
    await refused({ lines: { columns: {} } }, ["tables.lines.columns"]);
    await refused({ lines: { label: "Lines" } }, ["tables.lines.columns"]);
  });

  it("refuses a column that breaks a rule a field of its kind keeps", async () => {
    await refused(
      {
        lines: {
          columns: {
            kind: { type: "enum" },
            count: { type: "integer", minimum: 5, maximum: 1 },
            name: { type: "boolean", maxLength: 3 },
            need: { type: "string", required: "yes" },
          },
        },
      },
      [
        "tables.lines.columns.kind.enum_values",
        "tables.lines.columns.count.minimum",
        "tables.lines.columns.name.maxLength",
        "tables.lines.columns.need.required",
      ],
    );
  });

  it("refuses an adds_up that is not sum, average, min, max or count, or that the kind of its column cannot take", async () => {
    await refused(
      {
        lines: {
          columns: {
            a: { type: "string", adds_up: "sum" },
            b: { type: "date", adds_up: "average" },
            c: { type: "boolean", adds_up: "max" },
            d: { type: "number", adds_up: "total" },
            e: { type: "number", adds_up: 3 },
            f: { type: "item", adds_up: "min" },
          },
        },
      },
      ["a", "b", "c", "d", "e", "f"].map(
        (c) => `tables.lines.columns.${c}.adds_up`,
      ),
    );
  });

  it("takes the adds_up each kind of column can", async () => {
    const id = typeId("adds-up");
    const made = await client.registerType(
      declared(id, {
        lines: {
          columns: {
            n: { type: "number", adds_up: "average" },
            i: { type: "integer", adds_up: "sum" },
            d: { type: "date", adds_up: "min" },
            t: { type: "datetime", adds_up: "max" },
            s: { type: "string", adds_up: "count" },
            b: { type: "boolean", adds_up: "count" },
            r: { type: "item", adds_up: "count" },
          },
        },
      }),
    );
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const columns = (await client.getType(id)).data.tables?.lines.columns;
    expect(columns?.t.adds_up).toBe("max");
    expect(columns?.r.adds_up).toBe("count");
  });

  it("refuses searchable on a column that holds no text, and takes it on one that does", async () => {
    await refused(
      {
        lines: {
          columns: {
            n: { type: "number", searchable: true },
            r: { type: "item", searchable: true },
            w: { type: "string", searchable: "yes" },
          },
        },
      },
      ["n", "r", "w"].map((c) => `tables.lines.columns.${c}.searchable`),
    );
    const id = typeId("searchable");
    const made = await client.registerType(
      declared(id, {
        lines: {
          columns: {
            s: { type: "string", searchable: true },
            e: { type: "email", searchable: true },
            u: { type: "url", searchable: true },
          },
        },
      }),
    );
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
  });

  it("refuses an item column that names a type nothing registers, one that is not a type identifier and an empty list, and takes its own type", async () => {
    await refused(
      {
        lines: {
          columns: {
            a: { type: "item", type_constraints: ["user.nothing-registers"] },
            b: { type: "item", type_constraints: ["Not A Type"] },
            c: { type: "item", type_constraints: [] },
            d: { type: "item", type_constraints: "core.note" },
          },
        },
      },
      ["a", "b", "c", "d"].map(
        (c) => `tables.lines.columns.${c}.type_constraints`,
      ),
    );
    const id = typeId("own");
    const made = await client.registerType(
      declared(id, {
        lines: {
          columns: {
            mine: { type: "item", type_constraints: [id] },
            note: {
              type: "item",
              type_constraints: ["core.note", "core.file"],
            },
            any: { type: "item" },
          },
        },
      }),
    );
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const columns = (await client.getType(id)).data.tables?.lines.columns;
    expect(columns?.note.type_constraints).toEqual(["core.note", "core.file"]);
    expect(columns?.any).toEqual(expect.objectContaining({ type: "item" }));
  });

  it("refuses type_constraints on a column that is not an item, and a value rule on an item column", async () => {
    await refused(
      {
        lines: {
          columns: {
            a: { type: "string", type_constraints: ["core.note"] },
            b: { type: "item", maxLength: 3 },
            c: { type: "item", enum_values: ["x"] },
            d: { type: "item", format: "url" },
          },
        },
      },
      [
        "tables.lines.columns.a.type_constraints",
        "tables.lines.columns.b.maxLength",
        "tables.lines.columns.c.enum_values",
        "tables.lines.columns.d.format",
      ],
    );
  });

  it("takes 32 tables and a table of 64 columns, and refuses a 33rd table and a 65th column", async () => {
    const column = { type: "string" };
    const at = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `t${i}`,
          { columns: { a: column } },
        ]),
      );
    const wide = (n: number) => ({
      lines: {
        columns: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`c${i}`, column]),
        ),
      },
    });
    await refused(at(33), ["tables"]);
    await refused(wide(65), ["tables.lines.columns"]);
    const id = typeId("bounds");
    const made = await client.registerType(declared(id, at(32)));
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const full = typeId("bounds-wide");
    const wideOne = await client.registerType(declared(full, wide(64)));
    expect(wideOne.ok, JSON.stringify(wideOne.error)).toBe(true);
    const read = await client.getType(id);
    expect(Object.keys(read.data.tables ?? {})).toHaveLength(32);
  });
});

describe("tables down a chain of types", () => {
  const extra = { extra: { columns: { n: { type: "integer" } } } };

  it("answers a subtype the tables of its parents and its own", async () => {
    const parent = typeId("parent");
    expect((await client.registerType(declared(parent, LINES))).ok).toBe(true);
    const child = `${parent}.child`;
    const made = await client.registerType(declared(child, extra, { parent }));
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const read = await client.getType(child);
    expect(Object.keys(read.data.tables ?? {}).sort()).toEqual([
      "extra",
      "lines",
    ]);
    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === child,
    );
    expect(Object.keys(listed?.tables ?? {})).toEqual(["extra"]);
  });

  it("refuses a subtype that declares a table of its parents differently", async () => {
    const parent = typeId("redeclare");
    expect((await client.registerType(declared(parent, LINES))).ok).toBe(true);
    const child = `${parent}.child`;
    const res = await client.registerType(
      declared(
        child,
        { lines: { columns: { other: { type: "string" } } } },
        { parent },
      ),
    );
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("inheritance_violation");
    expect(errorFields(res)).toEqual(["tables.lines"]);
    expect((await client.getType(child)).status).toBe(404);
  });

  it("stores no table again that a subtype restates exactly as a read of its parent gives it", async () => {
    const parent = typeId("restate");
    expect((await client.registerType(declared(parent, LINES))).ok).toBe(true);
    const asRead = (await client.getType(parent)).data.tables;
    const child = `${parent}.child`;
    const made = await client.registerType(
      declared(child, asRead as Tables, { parent }),
    );
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === child,
    );
    expect(listed).not.toHaveProperty("tables");
    expect(
      Object.keys((await client.getType(child)).data.tables ?? {}),
    ).toEqual(["lines"]);
  });

  it("refuses a parent that gains a table a subtype declares", async () => {
    const parent = typeId("later");
    expect(
      (
        await client.registerType({
          id: parent,
          fields: { title: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
    const child = `${parent}.child`;
    expect(
      (await client.registerType(declared(child, extra, { parent }))).ok,
    ).toBe(true);
    for (const gained of [
      { extra: { columns: { other: { type: "string" } } } },
      extra,
    ]) {
      const res = await client.replaceType(
        parent,
        declared(parent, gained, {}),
      );
      expect(res.status, JSON.stringify(gained)).toBe(400);
      expect(res.error?.error.code).toBe("inheritance_violation");
      expect(errorFields(res)).toEqual(["tables.extra"]);
    }
    expect((await client.getType(parent)).data).not.toHaveProperty("tables");
  });

  async function chainOfThree(leafTables: Tables) {
    const top = typeId("top");
    expect((await client.registerType(declared(top, LINES))).ok).toBe(true);
    const middle = typeId("middle");
    expect(
      (
        await client.registerType({
          id: middle,
          label: "Middle",
          fields: { title: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
    const leaf = `${middle}.leaf`;
    const made = await client.registerType(
      declared(leaf, leafTables, { parent: middle }),
    );
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const attached = {
      id: middle,
      parent: top,
      label: "Attached",
      fields: { title: { type: "string" } },
    } as never;
    return { top, middle, leaf, attached };
  }

  it("refuses a replacement that gives a type a parent above which a subtype declares a table of the parent's", async () => {
    const differently = await chainOfThree({
      lines: { columns: { other: { type: "string" } } },
    });
    const res = await client.replaceType(
      differently.middle,
      differently.attached,
    );
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("inheritance_violation");
    expect(errorFields(res)).toEqual(["parent"]);

    const asRead = (await client.getType(differently.top)).data.tables;
    const alike = await chainOfThree(asRead as Tables);
    const same = await client.replaceType(alike.middle, alike.attached);
    expect(same.status, JSON.stringify(same.data)).toBe(400);
    expect(same.error?.error.code).toBe("inheritance_violation");
    expect(errorFields(same)).toEqual(["parent"]);

    const agreeing = await client.replaceType(
      differently.leaf,
      declared(differently.leaf, extra, { parent: differently.middle }),
    );
    expect(agreeing.status, JSON.stringify(agreeing.error)).toBe(200);
    const taken = await client.replaceType(
      differently.middle,
      differently.attached,
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("changes nothing when it refuses a replacement for the parent it would give a type", async () => {
    const { middle, attached } = await chainOfThree({
      lines: { columns: { other: { type: "string" } } },
    });
    const res = await client.replaceType(middle, attached);
    expect(res.status).toBe(400);
    const held = (await client.getType(middle)).data;
    expect(held).not.toHaveProperty("parent");
    expect(held.label, "a refused replacement changed the type").toBe("Middle");
  });
});

describe("a key evolves a type's tables", () => {
  async function connector(id: string, grants: string[] = []) {
    const made = await client.createKey({
      label: "type-tables-key",
      source: `${ctx.source}-tables-${counter}`,
      permissions: grants,
      metadata_permissions: { types: "write" },
      type_permissions: { [id]: "write" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackKey(ctx, made.data.id);
    return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
  }

  const base = (id: string, tables: Tables | undefined) => ({
    id,
    fields: { title: { type: "string" } },
    ...(tables ? { tables } : {}),
  });

  it("lands a table, an optional column and new labels for a key holding metadata.types:write alone", async () => {
    const id = typeId("free");
    expect(
      (
        await client.registerType(
          declared(id, { lines: { columns: { a: { type: "string" } } } }),
        )
      ).ok,
    ).toBe(true);
    const key = await connector(id);
    const next = {
      lines: {
        label: "Lines",
        description: "Spending.",
        columns: {
          a: { type: "string", label: "A", description: "The first." },
          b: { type: "number", adds_up: "sum" },
        },
      },
      audit: { columns: { at: { type: "datetime", required: true } } },
    };
    const res = await key.replaceType(id, base(id, next));
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const read = (await client.getType(id)).data.tables;
    expect(Object.keys(read ?? {}).sort()).toEqual(["audit", "lines"]);
    expect(read?.lines.columns.b.adds_up).toBe("sum");
  });

  it("refuses a column's changed kind, a required column, a removed column and a removed table to a key without schema.write, listing each", async () => {
    const id = typeId("schema");
    const held = {
      lines: { columns: { a: { type: "string" }, b: { type: "string" } } },
      other: { columns: { z: { type: "string" } } },
    };
    expect((await client.registerType(declared(id, held))).ok).toBe(true);
    const key = await connector(id);
    const tryChange = async (tables: Tables | undefined, changes: string[]) => {
      const res = await key.replaceType(id, base(id, tables));
      expect(res.status, JSON.stringify(res.data)).toBe(403);
      expect(res.error?.error.code).toBe("forbidden");
      const details = res.error?.error.details as {
        required_scope: string;
        changes: string[];
      };
      expect(details.required_scope).toBe("schema.write");
      expect(details.changes).toEqual(changes);
    };
    await tryChange(
      {
        ...held,
        lines: { columns: { a: { type: "number" }, b: { type: "string" } } },
      },
      ["tables.lines.columns.a"],
    );
    await tryChange(
      {
        ...held,
        lines: {
          columns: {
            a: { type: "string", required: true },
            b: { type: "string" },
            c: { type: "string", required: true },
          },
        },
      },
      ["tables.lines.columns.a", "tables.lines.columns.c"],
    );
    await tryChange(
      { ...held, lines: { columns: { a: { type: "string" } } } },
      ["tables.lines.columns.b"],
    );
    await tryChange({ lines: held.lines }, ["tables.other"]);
    await tryChange(undefined, ["tables.lines", "tables.other"]);
    expect(
      Object.keys((await client.getType(id)).data.tables ?? {}).sort(),
    ).toEqual(["lines", "other"]);
  });

  it("lands every change for a key holding schema.write, and a replacement without tables removes them", async () => {
    const id = typeId("writer");
    const held = {
      lines: { columns: { a: { type: "string" }, b: { type: "string" } } },
    };
    expect((await client.registerType(declared(id, held))).ok).toBe(true);
    const key = await connector(id, ["schema.write"]);
    const changed = await key.replaceType(
      id,
      base(id, {
        lines: { columns: { a: { type: "number", required: true } } },
      }),
    );
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    expect((await client.getType(id)).data.tables?.lines.columns.a.type).toBe(
      "number",
    );
    const removed = await key.replaceType(id, base(id, undefined));
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect((await client.getType(id)).data).not.toHaveProperty("tables");
  });
});

describe("tables reach the other doors", () => {
  async function withSchemaTool(
    label: string,
    run: (
      schema: Awaited<ReturnType<typeof connectMcp>>,
      owner: MarfaClient,
    ) => Promise<void>,
  ) {
    const made = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      permissions: ["schema.write"],
      metadata_permissions: { types: "write" },
      type_permissions: { "user.*": "write" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackKey(ctx, made.data.id);
    const owner = new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
    const schema = await connectMcp(
      apiUrl,
      made.data.key,
      "2026-07-28",
      "/mcp/schema",
    );
    try {
      await run(schema, owner);
    } finally {
      await schema.close();
    }
  }

  it("registers a type with tables through marfa_save_type, and refuses a table the server refuses", async () => {
    await withSchemaTool("type-tables-mcp-register", async (schema, owner) => {
      const id = typeId("mcp");
      const registered = toolResult(
        await callTool(schema, "marfa_save_type", {
          action: "register",
          id,
          fields: { title: { type: "string" } },
          tables: {
            lines: { columns: { amount: { type: "number", adds_up: "sum" } } },
          },
        }),
      );
      expect((registered.type as { tables: Tables }).tables).toMatchObject({
        lines: { columns: { amount: { adds_up: "sum" } } },
      });
      const own = await owner.getType(id);
      expect(own.data.tables?.lines.columns.amount.type).toBe("number");
      ctx.trackedTypes.push({ id, createdBy: owner });

      const refusedAnswer = await callTool(schema, "marfa_save_type", {
        action: "register",
        id: typeId("mcp-refused"),
        fields: { title: { type: "string" } },
        tables: {
          lines: { columns: { a: { type: "string", adds_up: "sum" } } },
        },
      });
      expect(toolError(refusedAnswer).code).toBe("invalid_schema");
    });
  });

  it("changes a type's tables through marfa_save_type, replacing a table by name, removing one with null and leaving the rest", async () => {
    await withSchemaTool("type-tables-mcp-change", async (schema, owner) => {
      const id = typeId("mcp-change");
      const registered = await owner.registerType(
        declared(id, {
          lines: { columns: { amount: { type: "number", adds_up: "sum" } } },
        }),
      );
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
      ctx.trackedTypes.push({ id, createdBy: owner });

      const changed = toolResult(
        await callTool(schema, "marfa_save_type", {
          action: "change",
          id,
          tables: {
            notes: { columns: { text: { type: "string" } } },
            lines: { columns: { amount: { type: "integer" } } },
          },
        }),
      );
      const tables = (
        changed.type as {
          tables: Record<string, { columns: Record<string, unknown> }>;
        }
      ).tables;
      expect(tables.lines.columns.amount).toEqual({ type: "integer" });
      expect(tables.notes).toBeDefined();

      const kept = toolResult(
        await callTool(schema, "marfa_save_type", {
          action: "change",
          id,
          label: "Ledger",
        }),
      );
      expect(
        Object.keys((kept.type as { tables: Tables }).tables),
      ).toHaveLength(2);

      const removed = toolResult(
        await callTool(schema, "marfa_save_type", {
          action: "change",
          id,
          tables: { lines: null, notes: null },
        }),
      );
      expect(removed.type).not.toHaveProperty("tables");
    });
  });

  it(
    "carries a type's tables in an archive and registers them when the archive is restored",
    async () => {
      const source = await bootFreshServer("tables-source");
      const destination = await bootFreshServer("tables-destination");
      try {
        const origin = new MarfaClient({
          baseUrl: source.apiUrl,
          apiKey: source.workingKey,
        });
        const parent = "user.tables_archived";
        const child = "user.tables_archived_sub";
        expect((await origin.registerType(declared(parent, LINES))).ok).toBe(
          true,
        );
        expect(
          (
            await origin.registerType(
              declared(
                child,
                { extra: { columns: { n: { type: "integer" } } } },
                { parent },
              ),
            )
          ).ok,
        ).toBe(true);
        const exported = await origin.exportArchive({});
        expect(exported.status).toBe(200);
        const lines = archiveLines<{
          type?: { id: string; tables?: Tables };
        }>(exported.data, "instance");
        const carried = lines.find((l) => l.type?.id === parent)?.type;
        expect(carried?.tables).toMatchObject({
          lines: { columns: { amount: { type: "number", adds_up: "sum" } } },
        });
        const inherited = lines.find((l) => l.type?.id === child)?.type;
        expect(Object.keys(inherited?.tables ?? {})).toEqual(["extra"]);

        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          controlSocket: destination.controlSocket,
        });
        const restored = await owner.restoreArchive(exported.data);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        const read = await worker.getType(child);
        expect(Object.keys(read.data.tables ?? {}).sort()).toEqual([
          "extra",
          "lines",
        ]);
        expect(read.data.tables?.lines.columns.seen.adds_up).toBe("max");
      } finally {
        await source.stop();
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each([false, true])(
    "restores a subtype whose type line restates a table of its parent (reversed: %s)",
    async (reversed) => {
      const source = await bootFreshServer("tables-restated-source");
      const destination = await bootFreshServer("tables-restated-destination");
      try {
        const origin = new MarfaClient({
          baseUrl: source.apiUrl,
          apiKey: source.workingKey,
        });
        const parent = "user.tables_restated";
        const child = "user.tables_restated_sub";
        const memo = { lines: { columns: { memo: { type: "string" } } } };
        for (const definition of [
          declared(parent, memo),
          declared(child, memo, { parent }),
        ]) {
          const made = await origin.registerType(definition);
          expect(made.status, JSON.stringify(made.error)).toBe(201);
        }
        const exported = await origin.exportArchive({});
        expect(exported.status).toBe(200);
        const restating = editLineFile(exported.data, "instance", (text) => {
          const lines = text
            .trim()
            .split("\n")
            .map((line) => {
              const row = JSON.parse(line) as { type?: Definition };
              if (row.type?.id !== child) return line;
              return JSON.stringify({
                ...row,
                type: { ...row.type, tables: memo },
              });
            });
          return (reversed ? lines.reverse() : lines).join("\n") + "\n";
        });
        const carried = archiveLines<{
          type?: { id: string; tables?: Tables };
        }>(restating, "instance").find((l) => l.type?.id === child)?.type;
        expect(carried?.tables).toEqual(memo);

        const owner = new MarfaClient({
          baseUrl: destination.apiUrl,
          controlSocket: destination.controlSocket,
        });
        const restored = await owner.restoreArchive(restating);
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data).toMatchObject({ types_registered: 2 });
        const worker = new MarfaClient({
          baseUrl: destination.apiUrl,
          apiKey: destination.workingKey,
        });
        expect(
          Object.keys((await worker.getType(child)).data.tables ?? {}),
        ).toEqual(["lines"]);
        const listed = (await worker.listTypes()).data.data.find(
          (t) => t.id === child,
        );
        expect(listed).not.toHaveProperty("tables");
      } finally {
        await source.stop();
        await destination.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
