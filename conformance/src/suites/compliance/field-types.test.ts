import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let sequence = 0;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "field-types"));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Body = Record<string, unknown>;

function nextId(): string {
  return `user.grammar-${ctx.runId}-${String(++sequence)}`;
}

/** What a refusal's `details.errors` names: the member itself, or a path
 *  beneath it such as the position of one bad entry in a list. */
function names(
  errors: { field: string }[] | undefined,
  member: string,
): boolean {
  return (
    errors?.some(
      (e) => e.field === member || e.field.startsWith(`${member}.`),
    ) ?? false
  );
}

describe("a field's definition", () => {
  // Each row is a body the grammar refuses, the member the refusal names, and
  // the body with that one thing mended, which registers.
  const REFUSED: {
    what: string;
    bad: Body;
    named: string;
    mended: Body;
  }[] = [
    {
      what: "an unknown field type",
      bad: { fields: { x: { type: "bogus" } } },
      named: "fields.x.type",
      mended: { fields: { x: { type: "string" } } },
    },
    {
      what: "an unknown format",
      bad: { fields: { x: { type: "string", format: "bogus" } } },
      named: "fields.x.format",
      mended: { fields: { x: { type: "string", format: "bcp47" } } },
    },
    {
      what: "an enum with no enum_values",
      bad: { fields: { x: { type: "enum" } } },
      named: "fields.x.enum_values",
      mended: { fields: { x: { type: "enum", enum_values: ["a"] } } },
    },
    {
      what: "an enum with an empty list",
      bad: { fields: { x: { type: "enum", enum_values: [] } } },
      named: "fields.x.enum_values",
      mended: { fields: { x: { type: "enum", enum_values: ["a"] } } },
    },
    {
      what: "an enum with a value that is not a string",
      bad: { fields: { x: { type: "enum", enum_values: ["a", 1] } } },
      named: "fields.x.enum_values",
      mended: { fields: { x: { type: "enum", enum_values: ["a", "1"] } } },
    },
    {
      what: "an array with no items_type",
      bad: { fields: { x: { type: "array" } } },
      named: "fields.x.items_type",
      mended: { fields: { x: { type: "array", items_type: "string" } } },
    },
    {
      what: "a maxLength of 0",
      bad: { fields: { x: { type: "string", maxLength: 0 } } },
      named: "fields.x.maxLength",
      mended: { fields: { x: { type: "string", maxLength: 1 } } },
    },
    {
      what: "a maxLength on a number",
      bad: { fields: { x: { type: "number", maxLength: 5 } } },
      named: "fields.x.maxLength",
      mended: { fields: { x: { type: "string", maxLength: 5 } } },
    },
    {
      what: "a maxItems of 0",
      bad: {
        fields: { x: { type: "array", items_type: "string", maxItems: 0 } },
      },
      named: "fields.x.maxItems",
      mended: {
        fields: { x: { type: "array", items_type: "string", maxItems: 1 } },
      },
    },
    {
      what: "a maxItems on a string",
      bad: { fields: { x: { type: "string", maxItems: 5 } } },
      named: "fields.x.maxItems",
      mended: {
        fields: { x: { type: "array", items_type: "string", maxItems: 5 } },
      },
    },
    {
      what: "a required list naming a field the type does not declare",
      bad: { fields: { x: { type: "string" } }, required: ["ghost"] },
      named: "required",
      mended: { fields: { x: { type: "string" } }, required: ["x"] },
    },
    {
      what: "states",
      bad: { fields: { x: { type: "string" } }, states: ["open", "closed"] },
      named: "states",
      mended: { fields: { x: { type: "string" } } },
    },
    {
      what: "a default_state",
      bad: { fields: { x: { type: "string" } }, default_state: "open" },
      named: "default_state",
      mended: { fields: { x: { type: "string" } } },
    },
    {
      what: "transitions",
      bad: { fields: { x: { type: "string" } }, transitions: {} },
      named: "transitions",
      mended: { fields: { x: { type: "string" } } },
    },
    {
      what: "a role outside the closed set",
      bad: { fields: { x: { type: "string" } }, roles: ["bogus"] },
      named: "roles",
      mended: { fields: { x: { type: "string" } }, roles: ["container"] },
    },
    {
      what: "a title_field naming a field the type does not declare",
      bad: {
        fields: { x: { type: "string" } },
        display_hints: { title_field: "ghost" },
      },
      named: "display_hints.title_field",
      mended: {
        fields: { x: { type: "string" } },
        display_hints: { title_field: "x" },
      },
    },
    {
      what: "a body_field naming a field the type does not declare",
      bad: {
        fields: { x: { type: "string" } },
        display_hints: { body_field: "ghost" },
      },
      named: "display_hints.body_field",
      mended: {
        fields: { x: { type: "string" } },
        display_hints: { body_field: "x" },
      },
    },
  ];

  it.each(REFUSED)(
    "refuses a field definition the grammar does not take",
    async ({ what, bad, named, mended }) => {
      const id = nextId();
      const refused = await client.registerType({ id, ...bad } as never);
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("invalid_schema");
      const errors = refused.error?.error.details?.errors as
        { field: string }[] | undefined;
      expect(names(errors, named), `${what}: ${JSON.stringify(errors)}`).toBe(
        true,
      );
      expect((await client.getType(id)).status, what).toBe(404);

      // The witness: the same body with only that mended registers.
      const registered = await client.registerType({
        id,
        ...mended,
      } as never);
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    },
  );

  it("takes a required entry naming a field only an ancestor declares", async () => {
    const parent = nextId();
    expect(
      (
        await client.registerType({
          id: parent,
          fields: { x: { type: "string" } },
        })
      ).status,
    ).toBe(201);
    const child = await client.registerType({
      id: nextId(),
      parent,
      fields: { y: { type: "string" } },
      required: ["x"],
    } as never);
    expect(child.status, JSON.stringify(child.error)).toBe(201);
  });
});

