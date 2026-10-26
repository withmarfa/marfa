import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  trackItem,
  trackEdge,
} from "../../utils/setup.js";
import { createNote, createTask, createAlbum } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "core-collection"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeCollection(properties: Record<string, unknown>) {
  const r = await client.createItem({
    type: "core.collection",
    source: ctx.source,
    properties,
  });
  if (r.ok) trackItem(ctx, r.data.item.id);
  return r;
}

describe("core.collection", () => {
  it("declares the container role, title required and description optional", async () => {
    const t = await client.getType("core.collection");
    expect(t.ok).toBe(true);
    expect(t.data.parent).toBeUndefined();
    expect(t.data.roles).toEqual(["container"]);
    expect(t.data.fields.title.required).toBe(true);
    expect(t.data.fields.description.required).toBeUndefined();
  });

  it("creates with only a title", async () => {
    const r = await makeCollection({ title: "Reading list" });
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    expect(r.data.item.properties).toEqual({ title: "Reading list" });
  });

  it("refuses a collection with no title, naming it", async () => {
    // The witness: the same write with a title is accepted, so the refusal
    // is the missing title and not the type.
    const witness = await makeCollection({
      title: "Trip",
      description: "Everything for the trip",
    });
    expect(witness.status, JSON.stringify(witness.error)).toBe(201);

    const r = await makeCollection({ description: "Everything for the trip" });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(JSON.stringify(r.error?.error.details)).toContain("title");
  });

  it("holds items of any type through in-collection", async () => {
    const made = await makeCollection({ title: "Project" });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const collection = made.data.item.id;

    const members: string[] = [];
    for (const input of [
      createNote({ source: ctx.source }),
      createTask({ source: ctx.source }),
      createAlbum({ source: ctx.source }),
    ]) {
      const item = await client.createItem(input);
      expect(item.status, JSON.stringify(item.error)).toBe(201);
      trackItem(ctx, item.data.item.id);
      members.push(item.data.item.id);
    }
    // An album is a container, so it cannot be a member; the note and the
    // task can.
    const [note, task, album] = members;
    for (const source of [note, task]) {
      const edge = await client.createEdge({
        source_id: source,
        target_id: collection,
        edge_type: "in-collection",
      });
      expect(edge.status, JSON.stringify(edge.error)).toBe(201);
      trackEdge(ctx, edge.data.edge.id);
    }
    const nested = await client.createEdge({
      source_id: album,
      target_id: collection,
      edge_type: "in-collection",
    });
    expect(nested.status).toBe(400);
    expect(nested.error?.error.details?.constraint).toBe("nesting");
  });
});
