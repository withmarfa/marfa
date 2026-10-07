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
