import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import {
  createEntity,
  createPerson,
  createPlace,
} from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "entity-subtypes"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("entity subtypes", () => {
  it("creates a generic entity with required name field", async () => {
    const entity = createEntity({ source: ctx.source });
    const r = await client.createItem(entity);
    expect(r.ok).toBe(true);
    expect(r.data.item.type).toBe("core.entity");
    expect(r.data.item.properties.name).toBe("Acme Corp");
    trackItem(ctx, r.data.item.id);
  });

  it("creates a person entity with person-specific fields", async () => {
    const person = createPerson({ source: ctx.source });
    const r = await client.createItem(person);
    expect(r.ok).toBe(true);
    expect(r.data.item.type).toBe("core.entity.person");
    expect(r.data.item.properties.name).toBe("Alice Smith");
    expect(r.data.item.properties.given_name).toBe("Alice");
    expect(r.data.item.properties.family_name).toBe("Smith");
    trackItem(ctx, r.data.item.id);
  });

  it("creates a place entity with place-specific fields", async () => {
    const place = createPlace({ source: ctx.source });
    const r = await client.createItem(place);
    expect(r.ok).toBe(true);
    expect(r.data.item.type).toBe("core.entity.place");
    expect(r.data.item.properties.name).toBe("The Ivy");
    expect(r.data.item.properties.latitude).toBe(51.5114);
    expect(r.data.item.properties.longitude).toBe(-0.1272);
    trackItem(ctx, r.data.item.id);
  });

  it("person inherits all entity fields", async () => {
    const person = createPerson({
      source: ctx.source,
      properties: {
        name: "Bob Jones",
        given_name: "Bob",
        family_name: "Jones",
        email: "bob@example.com",
        url: "https://bob.example.com",
        description: "A test person with inherited entity fields",
      },
    });
    const r = await client.createItem(person);
    expect(r.ok).toBe(true);
    expect(r.data.item.properties.url).toBe("https://bob.example.com");
    expect(r.data.item.properties.description).toBe(
      "A test person with inherited entity fields",
    );
    trackItem(ctx, r.data.item.id);
  });

  it("querying core.entity returns all entity subtypes", async () => {
    const entity = createEntity({ source: ctx.source });
    const person = createPerson({ source: ctx.source });
    const place = createPlace({ source: ctx.source });

    const re = await client.createItem(entity);
    expect(re.ok).toBe(true);
    trackItem(ctx, re.data.item.id);

    const rp = await client.createItem(person);
    expect(rp.ok).toBe(true);
    trackItem(ctx, rp.data.item.id);

    const rl = await client.createItem(place);
    expect(rl.ok).toBe(true);
    trackItem(ctx, rl.data.item.id);

    const list = await client.listItems({ type: "core.entity", limit: 100 });
    expect(list.ok).toBe(true);

    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(re.data.item.id);
    expect(ids).toContain(rp.data.item.id);
    expect(ids).toContain(rl.data.item.id);
  });

  it("querying core.entity.person returns only persons", async () => {
    const entity = createEntity({ source: ctx.source });
    const person = createPerson({ source: ctx.source });

    const re = await client.createItem(entity);
    expect(re.ok).toBe(true);
    trackItem(ctx, re.data.item.id);

    const rp = await client.createItem(person);
    expect(rp.ok).toBe(true);
    trackItem(ctx, rp.data.item.id);

    const list = await client.listItems({
      type: "core.entity.person",
      limit: 100,
    });
    expect(list.ok).toBe(true);

    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(rp.data.item.id);
    expect(ids).not.toContain(re.data.item.id);
  });

  it("rejects entity without required name with invalid_properties naming it", async () => {
    const r = await client.createItem({
      type: "core.entity",
      properties: { description: "Missing name" },
      source: ctx.source,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    const errors = r.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("name");
  });
});
