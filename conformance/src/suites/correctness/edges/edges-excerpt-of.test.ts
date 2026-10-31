import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../../client/api.js";
import type { TestContext } from "../../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  cleanup,
} from "../../../utils/setup.js";
import { createHighlight, createNote } from "../../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "edges-excerpt-of",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeNote(label: string): Promise<string> {
  const r = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { body: `excerpt-${label}` },
    }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function makeHighlight(label: string): Promise<string> {
  const r = await client.createItem(
    createHighlight({
      source: ctx.source,
      properties: { text: `excerpt-${label}` },
    }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

async function link(source_id: string, target_id: string) {
  const r = await client.createEdge({
    source_id,
    target_id,
    edge_type: "excerpt-of",
  });
  if (r.ok) trackEdge(ctx, r.data.edge.id);
  return r;
}

async function listedIds(): Promise<string[]> {
  const r = await client.listItems({
    source: ctx.source,
    type: "core.highlight",
    limit: 100,
  });
  expect(r.ok).toBe(true);
  return r.data.data.map((i) => i.id);
}

describe("excerpt-of", () => {
  it("is many-to-one: an item has many excerpts and an excerpt has one source", async () => {
    const book = await makeNote("book");
    const otherBook = await makeNote("other-book");
    const first = await makeHighlight("first");
    const second = await makeHighlight("second");

    expect((await link(first, book)).ok).toBe(true);
    // The witness: a second excerpt of the same source is taken.
    expect((await link(second, book)).ok).toBe(true);

    const again = await link(first, otherBook);
    expect(again.ok).toBe(false);
    expect(again.status).toBe(400);
    expect(again.error?.error.code).toBe("edge_constraint_violation");
    expect(again.error?.error.details?.constraint).toBe("cardinality");
  });

  it("leaves the excerpt in lists and active when its source is binned", async () => {
    const book = await makeNote("binned-book");
    const highlight = await makeHighlight("binned");
    expect((await link(highlight, book)).ok).toBe(true);
    expect(await listedIds()).toContain(highlight);

    expect((await client.deleteItem(book)).ok).toBe(true);

    const fetched = await client.getItem(highlight);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.state).toBe("active");
    expect(await listedIds()).toContain(highlight);
  });

  it("leaves the excerpt in lists and active when its source is purged", async () => {
    const book = await makeNote("purged-book");
    const highlight = await makeHighlight("purged");
    expect((await link(highlight, book)).ok).toBe(true);

    expect((await client.deleteItem(book)).ok).toBe(true);
    const purged = await client.purgeItem(book);
    expect(purged.status, JSON.stringify(purged.error)).toBe(200);

    // The witness: the source is gone.
    expect((await client.getItem(book)).status).toBe(404);
    const fetched = await client.getItem(highlight);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.state).toBe("active");
    expect(await listedIds()).toContain(highlight);
  });
});
