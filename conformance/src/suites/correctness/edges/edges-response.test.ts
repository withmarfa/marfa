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
import { expectMatchesSchema } from "../../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "edges-response"));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeItem(label: string = ""): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, properties: { body: `resp-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("edge response hydration + pagination", () => {
  it("GET /items/:id returns hydrated edges keyed by edge_type, each block a page", async () => {
    const subject = await makeItem("subject");
    const t1 = await makeItem("t1");
    const t2 = await makeItem("t2");
    const author = await makeItem("author");

    const eA = await client.createEdge({
      source_id: subject,
      target_id: t1,
      edge_type: "about",
    });
    expect(eA.ok).toBe(true);
    trackEdge(ctx, eA.data.edge.id);
    const eB = await client.createEdge({
      source_id: subject,
      target_id: t2,
      edge_type: "about",
    });
    expect(eB.ok).toBe(true);
    trackEdge(ctx, eB.data.edge.id);
    const eAuthor = await client.createEdge({
      source_id: subject,
      target_id: author,
      edge_type: "authored-by",
    });
    expect(eAuthor.ok).toBe(true);
    trackEdge(ctx, eAuthor.data.edge.id);

    const fetched = await client.getItem(subject);
    expect(fetched.ok).toBe(true);
    await expectMatchesSchema("GET", "/items/{id}", 200, fetched.data);
    const edges = fetched.data.item.edges;
    expect(edges).toBeDefined();
    expect(Object.keys(edges!).sort()).toContain("about");
    expect(Object.keys(edges!).sort()).toContain("authored-by");
    expect(edges!.about.data.length).toBe(2);
    expect(edges!.about.next_cursor).toBeNull();
    expect(edges!["authored-by"].data.length).toBe(1);
  });

  it("per-type hydration caps a block and carries a next_cursor when over the limit", async () => {
    const subject = await makeItem("big");

    // The server hydrates at most 50 edges per type on an item read.
    const HYDRATION_CAP = 50;
    const SEED = 55;
    for (let i = 0; i < SEED; i++) {
      const t = await makeItem(`t${i}`);
      const e = await client.createEdge({
        source_id: subject,
        target_id: t,
        edge_type: "about",
      });
      expect(e.ok).toBe(true);
      trackEdge(ctx, e.data.edge.id);
    }

    const fetched = await client.getItem(subject);
    expect(fetched.ok).toBe(true);
    const about = fetched.data.item.edges!.about;
    expect(about.data.length).toBe(HYDRATION_CAP);
    expect(about.next_cursor).not.toBeNull();
    expect(typeof about.next_cursor).toBe("string");

    // The block is the first page of the listing: its cursor continues it
    // at the same door, narrowed to the block's edge type, and the two
    // together deliver every edge once.
    const collected = new Set<string>(about.data.map((e) => e.id));
    let cursor: string | undefined = about.next_cursor!;
    for (let iter = 0; iter < 20; iter++) {
      const page = await client.listItemEdges(subject, {
        edge_type: "about",
        limit: 25,
        cursor,
      });
      expect(page.ok).toBe(true);
      await expectMatchesSchema("GET", "/items/{id}/edges", 200, page.data);
      for (const e of page.data.data) collected.add(e.id);
      if (page.data.next_cursor === null) break;
      cursor = page.data.next_cursor;
    }
    expect(collected.size).toBe(SEED);
  });

  it("answers 404 for an unknown item and 400 for a malformed id", async () => {
    const unknown = await client.listItemEdges(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("item_not_found");
    const malformed = await client.listItemEdges("not-an-id");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("invalid_id");
  });
});
