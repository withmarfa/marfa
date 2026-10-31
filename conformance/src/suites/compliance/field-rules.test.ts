import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { FieldDefinition, TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let sequence = 0;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "field-rules"));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Fields = Record<string, FieldDefinition>;
type Errors = { field: string; code?: string }[] | undefined;

const nextId = () => `user.rules-${ctx.runId}-${String(++sequence)}`;

const errorsOf = (response: { error?: { error: { details?: unknown } } }) =>
  (response.error?.error.details as { errors?: Errors } | undefined)?.errors;

/** A list of contacts: a required email, a free label and a rank from 1 to 5. */
const CONTACTS: FieldDefinition = {
  type: "array",
  items_type: "object",
  items_fields: {
    value: { type: "email", required: true },
    label: { type: "string", maxLength: 10 },
    rank: { type: "integer", minimum: 1, maximum: 5 },
  },
};

describe("a range, a currency and a list of entries in a type", () => {
  it("registers a range, a currency format and a list of entries, and answers them", async () => {
    const id = nextId();
    const fields: Fields = {
      score: { type: "integer", minimum: 1, maximum: 5 },
      price: { type: "number", minimum: -0.5 },
      code: { type: "string", format: "currency" },
      contacts: CONTACTS,
    };
    const registered = await client.registerType({ id, fields });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const read = await client.getType(id);
    expect(read.data.fields).toMatchObject(fields);
  });

  const SCHEMA_REFUSED: {
    what: string;
    bad: Fields;
    named: string;
    mended: Fields;
  }[] = [
    {
      what: "a range on a string",
      bad: { x: { type: "string", minimum: 1 } },
      named: "fields.x.minimum",
      mended: { x: { type: "number", minimum: 1 } },
    },
    {
      what: "a minimum above the maximum",
      bad: { x: { type: "integer", minimum: 5, maximum: 1 } },
      named: "fields.x",
      mended: { x: { type: "integer", minimum: 1, maximum: 5 } },
    },
    {
      what: "a bound that is not a whole number on an integer",
      bad: { x: { type: "integer", maximum: 2.5 } },
      named: "fields.x.maximum",
      mended: { x: { type: "number", maximum: 2.5 } },
    },
    {
      what: "a bound that is not a number",
      bad: { x: { type: "number", minimum: "1" as never } },
      named: "fields.x.minimum",
      mended: { x: { type: "number", minimum: 1 } },
    },
    {
      what: "a range on a member that is a string",
      bad: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: { m: { type: "string", maximum: 3 } },
        },
      },
      named: "fields.x.items_fields.m.maximum",
      mended: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: { m: { type: "integer", maximum: 3 } },
        },
      },
    },
    {
      what: "a currency format on a number",
      bad: { x: { type: "number", format: "currency" } },
      named: "fields.x.format",
      mended: { x: { type: "string", format: "currency" } },
    },
    {
      what: "a maxLength on a currency field",
      bad: { x: { type: "string", format: "currency", maxLength: 2 } },
      named: "fields.x.maxLength",
      mended: { x: { type: "string", format: "currency" } },
    },
    {
      what: "a maxLength on a currency member",
      bad: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: {
            m: { type: "string", format: "currency", maxLength: 2 },
          },
        },
      },
      named: "fields.x.items_fields.m.maxLength",
      mended: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: { m: { type: "string", format: "currency" } },
        },
      },
    },
    {
      what: "items_fields on a string",
      bad: { x: { type: "string", items_fields: CONTACTS.items_fields } },
      named: "fields.x.items_fields",
      mended: { x: CONTACTS },
    },
    {
      what: "items_fields on a list of strings",
      bad: {
        x: {
          type: "array",
          items_type: "string",
          items_fields: CONTACTS.items_fields,
        },
      },
      named: "fields.x.items_fields",
      mended: { x: CONTACTS },
    },
    {
      what: "items_fields with no member",
      bad: { x: { type: "array", items_type: "object", items_fields: {} } },
      named: "fields.x.items_fields",
      mended: { x: CONTACTS },
    },
    ...(["array", "object", "status", "thumbnail"] as const).map((kind) => ({
      what: `a member that is a ${kind}`,
      bad: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: { m: { type: kind } },
        },
      } as Fields,
      named: "fields.x.items_fields.m",
      mended: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: { m: { type: "string" } },
        },
      } as Fields,
    })),
    {
      what: "a member with a key a member does not take",
      bad: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: { m: { type: "string", searchable: false } },
        },
      },
      named: "fields.x.items_fields.m.searchable",
      mended: {
        x: {
          type: "array",
          items_type: "object",
          items_fields: { m: { type: "string" } },
        },
      },
    },
  ];

  it.each(SCHEMA_REFUSED)(
    "refuses $what with invalid_schema, naming the member",
    async ({ what, bad, named, mended }) => {
      const id = nextId();
      const refused = await client.registerType({ id, fields: bad });
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("invalid_schema");
      expect(
        errorsOf(refused)?.some(
          (e) => e.field === named || e.field.startsWith(`${named}.`),
        ),
        `${what}: ${JSON.stringify(errorsOf(refused))}`,
      ).toBe(true);
      expect((await client.getType(id)).status, what).toBe(404);

      // The witness: the same field with only that mended registers.
      const registered = await client.registerType({ id, fields: mended });
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    },
  );
});

