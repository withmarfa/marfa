/**
 * The contact lists `core.entity` ships, and the filter term that finds an
 * item by a member of a list's entries.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackView,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "contact-lists"));
});

afterAll(async () => {
  await cleanup(ctx);
});

type Errors = { field: string }[] | undefined;

const fieldsOf = (response: { error?: { error: { details?: unknown } } }) =>
  (
    (response.error?.error.details as { errors?: Errors } | undefined)
      ?.errors ?? []
  ).map((error) => error.field);

async function create(type: string, properties: Record<string, unknown>) {
  const made = await client.createItem({
    type,
    source: ctx.source,
    properties: { name: `contact ${ctx.runId}`, ...properties },
  });
  if (made.ok) trackItem(ctx, made.data.item.id);
  return made;
}

describe("the contact lists of core.entity", () => {
  it("declares emails, phones and addresses as lists of entries, and no email, phone or place", async () => {
    const entity = await client.getType("core.entity");
    expect(entity.ok, JSON.stringify(entity.error)).toBe(true);
    const fields = entity.data.fields;
    for (const gone of ["email", "phone", "place"]) {
      expect(fields, gone).not.toHaveProperty(gone);
    }
    expect(fields.emails).toMatchObject({
      type: "array",
      items_type: "object",
      items_fields: {
        value: { type: "email", required: true },
        label: { type: "string" },
      },
    });
    expect(fields.phones).toMatchObject({
      type: "array",
      items_type: "object",
      items_fields: {
        value: { type: "string", required: true },
        label: { type: "string" },
      },
    });
    const members = ["street_address", "locality", "region", "postal_code"];
    expect(fields.addresses).toMatchObject({
      type: "array",
      items_type: "object",
      items_fields: Object.fromEntries(
        ["label", ...members, "country"].map((name) => [
          name,
          { type: "string" },
        ]),
      ),
    });
  });

  it("takes a person with two emails, two phones and an address", async () => {
    const emails = [
      { value: "first@example.com", label: "work" },
      { value: "second@example.com" },
    ];
    const phones = [{ value: "+44 20 7946 0000" }, { value: "+1 555 0100" }];
    const addresses = [{ label: "home", locality: "London", country: "GB" }];
    const made = await create("core.entity.person", {
      emails,
      phones,
      addresses,
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const read = await client.getItem(made.data.item.id);
    expect(read.data.item.properties).toMatchObject({
      emails,
      phones,
      addresses,
    });
  });

  it.each([
    [
      "an email entry with no value",
      { emails: [{ label: "work" }] },
      "emails.0.value",
    ],
    [
      "an email entry whose value is not an email",
      { emails: [{ value: "first@example.com" }, { value: "not an email" }] },
      "emails.1.value",
    ],
    ["an empty phone entry", { phones: [{}] }, "phones.0"],
    [
      "an address entry with a member it does not declare",
      { addresses: [{ city: "London" }] },
      "addresses.0.city",
    ],
  ])(
    "refuses %s, naming the entry and the member",
    async (_what, properties, named) => {
      const refused = await create("core.entity.person", properties);
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_properties");
      expect(fieldsOf(refused)).toContain(named);
    },
  );

  it("keeps an email the type no longer declares as an undeclared property", async () => {
    const made = await create("core.entity.person", {
      email: "kept@example.com",
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    expect(made.data.item.properties.email).toBe("kept@example.com");
    expect(made.data.item.properties).not.toHaveProperty("emails");
  });
});

describe("a filter on a member of a list's entries", () => {
  let person: string;
  let other: string;

  beforeAll(async () => {
    const wanted = `second-${ctx.runId}@example.com`;
    const made = await create("core.entity.person", {
      emails: [{ value: `first-${ctx.runId}@example.com` }, { value: wanted }],
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    person = made.data.item.id;
    const unmatched = await create("core.entity.person", {
      emails: [{ value: `other-${ctx.runId}@example.com` }],
    });
    expect(unmatched.status, JSON.stringify(unmatched.error)).toBe(201);
    other = unmatched.data.item.id;
  });

  const scoped = (term: string) => `source eq "${ctx.source}" AND ${term}`;
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

  it("finds a person by their second email, on the listing, the search and a view", async () => {
    const term = `properties.emails.value eq "second-${ctx.runId}@example.com"`;
    const everyone = await client.listItems({
      filter: scoped("properties.emails exists"),
    });
    expect(ids(everyone.data.data)).toEqual(
      expect.arrayContaining([person, other]),
    );

    const listed = await client.listItems({ filter: scoped(term) });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(ids(listed.data.data)).toEqual([person]);

    const searched = await client.search("contact", { filter: scoped(term) });
    expect(searched.ok, JSON.stringify(searched.error)).toBe(true);
    expect(searched.data.data.map((hit) => hit.item.id)).toEqual([person]);

    const view = await client.createView({
      title: "Found by an email",
      query: { types: ["core.entity.person"], filter: scoped(term) },
    });
    expect(view.status, JSON.stringify(view.error)).toBe(201);
    trackView(ctx, view.data.item.id);
    const viewed = await client.listViewItems(view.data.item.id);
    expect(viewed.ok, JSON.stringify(viewed.error)).toBe(true);
    expect(ids(viewed.data.data)).toEqual([person]);
  });

  it("selects no row whose field is not a list of objects holding the member", async () => {
    const value = `odd-${ctx.runId}@example.com`;
    const odd = [
      { emails: value },
      { emails: { value } },
      { emails: [value] },
      { emails: [{ address: value }] },
    ];
    const made: string[] = [];
    for (const properties of [...odd, { emails: [{ value }] }]) {
      const note = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties,
      });
      expect(note.status, JSON.stringify(note.error)).toBe(201);
      trackItem(ctx, note.data.item.id);
      made.push(note.data.item.id);
    }
    const listed = await client.listItems({
      filter: scoped(`properties.emails.value eq "${value}"`),
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(ids(listed.data.data)).toEqual([made[odd.length]]);
  });

  it.each([
    ["neq on a member", 'properties.emails.value neq "a@example.com"'],
    ["contains on a member", 'properties.emails.value contains "a"'],
    ["exists on a member", "properties.emails.value exists"],
    ["a path of three names", 'properties.emails.value.part eq "a"'],
  ])("refuses %s with validation_error", async (_what, filter) => {
    const refused = await client.listItems({ filter });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  });
});
