import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../../utils/setup.js";
import { createNote } from "../../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "edges-query"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `eq-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("edge query filters on /items", () => {
  it("edge[about]=<id> shorthand returns items with outbound about edge to id", async () => {
    const target = await makeItem("eq-target");
    const a = await client.createItem({
      type: "core.note",
      properties: { body: "a" },
      source: ctx.source,
      edges: { about: [target] },
    });
    expect(a.ok).toBe(true);
    trackItem(ctx, a.data.item.id);
    const b = await client.createItem({
      type: "core.note",
      properties: { body: "b" },
      source: ctx.source,
      edges: { about: [target] },
    });
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);
    const c = await makeItem("c-notlinked");

    for (const item of [a.data.item, b.data.item]) {
      for (const section of Object.values(item.edges ?? {})) {
        for (const edge of section.data) trackEdge(ctx, edge.id);
      }
    }

    const matches = await client.listItems({
      type: "core.note",
      edge: { about: target },
      limit: 50,
    });
    expect(matches.ok).toBe(true);
    const ids = matches.data.data.map((i) => i.id);
    expect(ids).toContain(a.data.item.id);
    expect(ids).toContain(b.data.item.id);
    expect(ids).not.toContain(c);
    expect(ids).not.toContain(target);
  });

  it('filter=edge[X] eq "Y" full form returns the same set', async () => {
    const target = await makeItem("filter-target");
    const source = await client.createItem({
      type: "core.note",
      properties: { body: "filter-source" },
      source: ctx.source,
      edges: { about: [target] },
    });
    expect(source.ok).toBe(true);
    trackItem(ctx, source.data.item.id);
    for (const section of Object.values(source.data.item.edges ?? {})) {
      for (const edge of section.data) trackEdge(ctx, edge.id);
    }

    const r = await client.listItems({
      type: "core.note",
      filter: `edge[about] eq "${target}"`,
      limit: 50,
    });
    expect(r.ok).toBe(true);
    const ids = r.data.data.map((i) => i.id);
    expect(ids).toContain(source.data.item.id);
  });

  it("combines edge filter with type to narrow results", async () => {
    const target = await makeItem("combo-target");
    const noteLinked = await client.createItem({
      type: "core.note",
      properties: { body: "note-linked" },
      source: ctx.source,
      edges: { about: [target] },
    });
    expect(noteLinked.ok).toBe(true);
    trackItem(ctx, noteLinked.data.item.id);
    for (const section of Object.values(noteLinked.data.item.edges ?? {})) {
      for (const edge of section.data) trackEdge(ctx, edge.id);
    }

    const taskLinked = await client.createItem({
      type: "core.task",
      properties: { title: "task-linked" },
      source: ctx.source,
      edges: { about: [target] },
    });
    expect(taskLinked.ok).toBe(true);
    trackItem(ctx, taskLinked.data.item.id);
    for (const section of Object.values(taskLinked.data.item.edges ?? {})) {
      for (const edge of section.data) trackEdge(ctx, edge.id);
    }

    const list = await client.listItems({
      type: "core.note",
      edge: { about: target },
      limit: 50,
    });
    expect(list.ok).toBe(true);
    const ids = list.data.data.map((i) => i.id);
    expect(ids).toContain(noteLinked.data.item.id);
    expect(ids).not.toContain(taskLinked.data.item.id);
    for (const item of list.data.data) expect(item.type).toBe("core.note");
  });
});