describe("a value in a field with a range, a currency or entries", () => {
  let typeId: string;

  beforeAll(async () => {
    typeId = nextId();
    const registered = await client.registerType({
      id: typeId,
      fields: {
        label: { type: "string" },
        score: { type: "integer", minimum: 1, maximum: 5 },
        price: { type: "number", minimum: -0.5, maximum: 10 },
        code: { type: "string", format: "currency" },
        contacts: CONTACTS,
      },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  });

  async function create(properties: Record<string, unknown>, type = typeId) {
    const created = await client.createItem({
      type,
      source: ctx.source,
      properties,
    });
    if (created.ok) trackItem(ctx, created.data.item.id);
    return created;
  }

  const fieldsOf = (response: { error?: { error: { details?: unknown } } }) =>
    errorsOf(response)?.map((e) => e.field);

  it("takes a value at each bound and refuses one past it", async () => {
    for (const properties of [
      { score: 1, price: -0.5 },
      { score: 5, price: 10 },
    ]) {
      const taken = await create(properties);
      expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    }
    for (const [field, value] of [
      ["score", 0],
      ["score", 6],
      ["price", -0.51],
      ["price", 10.01],
    ] as const) {
      const refused = await create({ [field]: value });
      expect(refused.status, `${field} ${String(value)}`).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_properties");
      expect(fieldsOf(refused)).toContain(field);
    }
  });

  it("checks the range on an update and a bulk entry, and on a value stored before the type had one", async () => {
    const made = await create({ score: 3 });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const refused = await client.updateItem(made.data.item.id, {
      version: made.data.item.version,
      properties: { score: 9 },
    });
    expect(refused.status).toBe(400);
    expect(fieldsOf(refused)).toContain("score");
    expect((await client.getItem(made.data.item.id)).data.item.version).toBe(
      made.data.item.version,
    );

    const bulk = await client.bulkItems({
      mode: "create_only",
      atomic: false,
      items: [
        { type: typeId, source_id: `${ctx.runId}-a`, properties: { score: 2 } },
        { type: typeId, source_id: `${ctx.runId}-b`, properties: { score: 7 } },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results[0]?.outcome).toBe("created");
    trackItem(ctx, String(bulk.data.results[0]?.id));
    expect(bulk.data.results[1]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
    expect(
      (
        bulk.data.results[1]?.error?.details as { errors?: Errors } | undefined
      )?.errors?.map((e) => e.field),
    ).toContain("score");

    // A type that gains a range leaves the values stored before it, and the
    // next write of properties meets it, as it meets a new maxLength.
    const id = nextId();
    expect(
      (await client.registerType({ id, fields: { n: { type: "integer" } } }))
        .ok,
    ).toBe(true);
    const old = await create({ n: 9 }, id);
    expect(old.status, JSON.stringify(old.error)).toBe(201);
    const replaced = await client.replaceType(id, {
      id,
      version: 1,
      fields: {
        n: { type: "integer", maximum: 5 },
        other: { type: "string" },
      },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    const stale = await client.updateItem(old.data.item.id, {
      version: old.data.item.version,
      properties: { other: "x" },
    });
    expect(stale.status).toBe(400);
    expect(fieldsOf(stale)).toContain("n");
  });

  it.each([["GBP"], ["ZZZ"]])("takes the currency %s", async (code) => {
    const taken = await create({ code });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    expect(taken.data.item.properties.code).toBe(code);
  });

  it.each([["gbp"], ["GB"], ["GBPX"], [""], ["GB1"], [826]])(
    "refuses the currency %j, naming the field",
    async (code) => {
      const refused = await create({ code });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_properties");
      expect(fieldsOf(refused)).toContain("code");
    },
  );

  it("takes entries that match their members", async () => {
    const taken = await create({
      contacts: [
        { value: "a@example.test", label: "work", rank: 1 },
        { value: "b@example.test" },
      ],
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    expect(taken.data.item.properties.contacts).toHaveLength(2);
    const none = await create({ contacts: [] });
    expect(none.status, JSON.stringify(none.error)).toBe(201);
  });

  const ENTRY_REFUSED: [string, unknown, string][] = [
    ["an undeclared member", { value: "b@example.test", x: 1 }, "contacts.1.x"],
    ["a missing required member", { label: "home" }, "contacts.1.value"],
    ["a member of the wrong kind", { value: 5 }, "contacts.1.value"],
    ["a member the kind refuses", { value: "no" }, "contacts.1.value"],
    [
      "a member over its maxLength",
      { value: "b@example.test", label: "x".repeat(11) },
      "contacts.1.label",
    ],
    [
      "a member past its range",
      { value: "b@example.test", rank: 6 },
      "contacts.1.rank",
    ],
    [
      "a null member",
      { value: "b@example.test", label: null },
      "contacts.1.label",
    ],
    ["an entry with no member", {}, "contacts.1"],
    ["an entry that is not an object", "text", "contacts.1"],
  ];

  it.each(ENTRY_REFUSED)(
    "refuses %s, naming the field, the position and the member",
    async (what, entry, named) => {
      const refused = await create({
        contacts: [{ value: "a@example.test" }, entry],
      });
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("invalid_properties");
      expect(fieldsOf(refused), what).toContain(named);
    },
  );

  it("refuses a member named __proto__ as undeclared, which a JSON text makes an own key", async () => {
    const text = (entry: string) =>
      `{"type":${JSON.stringify(typeId)},"source":${JSON.stringify(ctx.source)},"properties":{"contacts":[${entry}]}}`;
    const send = (entry: string) =>
      client.rawRequest<{ item: { id: string } }>("/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text(entry),
      });
    const refused = await send(
      '{"value":"a@example.test","__proto__":{"x":1}}',
    );
    expect(refused.status, JSON.stringify(refused.error)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(fieldsOf(refused)).toContain("contacts.0.__proto__");
    const alone = await send('{"__proto__":1}');
    expect(alone.status).toBe(400);
    expect(fieldsOf(alone)).toContain("contacts.0.__proto__");
    // The witness: the same entry without the member is taken.
    const taken = await send('{"value":"a@example.test"}');
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    trackItem(ctx, taken.data.item.id);
  });

  it("checks the entries on an update and a bulk entry, naming the member, and on entries stored before the field declared its members", async () => {
    const made = await create({
      contacts: [{ value: "a@example.test" }],
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const refused = await client.updateItem(made.data.item.id, {
      version: made.data.item.version,
      properties: { contacts: [{ value: "a@example.test" }, { label: "x" }] },
    });
    expect(refused.status).toBe(400);
    expect(fieldsOf(refused)).toContain("contacts.1.value");

    const bulk = await client.bulkItems({
      mode: "create_only",
      atomic: false,
      items: [
        {
          type: typeId,
          source_id: `${ctx.runId}-c`,
          properties: { contacts: [{ value: "a@example.test" }, { value: 1 }] },
        },
      ],
    });
    expect(bulk.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
    expect(
      (
        bulk.data.results[0]?.error?.details as { errors?: Errors } | undefined
      )?.errors?.map((e) => e.field),
    ).toContain("contacts.1.value");

    const id = nextId();
    expect(
      (
        await client.registerType({
          id,
          fields: { list: { type: "array", items_type: "object" } },
        })
      ).ok,
    ).toBe(true);
    const old = await create({ list: [{ anything: 1 }] }, id);
    expect(old.status, JSON.stringify(old.error)).toBe(201);
    const replaced = await client.replaceType(id, {
      id,
      version: 1,
      fields: {
        list: {
          type: "array",
          items_type: "object",
          items_fields: { value: { type: "string" } },
        },
        other: { type: "string" },
      },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    const stale = await client.updateItem(old.data.item.id, {
      version: old.data.item.version,
      properties: { other: "x" },
    });
    expect(stale.status).toBe(400);
    expect(fieldsOf(stale)).toContain("list.0.anything");
  });
});

describe("a url is stored without the whitespace around it at every door", () => {
  const PADDED = "  https://example.test/a\t ";
  const KEPT = "https://example.test/a";
  let typeId: string;

  beforeAll(async () => {
    typeId = nextId();
    const registered = await client.registerType({
      id: typeId,
      fields: {
        link: { type: "url" },
        sites: { type: "array", items_type: "url" },
        entries: {
          type: "array",
          items_type: "object",
          items_fields: { u: { type: "url" }, v: { type: "string" } },
        },
        note: { type: "string" },
      },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  });

  const made = async (
    properties: Record<string, unknown>,
    sourceId?: string,
  ) => {
    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      ...(sourceId !== undefined && { source_id: sourceId }),
      properties,
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    return created.data.item;
  };

  const kept = async (id: string) =>
    (await client.getItem(id)).data.item.properties;

  it("stores a top-level url, a url in a list and a url member trimmed on a create", async () => {
    const item = await made({
      link: PADDED,
      sites: [PADDED],
      entries: [{ u: PADDED, v: PADDED }],
    });
    for (const properties of [item.properties, await kept(item.id)]) {
      expect(properties.link).toBe(KEPT);
      expect(properties.sites).toEqual([KEPT]);
      expect(properties.entries).toEqual([{ u: KEPT, v: PADDED }]);
    }
  });

  it("stores them trimmed on an update", async () => {
    const item = await made({ note: "n" });
    const updated = await client.updateItem(item.id, {
      version: item.version,
      properties: {
        link: PADDED,
        sites: [PADDED],
        entries: [{ u: PADDED, v: PADDED }],
      },
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    for (const properties of [
      updated.data.item.properties,
      await kept(item.id),
    ]) {
      expect(properties.link).toBe(KEPT);
      expect(properties.sites).toEqual([KEPT]);
      expect(properties.entries).toEqual([{ u: KEPT, v: PADDED }]);
    }
  });

  it("stores them trimmed on an update that names a version since passed", async () => {
    const item = await made({ note: "n" });
    const moved = await client.updateItem(item.id, {
      version: item.version,
      properties: { note: "m" },
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    const stale = await client.updateItem(item.id, {
      version: item.version,
      properties: { link: PADDED, entries: [{ u: PADDED }] },
    });
    expect(stale.status, JSON.stringify(stale.error)).toBe(200);
    const properties = await kept(item.id);
    expect(properties.link).toBe(KEPT);
    expect(properties.entries).toEqual([{ u: KEPT }]);
    expect(properties.note).toBe("m");
  });

  it("stores them trimmed on an upsert onto an existing item and on a bulk update", async () => {
    const key = `url-${ctx.runId}`;
    const item = await made({ note: "n" }, `${key}-a`);
    const upserted = await client.createItem({
      type: typeId,
      source: ctx.source,
      source_id: `${key}-a`,
      properties: { link: PADDED, entries: [{ u: PADDED }] },
    });
    expect(upserted.status, JSON.stringify(upserted.error)).toBe(200);
    expect(upserted.data.item.id).toBe(item.id);
    let properties = await kept(item.id);
    expect(properties.link).toBe(KEPT);
    expect(properties.entries).toEqual([{ u: KEPT }]);

    const other = await made({ note: "n" }, `${key}-b`);
    const bulk = await client.bulkItems({
      mode: "upsert",
      atomic: false,
      items: [
        {
          type: typeId,
          source_id: `${key}-b`,
          properties: {
            link: PADDED,
            sites: [PADDED],
            entries: [{ u: PADDED }],
          },
        },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results[0]?.outcome).toBe("updated");
    properties = await kept(other.id);
    expect(properties.link).toBe(KEPT);
    expect(properties.sites).toEqual([KEPT]);
    expect(properties.entries).toEqual([{ u: KEPT }]);
  });
});

describe("a string whose format is a kind of its own", () => {
  const entries = (member: FieldDefinition): FieldDefinition => ({
    type: "array",
    items_type: "object",
    items_fields: { m: member },
  });

  it("is held as that kind in a field and in a member of a list's entries", async () => {
    const id = nextId();
    const registered = await client.registerType({
      id,
      fields: {
        site: { type: "string", format: "url" },
        sites: { type: "array", items_type: "string", format: "url" },
        list: entries({ type: "string", format: "url" }),
      },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const read = await client.getType(id);
    expect(read.data.fields?.site).toMatchObject({ type: "url" });
    expect(read.data.fields?.sites).toMatchObject({ items_type: "url" });
    expect(read.data.fields?.list?.items_fields?.m).toMatchObject({
      type: "url",
    });
    const created = await client.createItem({
      type: id,
      source: ctx.source,
      properties: {
        site: "  https://example.test/a\t ",
        sites: [" https://example.test/b "],
        list: [{ m: "\thttps://example.test/c\n" }],
      },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    expect(created.data.item.properties).toMatchObject({
      site: "https://example.test/a",
      sites: ["https://example.test/b"],
      list: [{ m: "https://example.test/c" }],
    });
    const refused = await client.createItem({
      type: id,
      source: ctx.source,
      properties: { list: [{ m: "not a url" }] },
    });
    expect(refused.status).toBe(400);
    expect(errorsOf(refused)?.map((e) => e.field)).toContain("list.0.m");
  });

  it("is refused as a member where the kind is one an entry does not take", async () => {
    const refused = await client.registerType({
      id: nextId(),
      fields: { list: entries({ type: "string", format: "thumbnail" }) },
    });
    expect(refused.status).toBe(400);
    expect(
      errorsOf(refused)?.map((e) => e.field),
      JSON.stringify(refused.error),
    ).toContain("fields.list.items_fields.m.type");
    // The witness: as a field of its own, the same definition registers.
    const taken = await client.registerType({
      id: nextId(),
      fields: { image: { type: "string", format: "thumbnail" } },
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });
});

describe("a child and a claim of compatibility", () => {
  it("takes a child that tightens an inherited range, and refuses one that loosens it", async () => {
    const parent = nextId();
    expect(
      (
        await client.registerType({
          id: parent,
          fields: {
            score: { type: "integer", minimum: 1, maximum: 5 },
            free: { type: "number" },
          },
        })
      ).ok,
    ).toBe(true);
    const child = (fields: Fields, suffix: string) =>
      client.registerType({ id: `${parent}.${suffix}`, parent, fields });

    // Narrowing a range, and adding one where the parent has none, are taken.
    const tighter = await child(
      {
        score: { type: "integer", minimum: 2, maximum: 5 },
        free: { type: "number", maximum: 9 },
      },
      "tighter",
    );
    expect(tighter.status, JSON.stringify(tighter.error)).toBe(201);
    expect(
      (
        await child(
          { score: { type: "integer", minimum: 1, maximum: 5 } },
          "same",
        )
      ).status,
    ).toBe(201);

    for (const [what, score, named] of [
      ["a lower minimum", { minimum: 0, maximum: 5 }, "fields.score.minimum"],
      ["a higher maximum", { minimum: 1, maximum: 6 }, "fields.score.maximum"],
      ["no minimum", { maximum: 5 }, "fields.score.minimum"],
      ["no range", {}, "fields.score.minimum"],
    ] as const) {
      const refused = await child(
        { score: { type: "integer", ...score } },
        what.replaceAll(" ", "-"),
      );
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("inheritance_violation");
      expect(
        errorsOf(refused)?.map((e) => e.field),
        what,
      ).toContain(named);
    }
  });

  it("refuses a parent replacement that leaves a child's range looser", async () => {
    const parent = nextId();
    expect(
      (
        await client.registerType({
          id: parent,
          fields: { n: { type: "integer" } },
        })
      ).ok,
    ).toBe(true);
    const child = await client.registerType({
      id: `${parent}.child`,
      parent,
      fields: { n: { type: "integer", minimum: 1 } },
    });
    expect(child.status, JSON.stringify(child.error)).toBe(201);

    const refused = await client.replaceType(parent, {
      id: parent,
      version: 1,
      fields: { n: { type: "integer", minimum: 2 } },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("inheritance_violation");
    expect(errorsOf(refused)?.map((e) => e.field)).toContain(
      "fields.n.minimum",
    );

    // The witness: a parent range the child already sits inside is taken.
    const taken = await client.replaceType(parent, {
      id: parent,
      version: 1,
      fields: { n: { type: "integer", minimum: 1 } },
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  });

  it("refuses a child that changes the members of an inherited list", async () => {
    const parent = nextId();
    expect(
      (
        await client.registerType({
          id: parent,
          fields: { contacts: CONTACTS },
        })
      ).ok,
    ).toBe(true);
    const child = (fields: Fields, suffix: string) =>
      client.registerType({ id: `${parent}.${suffix}`, parent, fields });

    expect((await child({ contacts: CONTACTS }, "same")).status).toBe(201);
    for (const [what, definition] of [
      [
        "another member",
        {
          ...CONTACTS,
          items_fields: { value: { type: "email", required: true } },
        },
      ],
      [
        "a looser member",
        {
          ...CONTACTS,
          items_fields: {
            ...CONTACTS.items_fields,
            rank: { type: "integer", minimum: 1, maximum: 9 },
          },
        },
      ],
      ["no members", { type: "array", items_type: "object" }],
    ] as [string, FieldDefinition][]) {
      const refused = await child(
        { contacts: definition },
        what.replaceAll(" ", "-"),
      );
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("inheritance_violation");
      expect(
        errorsOf(refused)?.map((e) => e.field),
        what,
      ).toContain("fields.contacts.items_fields");
    }
  });

  /** Registers `fields` claiming compatibility with a target of `target`, and says whether it was taken. */
  async function claims(target: Fields, fields: Fields) {
    const targetId = nextId();
    expect(
      (await client.registerType({ id: targetId, fields: target })).ok,
    ).toBe(true);
    const claim = await client.registerType({
      id: nextId(),
      fields,
      compatible_with: targetId,
    } as never);
    if (claim.ok) return true;
    expect(claim.status, JSON.stringify(claim.error)).toBe(422);
    expect(claim.error?.error.code).toBe("compatible_with_violation");
    return false;
  }

  it("reads a range as the target's only where it is inside the target's", async () => {
    const target = { n: { type: "integer", minimum: 1, maximum: 5 } } as Fields;
    expect(
      await claims(target, { n: { type: "integer", minimum: 2, maximum: 5 } }),
    ).toBe(true);
    expect(
      await claims(target, { n: { type: "integer", minimum: 1, maximum: 5 } }),
    ).toBe(true);
    expect(
      await claims(target, { n: { type: "integer", minimum: 0, maximum: 5 } }),
    ).toBe(false);
    expect(
      await claims(target, { n: { type: "integer", minimum: 1, maximum: 6 } }),
    ).toBe(false);
    expect(await claims(target, { n: { type: "integer", minimum: 1 } })).toBe(
      false,
    );
    expect(await claims(target, { n: { type: "integer" } })).toBe(false);
    // A target with no range is read from any range.
    expect(
      await claims(
        { n: { type: "number" } },
        { n: { type: "integer", maximum: 5 } },
      ),
    ).toBe(true);
  });

  it("reads a currency string as a string, and a string not as a currency", async () => {
    const currency: Fields = { c: { type: "string", format: "currency" } };
    expect(await claims({ c: { type: "string" } }, currency)).toBe(true);
    expect(await claims(currency, currency)).toBe(true);
    expect(await claims(currency, { c: { type: "string" } })).toBe(false);
    expect(
      await claims(currency, { c: { type: "string", format: "bcp47" } }),
    ).toBe(false);
  });

  it("reads a list of entries as the target's only where the members are identical", async () => {
    const target: Fields = { list: CONTACTS };
    expect(await claims(target, { list: { ...CONTACTS } })).toBe(true);
    expect(
      await claims(target, {
        list: {
          ...CONTACTS,
          items_fields: { ...CONTACTS.items_fields, label: { type: "string" } },
        },
      }),
    ).toBe(false);
    expect(
      await claims(target, { list: { type: "array", items_type: "object" } }),
    ).toBe(false);
    expect(
      await claims({ list: { type: "array", items_type: "object" } }, target),
    ).toBe(false);
  });
});

describe("an article's DOI", () => {
  it("lists doi as an optional string on core.media.article and keeps what an article writes", async () => {
    const read = await client.getType("core.media.article");
    expect(read.data.fields?.doi).toMatchObject({
      type: "string",
      description: "Digital Object Identifier (ISO 26324)",
    });
    expect(read.data.fields?.doi?.required).not.toBe(true);

    const withDoi = await client.createItem({
      type: "core.media.article",
      source: ctx.source,
      properties: { title: "A paper", doi: "10.1000/182" },
    });
    expect(withDoi.status, JSON.stringify(withDoi.error)).toBe(201);
    trackItem(ctx, withDoi.data.item.id);
    expect(withDoi.data.item.properties.doi).toBe("10.1000/182");

    const without = await client.createItem({
      type: "core.media.article",
      source: ctx.source,
      properties: { title: "No identifier" },
    });
    expect(without.status, JSON.stringify(without.error)).toBe(201);
    trackItem(ctx, without.data.item.id);
  });
});