describe("a datetime or a date field", () => {
  let typeId: string;

  beforeAll(async () => {
    typeId = `user.moment-${ctx.runId}`;
    const registered = await client.registerType({
      id: typeId,
      fields: {
        moment: { type: "datetime" },
        day: { type: "date" },
      },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  });

  async function create(properties: Record<string, unknown>) {
    const created = await client.createItem({
      type: typeId,
      source: ctx.source,
      properties,
    });
    if (created.ok) trackItem(ctx, created.data.item.id);
    return created;
  }

  function refusedField(
    created: Awaited<ReturnType<typeof create>>,
  ): string[] | undefined {
    return (
      created.error?.error.details?.errors as { field: string }[] | undefined
    )?.map((e) => e.field);
  }

  it("takes every datetime form and refuses one with no zone or an hour past 23", async () => {
    for (const moment of [
      "2026-01-01",
      "2026-01-01T12:00Z",
      "2026-01-01T12:00:00Z",
      "2026-01-01T12:00:00.123+05:30",
    ]) {
      const created = await create({ moment });
      expect(
        created.status,
        `${moment}: ${JSON.stringify(created.error)}`,
      ).toBe(201);
      expect(created.data.item.properties.moment).toBe(moment);
      const read = await client.getItem(created.data.item.id);
      expect(read.data.item.properties.moment, moment).toBe(moment);
    }

    for (const moment of [
      "2026-01-01T12:00:00",
      "2026-01-01T24:00Z",
      "2026-01-01T12:60Z",
      "2026-02-30",
    ]) {
      const refused = await create({ moment });
      expect(refused.status, moment).toBe(400);
      expect(refused.error?.error.code, moment).toBe("invalid_properties");
      expect(refusedField(refused), moment).toContain("moment");
    }

    // The date field takes a calendar date and nothing more.
    const day = await create({ day: "2026-01-01" });
    expect(day.status, JSON.stringify(day.error)).toBe(201);
    expect(day.data.item.properties.day).toBe("2026-01-01");
    for (const value of ["2026-01-01T00:00Z", "2026-02-30"]) {
      const refused = await create({ day: value });
      expect(refused.status, value).toBe(400);
      expect(refused.error?.error.code, value).toBe("invalid_properties");
      expect(refusedField(refused), value).toContain("day");
    }
  });
});

describe("an array field", () => {
  let typeId: string;
  let childId: string;

  beforeAll(async () => {
    typeId = `user.listy-${ctx.runId}`;
    childId = `${typeId}.child`;
    const registered = await client.registerType({
      id: typeId,
      fields: {
        names: { type: "array", items_type: "string" },
        sites: { type: "array", items_type: "url" },
        things: { type: "array", items_type: "object" },
        capped: { type: "array", items_type: "string", maxItems: 2 },
        loose: { type: "array", items_type: "somethingelse" as never },
      },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const child = await client.registerType({
      id: childId,
      parent: typeId,
      fields: { more: { type: "string" } },
    });
    expect(child.status, JSON.stringify(child.error)).toBe(201);
  });

  async function create(
    properties: Record<string, unknown>,
    type = typeId,
    sourceId?: string,
  ) {
    const created = await client.createItem({
      type,
      source: ctx.source,
      ...(sourceId === undefined ? {} : { source_id: sourceId }),
      properties,
    });
    if (created.ok) trackItem(ctx, created.data.item.id);
    return created;
  }

  function fields(created: { error?: { error: { details?: unknown } } }) {
    return (
      created.error?.error.details as
        { errors?: { field: string }[] } | undefined
    )?.errors?.map((e) => e.field);
  }

  // Each row is a value the field refuses, with the position it names.
  const REFUSED: [string, Record<string, unknown>, string][] = [
    ["a string array with a number", { names: ["a", 42] }, "names.1"],
    ["a string array with an object", { names: [{ x: 1 }] }, "names.0"],
    ["a string array with a null", { names: [null] }, "names.0"],
    [
      "a url array with a non-URL",
      { sites: ["https://example.test", "no"] },
      "sites.1",
    ],
    [
      "a url array with a punycode label beside a host that is not ASCII",
      { sites: ["http://xn--a.münchen.de/"] },
      "sites.0",
    ],
    [
      "a url array with a punycode label whose host ends in a number",
      { sites: ["http://xn--a.1/"] },
      "sites.0",
    ],
    [
      "a url array with a punycode label and a forbidden code point",
      { sites: ["http://xn--%2f/"] },
      "sites.0",
    ],
    [
      "a url array with an internationalized label beside a punycode one",
      { sites: ["http://bücher.xn--"] },
      "sites.0",
    ],
    ["an object array with a string", { things: [{}, "text"] }, "things.1"],
    ["an object array with an array", { things: [[]] }, "things.0"],
    ["a universal links array with a number", { links: [1] }, "links.0"],
    [
      "a universal attachments array with a string",
      { attachments: ["x"] },
      "attachments.0",
    ],
    ["an array over maxItems", { capped: ["a", "b", "c"] }, "capped"],
  ];

  it.each(REFUSED)(
    "refuses %s on a create, naming the field",
    async (what, bad, named) => {
      const refused = await create(bad);
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("invalid_properties");
      expect(fields(refused), what).toContain(named);
    },
  );

  // An ASCII host is taken whatever its labels hold, so a label that starts
  // `xn--` and is not Punycode is taken.
  const TAKEN_URLS = [
    "http://xn--mnchen-3ya.de/",
    "http://xn--",
    "http://xn--%41",
    "http://xn--!",
    "http://xn--xn---yna/",
    "http://xn----pfa.xn--4db/",
    "http://a.b.c.xn--pokxncvks",
  ];

  it.each(TAKEN_URLS)("takes the url %s on a create", async (url) => {
    const taken = await create({ sites: [url] });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    expect(taken.data.item.properties.sites).toEqual([url]);
  });

  it("takes the values of the declared types, an empty array and a null", async () => {
    const good = await create({
      names: ["a", ""],
      sites: ["https://example.test/a"],
      things: [{}, { a: [1] }],
      capped: ["a", "b"],
      links: ["https://example.test"],
      attachments: [{ id: "x" }],
      loose: [1, {}, null],
    });
    expect(good.status, JSON.stringify(good.error)).toBe(201);
    expect(good.data.item.properties.names).toEqual(["a", ""]);

    const empty = await create({ names: [], things: [] });
    expect(empty.status, JSON.stringify(empty.error)).toBe(201);
    expect(empty.data.item.properties.names).toEqual([]);

    const nulled = await create({ names: null, sites: null });
    expect(nulled.status, JSON.stringify(nulled.error)).toBe(201);
    expect(nulled.data.item.properties).not.toHaveProperty("names");
  });

  it("checks a subtype's inherited array field", async () => {
    const refused = await create({ names: [1] }, childId);
    expect(refused.status).toBe(400);
    expect(fields(refused)).toContain("names.0");
    const ok = await create({ names: ["a"], more: "m" }, childId);
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
  });

  it("checks a shipped type's array field", async () => {
    const refused = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: { body: "hi", from: "a@example.test", to: [42, { x: 1 }] },
    });
    expect(refused.status, JSON.stringify(refused.error)).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(fields(refused)).toEqual(expect.arrayContaining(["to.0", "to.1"]));
    const ok = await client.createItem({
      type: "core.message",
      source: ctx.source,
      properties: {
        body: "hi",
        from: "a@example.test",
        to: ["a@example.test"],
      },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
    trackItem(ctx, ok.data.item.id);
  });

  it("checks the elements on an update, and keeps the item as it was when it refuses", async () => {
    const made = await create({ names: ["a"], things: [{}] });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const id = made.data.item.id;
    const version = made.data.item.version;

    const refused = await client.updateItem(id, {
      version,
      properties: { names: ["b", 7] },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(fields(refused)).toContain("names.1");
    const kept = await client.getItem(id);
    expect(kept.data.item.version).toBe(version);
    expect(kept.data.item.properties.names).toEqual(["a"]);

    // The witness: the same update with a string goes through.
    const ok = await client.updateItem(id, {
      version,
      properties: { names: ["b", "7"] },
    });
    expect(ok.status, JSON.stringify(ok.error)).toBe(200);
    expect(ok.data.item.properties.names).toEqual(["b", "7"]);
  });

  it("checks the elements of a bulk entry, an upsert by natural key and a bulk upsert", async () => {
    const key = `listy-${ctx.runId}`;
    const bulk = await client.bulkItems({
      mode: "create_only",
      atomic: false,
      items: [
        { type: typeId, source_id: `${key}-a`, properties: { names: ["a"] } },
        { type: typeId, source_id: `${key}-b`, properties: { names: [1] } },
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
    const again = await create({ names: ["a", 2] }, typeId, `${key}-a`);
    expect(again.status).toBe(400);
    expect(again.error?.error.code).toBe("invalid_properties");
    const upsertOk = await create({ names: ["a", "2"] }, typeId, `${key}-a`);
    expect(upsertOk.status, JSON.stringify(upsertOk.error)).toBe(200);

    const bulkUpsert = await client.bulkItems({
      mode: "upsert",
      atomic: false,
      items: [
        { type: typeId, source_id: `${key}-a`, properties: { names: [{}] } },
        { type: typeId, source_id: `${key}-a`, properties: { names: ["z"] } },
      ],
    });
    expect(bulkUpsert.status, JSON.stringify(bulkUpsert.error)).toBe(200);
    expect(bulkUpsert.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "invalid_properties" },
    });
    expect(bulkUpsert.data.results[1]?.outcome).toBe("updated");

    const atomic = await client.bulkItems({
      mode: "create_only",
      atomic: true,
      items: [
        { type: typeId, source_id: `${key}-c`, properties: { names: ["c"] } },
        { type: typeId, source_id: `${key}-d`, properties: { sites: ["no"] } },
      ],
    });
    expect(atomic.status).toBe(400);
    expect(atomic.error?.error.code).toBe("bulk_atomic_rollback");
    const none = await client.lookupItems({
      type: typeId,
      source: ctx.source,
      source_ids: [`${key}-c`],
    });
    expect(none.data.data).toEqual([]);
  });

  it("leaves the elements of an array unchecked where items_type names no field type", async () => {
    const ok = await create({ loose: [1, "x", {}, null] });
    expect(ok.status, JSON.stringify(ok.error)).toBe(201);
  });
});
