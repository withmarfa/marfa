import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("correctness", "dedup"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("deduplication", () => {
  it("duplicate (source, source_id) upserts onto the existing item (natural-key upsert)", async () => {
    // The natural-key idempotency contract a retry-safe write relies on: a
    // create naming a (source, source_id) that already exists upserts onto
    // the existing row rather than refusing it.
    const dedupSourceId = `dedup-test-${generateId()}`;

    const r1 = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: dedupSourceId,
        properties: { body: "first version" },
      }),
    );
    expect(r1.ok).toBe(true);
    trackItem(ctx, r1.data.item.id);
    expect(r1.data.item.version).toBe(1);

    const r2 = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: dedupSourceId,
        properties: { body: "second version" },
      }),
    );

    expect(r2.ok).toBe(true);
    expect(r2.status).toBe(200);
    expect(r2.data.item.id).toBe(r1.data.item.id);
    expect(r2.data.item.version).toBe(r1.data.item.version + 1);
    expect(r2.data.item.properties.body).toBe("second version");
  });

  it("same source but different source_id is not a duplicate", async () => {
    const item1 = createNote({
      source: ctx.source,
      source_id: `unique-1-${generateId()}`,
    });
    const r1 = await client.createItem(item1);
    expect(r1.ok).toBe(true);
    trackItem(ctx, r1.data.item.id);

    const item2 = createNote({
      source: ctx.source,
      source_id: `unique-2-${generateId()}`,
    });
    const r2 = await client.createItem(item2);
    expect(r2.ok).toBe(true);
    trackItem(ctx, r2.data.item.id);

    expect(r2.data.item.id).not.toBe(r1.data.item.id);
  });

  it("items without source/source_id are never duplicates", async () => {
    const item1 = createNote({});
    const r1 = await client.createItem(item1);
    expect(r1.ok).toBe(true);
    trackItem(ctx, r1.data.item.id);

    const item2 = createNote({});
    const r2 = await client.createItem(item2);
    expect(r2.ok).toBe(true);
    trackItem(ctx, r2.data.item.id);

    expect(r2.data.item.id).not.toBe(r1.data.item.id);
  });
});
