import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackView,
  trackEdgeType,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "status-groups"));
});

afterAll(async () => {
  await cleanup(ctx);
});

const WORDS = [
  { value: "todo", group: "not_started" },
  { value: "doing", group: "in_progress" },
  { value: "done", group: "completed" },
  { value: "dropped", group: "canceled" },
] as const;

let serial = 0;
function nextId(): string {
  serial += 1;
  return `user.status-${ctx.runId}-${String(serial)}`;
}

function errorFields(response: {
  error?: { error: { details?: unknown } };
}): string[] {
  const details = response.error?.error.details as
    { errors?: { field: string }[] } | undefined;
  return details?.errors?.map((e) => e.field) ?? [];
}

async function register(schema: Record<string, unknown>): Promise<void> {
  const registered = await client.registerType(schema as never);
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
}

async function create(
  type: string,
  properties: Record<string, unknown>,
  tags: string[] = [],
) {
  const created = await client.createItem({
    type,
    source: ctx.source,
    properties,
    tags,
  });
  if (created.ok) trackItem(ctx, created.data.item.id);
  return created;
}

describe("a status field's definition", () => {
  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["no words", { type: "status" }, "fields.stage.status_values"],
    [
      "a group outside the four",
      { type: "status", status_values: [{ value: "todo", group: "waiting" }] },
      "fields.stage.status_values.0.group",
    ],
    [
      "a word outside the grammar",
      {
        type: "status",
        status_values: [{ value: "In Review", group: "in_progress" }],
      },
      "fields.stage.status_values.0.value",
    ],
    [
      "a word twice",
      {
        type: "status",
        status_values: [
          { value: "todo", group: "not_started" },
          { value: "todo", group: "canceled" },
        ],
      },
      "fields.stage.status_values.1.value",
    ],
    [
      "enum_values on a status field",
      { type: "status", status_values: WORDS, enum_values: ["todo"] },
      "fields.stage.enum_values",
    ],
    [
      "an array of status words",
      { type: "array", items_type: "status" },
      "fields.stage.items_type",
    ],
    [
      "words on a field of another kind",
      { type: "string", status_values: WORDS },
      "fields.stage.status_values",
    ],
  ];

  it.each(REFUSED)(
    "refuses %s with invalid_schema, naming the member",
    async (what, stage, named) => {
      const id = nextId();
      const refused = await client.registerType({
        id,
        fields: { stage },
      } as never);
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("invalid_schema");
      expect(errorFields(refused), what).toContain(named);
      expect((await client.getType(id)).status, what).toBe(404);
    },
  );

  it("refuses a second status field in one type", async () => {
    const id = nextId();
    const refused = await client.registerType({
      id,
      fields: {
        stage: { type: "status", status_values: WORDS },
        phase: { type: "status", status_values: WORDS },
      },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect(errorFields(refused)).toContain("fields.phase.type");
  });

  it("takes words in the four groups and answers each with its group", async () => {
    const id = nextId();
    await register({ id, fields: { stage: { type: "status", status_values: WORDS } } });
    const read = await client.getType(id);
    expect(read.data.fields.stage).toEqual({
      type: "status",
      status_values: WORDS,
    });
  });

  it("refuses a status property on an edge type", async () => {
    const id = `user.status-edge-${ctx.runId}`;
    const refused = await client.registerEdgeType({
      label: "Status edge",
      id,
      cardinality: "many-to-many",
      property_schema: { stage: { type: "status", status_values: WORDS } },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(JSON.stringify(refused.error)).toContain("property_schema.stage");

    // The witness: the same edge type with a string property registers.
    const taken = await client.registerEdgeType({
      label: "Status edge",
      id,
      cardinality: "many-to-many",
      property_schema: { stage: { type: "string" } },
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    trackEdgeType(ctx, id);
  });
});

describe("a status field down a chain", () => {
  let parent: string;
  let child: string;

  beforeAll(async () => {
    parent = nextId();
    child = `${parent}.bug`;
    await register({
      id: parent,
      fields: {
        title: { type: "string" },
        stage: { type: "status", status_values: WORDS },
      },
    });
    await register({
      id: child,
      parent,
      fields: {
        stage: {
          type: "status",
          status_values: [{ value: "blocked", group: "in_progress" }],
        },
      },
    });
  });

  it("answers a subtype's words after the inherited ones, each with its group", async () => {
    const read = await client.getType(child);
    expect(read.data.fields.stage).toMatchObject({
      type: "status",
      status_values: [...WORDS, { value: "blocked", group: "in_progress" }],
    });
  });

  it("lists each type with the words it declares itself", async () => {
    const listed = await client.listTypes();
    expect(listed.status).toBe(200);
    const own = listed.data.data.find((type) => type.id === child);
    expect(own?.fields.stage?.status_values).toEqual([
      { value: "blocked", group: "in_progress" },
    ]);
  });

  it("refuses an inherited word declared again, in any group", async () => {
    const refused = await client.registerType({
      id: `${parent}.again`,
      parent,
      fields: {
        stage: {
          type: "status",
          status_values: [{ value: "done", group: "canceled" }],
        },
      },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("inheritance_violation");
    expect(errorFields(refused)).toContain("fields.stage.status_values");
  });

  it("refuses a second status field under another name", async () => {
    const refused = await client.registerType({
      id: `${parent}.second`,
      parent,
      fields: { phase: { type: "status", status_values: WORDS } },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("inheritance_violation");
  });

  it("refuses a parent gaining a status field beside a subtype's own under another name", async () => {
    const plain = nextId();
    await register({ id: plain, fields: { title: { type: "string" } } });
    await register({
      id: `${plain}.child`,
      parent: plain,
      fields: { phase: { type: "status", status_values: WORDS } },
    });
    const refused = await client.replaceType(plain, {
      id: plain,
      fields: {
        title: { type: "string" },
        stage: { type: "status", status_values: WORDS },
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("inheritance_violation");
    expect(errorFields(refused)).toContain("fields.stage");

    // The witness: the same field under the subtype's name is taken.
    const taken = await client.replaceType(plain, {
      id: plain,
      fields: {
        title: { type: "string" },
        phase: {
          type: "status",
          status_values: [{ value: "parked", group: "not_started" }],
        },
      },
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("refuses the inherited status field redeclared as another kind", async () => {
    const refused = await client.registerType({
      id: `${parent}.kind`,
      parent,
      fields: { stage: { type: "string" } },
    } as never);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("inheritance_violation");
  });

  it("refuses a parent change that adds a word a subtype already declares", async () => {
    const refused = await client.replaceType(parent, {
      id: parent,
      fields: {
        title: { type: "string" },
        stage: {
          type: "status",
          status_values: [...WORDS, { value: "blocked", group: "canceled" }],
        },
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("inheritance_violation");

    // The witness: a word no subtype declares is taken.
    const taken = await client.replaceType(parent, {
      id: parent,
      fields: {
        title: { type: "string" },
        stage: {
          type: "status",
          status_values: [...WORDS, { value: "parked", group: "not_started" }],
        },
      },
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("takes a subtype's word on its own items and refuses it on the parent's", async () => {
    const onChild = await create(child, { title: "Child", stage: "blocked" });
    expect(onChild.status, JSON.stringify(onChild.error)).toBe(201);

    const onParent = await create(parent, { title: "Parent", stage: "blocked" });
    expect(onParent.status).toBe(400);
    expect(onParent.error?.error.code).toBe("invalid_properties");
    expect(errorFields(onParent)).toContain("stage");
  });
});

describe("writing a status field", () => {
  let type: string;

  beforeAll(async () => {
    type = nextId();
    await register({
      id: type,
      fields: {
        title: { type: "string" },
        stage: {
          type: "status",
          status_values: [...WORDS, { value: "waiting", group: "not_started" }],
        },
      },
    });
  });

  it("refuses a word the type does not declare, naming the field", async () => {
    const refused = await create(type, { title: "Undeclared", stage: "pending" });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(errorFields(refused)).toContain("stage");

    const taken = await create(type, { title: "Declared", stage: "todo" });
    expect(taken.status).toBe(201);

    const changed = await client.updateItem(taken.data.item.id, {
      properties: { stage: "pending" },
      version: taken.data.item.version,
    });
    expect(changed.status).toBe(400);
    expect(changed.error?.error.code).toBe("invalid_properties");
    expect(errorFields(changed)).toContain("stage");
  });

  it("refuses an undeclared word in a bulk entry, an upsert by natural key and a bulk upsert", async () => {
    const key = `status-${ctx.runId}`;
    const bulk = await client.bulkItems({
      mode: "create_only",
      atomic: false,
      items: [
        { type, source_id: `${key}-a`, properties: { title: "a", stage: "todo" } },
        { type, source_id: `${key}-b`, properties: { title: "b", stage: "pending" } },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results[0]?.outcome).toBe("created");
    expect(bulk.data.results[1]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
    trackItem(ctx, String(bulk.data.results[0]?.id));

    // A create naming the natural key of a live item is an update.
    const upsert = await client.createItem({
      type,
      source: ctx.source,
      source_id: `${key}-a`,
      properties: { title: "a", stage: "pending" },
    });
    expect(upsert.status).toBe(400);
    expect(upsert.error?.error.code).toBe("invalid_properties");

    const bulkUpsert = await client.bulkItems({
      mode: "upsert",
      atomic: false,
      items: [
        { type, source_id: `${key}-a`, properties: { stage: "pending" } },
        { type, source_id: `${key}-a`, properties: { stage: "done" } },
      ],
    });
    expect(bulkUpsert.status, JSON.stringify(bulkUpsert.error)).toBe(200);
    expect(bulkUpsert.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
    expect(bulkUpsert.data.results[1]?.outcome).toBe("updated");
  });

  it("leaves a stored word the type no longer declares until a write sets it", async () => {
    const created = await create(type, { title: "Held", stage: "waiting" });
    expect(created.status).toBe(201);
    const id = created.data.item.id;

    const narrowed = await client.replaceType(type, {
      id: type,
      fields: {
        title: { type: "string" },
        stage: { type: "status", status_values: WORDS },
      },
    });
    expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);

    const retitled = await client.updateItem(id, {
      properties: { title: "Held, renamed" },
      version: created.data.item.version,
    });
    expect(retitled.status, JSON.stringify(retitled.error)).toBe(200);
    expect(retitled.data.item.properties.stage).toBe("waiting");

    const restated = await client.updateItem(id, {
      properties: { title: "Held, again", stage: "waiting" },
      version: retitled.data.item.version,
    });
    expect(restated.status).toBe(400);
    expect(restated.error?.error.code).toBe("invalid_properties");
    expect(errorFields(restated)).toContain("stage");
  });
});

describe("filtering by status_group", () => {
  let tag: string;
  let parent: string;
  const made: Record<string, string> = {};

  beforeAll(async () => {
    tag = `status-group-${ctx.runId}`;
    parent = nextId();
    const child = `${parent}.bug`;
    const plain = nextId();
    await register({
      id: parent,
      fields: {
        title: { type: "string" },
        stage: {
          type: "status",
          status_values: [...WORDS, { value: "waiting", group: "not_started" }],
        },
      },
    });
    await register({
      id: child,
      parent,
      fields: {
        stage: {
          type: "status",
          status_values: [{ value: "blocked", group: "in_progress" }],
        },
      },
    });
    await register({
      id: plain,
      fields: { title: { type: "string" }, stage: { type: "string" } },
    });
    const rows: [string, string, Record<string, unknown>][] = [
      ["todo", parent, { title: "todo", stage: "todo" }],
      ["doing", parent, { title: "doing", stage: "doing" }],
      ["done", parent, { title: "done", stage: "done" }],
      ["dropped", parent, { title: "dropped", stage: "dropped" }],
      ["blocked", child, { title: "blocked", stage: "blocked" }],
      ["unset", parent, { title: "unset" }],
      ["waiting", parent, { title: "waiting", stage: "waiting" }],
      ["plain", plain, { title: "plain", stage: "done" }],
    ];
    for (const [name, type, properties] of rows) {
      const created = await create(type, properties, [tag]);
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      made[name] = created.data.item.id;
    }
    // The type stops declaring `waiting`; the row keeps the word.
    const narrowed = await client.replaceType(parent, {
      id: parent,
      fields: {
        title: { type: "string" },
        stage: { type: "status", status_values: WORDS },
      },
    });
    expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
  });

  async function matching(filter: string): Promise<string[]> {
    const listed = await client.listItems({ tags: [tag], filter, limit: 100 });
    expect(listed.status, `${filter}: ${JSON.stringify(listed.error)}`).toBe(
      200,
    );
    const ids = new Set(listed.data.data.map((item) => item.id));
    return Object.keys(made)
      .filter((name) => ids.has(made[name]!))
      .sort();
  }

  it.each([
    ['status_group eq "not_started"', ["todo"]],
    ['status_group eq "in_progress"', ["blocked", "doing"]],
    ['status_group eq "completed"', ["done"]],
    ['status_group eq "canceled"', ["dropped"]],
    [
      'status_group neq "completed" AND status_group neq "canceled"',
      ["blocked", "doing", "todo"],
    ],
    ["status_group exists", ["blocked", "doing", "done", "dropped", "todo"]],
    ["status_group not_exists", ["plain", "unset", "waiting"]],
  ])("%s", async (filter, expected) => {
    expect(await matching(filter)).toEqual(expected);
  });

  it.each([
    'status_group eq "pending"',
    'status_group eq "done"',
    'status_group contains "completed"',
    "status_group eq null",
  ])("refuses %s with validation_error", async (filter) => {
    const refused = await client.listItems({ tags: [tag], filter });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  });

  it("selects by group in a saved view", async () => {
    const filter = 'status_group neq "completed" AND status_group neq "canceled"';
    const view = await client.createView({
      title: "Open work",
      query: { filter, types: [parent] },
    });
    expect(view.status, JSON.stringify(view.error)).toBe(201);
    trackView(ctx, view.data.item.id);
    const listed = await client.listViewItems(view.data.item.id, { limit: 100 });
    expect(listed.status).toBe(200);
    const ids = new Set(listed.data.data.map((item) => item.id));
    expect(
      Object.keys(made)
        .filter((name) => ids.has(made[name]!))
        .sort(),
    ).toEqual(["blocked", "doing", "todo"]);
  });
});

describe("compatible_with and a status field", () => {
  it("reads a status field as a string, and as a status field holding its words in the same groups", async () => {
    const text = nextId();
    const wide = nextId();
    const narrow = nextId();
    await register({ id: text, fields: { stage: { type: "string" } } });
    await register({
      id: wide,
      fields: {
        stage: {
          type: "status",
          status_values: [...WORDS, { value: "blocked", group: "in_progress" }],
        },
      },
    });
    await register({
      id: narrow,
      fields: {
        stage: {
          type: "status",
          status_values: [...WORDS.slice(0, 3), { value: "dropped", group: "completed" }],
        },
      },
    });
    const stage = { type: "status", status_values: WORDS };

    await register({ id: nextId(), fields: { stage }, compatible_with: [text] });
    await register({ id: nextId(), fields: { stage }, compatible_with: [wide] });

    const regrouped = await client.registerType({
      id: nextId(),
      fields: { stage },
      compatible_with: [narrow],
    } as never);
    expect(regrouped.status).toBe(422);
    expect(regrouped.error?.error.code).toBe("compatible_with_violation");

    const loose = await client.registerType({
      id: nextId(),
      fields: { stage: { type: "string" } },
      compatible_with: [wide],
    } as never);
    expect(loose.status).toBe(422);
    expect(loose.error?.error.code).toBe("compatible_with_violation");
  });
});

describe("core.task", () => {
  it("declares its status words in the four groups", async () => {
    const read = await client.getType("core.task");
    expect(read.data.fields.status).toMatchObject({
      type: "status",
      status_values: [
        { value: "not_started", group: "not_started" },
        { value: "in_progress", group: "in_progress" },
        { value: "completed", group: "completed" },
        { value: "canceled", group: "canceled" },
      ],
    });
  });
});
