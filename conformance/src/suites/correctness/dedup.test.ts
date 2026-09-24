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

  it("refuses a create naming an id that is not the row its natural key resolves", async () => {
    const sourceId = `dedup-id-${generateId()}`;
    const first = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "first" },
      }),
    );
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    trackItem(ctx, first.data.item.id);

    const other = generateId();
    const refused = await client.createItem(
      createNote({
        id: other,
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "second" },
      }),
    );
    expect(
      refused.status,
      "a create naming one id and a key naming another row was written onto one of them",
    ).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details).toMatchObject({
      field: "id",
      requested_id: other,
      existing_id: first.data.item.id,
      source: ctx.source,
      source_id: sourceId,
    });
    const kept = await client.getItem(first.data.item.id);
    expect(kept.data.item.version, "the refused create wrote to the row").toBe(
      1,
    );
    expect((await client.getItem(other)).status).toBe(404);

    // The witness: the same create naming no id lands on the row the key
    // resolves, so the refusal is about the id.
    const landed = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "second" },
      }),
    );
    expect(landed.status, JSON.stringify(landed.error)).toBe(200);
    expect(landed.data.item.id).toBe(first.data.item.id);
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

  it("refuses an upsert whose natural key lands on a row of another type", async () => {
    // The other half of the split `id_reused` made: here the caller named
    // no id, resolved a row by `(source, source_id)`, and declared a type
    // that row is not. The id was never in question and the declaration
    // is the mistake, so the code is `type_mismatch` rather than the one
    // a reused id gets.
    const sourceId = `dedup-retype-${generateId()}`;
    const seed = await client.createItem(
      createNote({ source: ctx.source, source_id: sourceId }),
    );
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);

    const mismatched = await client.createItem({
      type: "core.task",
      source: ctx.source,
      source_id: sourceId,
      properties: { title: "landed on a note" },
    });
    expect(mismatched.status).toBe(409);
    expect(mismatched.error?.error.code).toBe("type_mismatch");

    // The witness, and the half that says the refusal was about the type
    // rather than about the natural key: the same upsert declaring the
    // row's own type lands on it.
    const accepted = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "upserted onto the note" },
      }),
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.data.item.id).toBe(seed.data.item.id);
    expect(accepted.data.item.type).toBe("core.note");
  });

  it("refuses an update declaring a type the item is not", async () => {
    // The update door's half of the same rule, and the third place
    // `type_mismatch` is answered. The path names the row, so the id was
    // never the caller's to get wrong; what disagrees is the declaration.
    const seed = await client.createItem(createNote({ source: ctx.source }));
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.item.id);

    const mismatched = await client.rawRequest<unknown>(
      `/items/${seed.data.item.id}`,
      {
        method: "PATCH",
        body: {
          type: "core.task",
          properties: { body: "still a note" },
          version: seed.data.item.version,
        },
      },
    );
    expect(mismatched.status).toBe(409);
    expect(mismatched.error?.error.code).toBe("type_mismatch");

    // The witness: the same update declaring the row's own type lands, so
    // the refusal is the declaration rather than the shape of the write.
    const accepted = await client.rawRequest<unknown>(
      `/items/${seed.data.item.id}`,
      {
        method: "PATCH",
        body: {
          type: "core.note",
          properties: { body: "still a note" },
          version: seed.data.item.version,
        },
      },
    );
    expect(accepted.status).toBe(200);
  });
});
