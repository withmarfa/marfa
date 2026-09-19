import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "correctness",
    "items-source-id-mutation",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("PATCH /items/:id source_id mutation", () => {
  it("mutates source_id, returns 200, and round-trips on subsequent GET", async () => {
    const originalSourceId = `original-${generateId()}`;
    const newSourceId = `mutated-${generateId()}`;

    const created = await client.createItem(
      createNote({ source: ctx.source, source_id: originalSourceId }),
    );
    expect(created.ok).toBe(true);
    const itemId = created.data.item.id;
    trackItem(ctx, itemId);
    expect(created.data.item.source_id).toBe(originalSourceId);

    const patched = await client.updateItem(itemId, {
      source_id: newSourceId,
      version: created.data.item.version,
    });
    expect(patched.ok).toBe(true);
    expect(patched.status).toBe(200);
    expect(patched.data.item.source_id).toBe(newSourceId);

    const fetched = await client.getItem(itemId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.source_id).toBe(newSourceId);
  });
});
