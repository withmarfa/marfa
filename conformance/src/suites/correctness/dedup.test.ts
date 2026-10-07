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

  it("applies a create naming the id and the natural key of one row as an upsert onto it", async () => {
    const sourceId = `dedup-both-${generateId()}`;
    const id = generateId();
    const body = (text: string) =>
      createNote({
        id,
        source: ctx.source,
        source_id: sourceId,
        properties: { body: text },
      });

    const first = await client.createItem(body("sent"));
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    trackItem(ctx, id);
    expect(first.data.item.version).toBe(1);

    // The repeat with nothing between: an upsert, not an acknowledgement.
    const repeat = await client.createItem(body("sent"));
    expect(repeat.status, JSON.stringify(repeat.error)).toBe(200);
    expect(repeat.data.item.id).toBe(id);
    expect(repeat.data.item.version).toBe(2);
    expect(repeat.data).not.toHaveProperty("acknowledged");

    // An edit made at version 1 is overwritten by the repeat's properties.
    const edited = await client.updateItem(id, {
      properties: { body: "edited" },
      version: 2,
    });
    expect(edited.status, JSON.stringify(edited.error)).toBe(200);
    expect(edited.data.item.properties.body).toBe("edited");

    // The contrast: a repeat naming only the id is acknowledged with the row
    // as it stands, and keeps the edit.
    const acknowledged = await client.createItem(
      createNote({
        id,
        source: ctx.source,
        properties: { body: "sent" },
      }),
    );
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.data.acknowledged).toBe(true);
    expect(acknowledged.data.item.properties.body).toBe("edited");
    expect(acknowledged.data.item.version).toBe(edited.data.item.version);

    const overwritten = await client.createItem(body("sent"));
    expect(overwritten.status, JSON.stringify(overwritten.error)).toBe(200);
    expect(overwritten.data).not.toHaveProperty("acknowledged");
    expect(overwritten.data.item.properties.body).toBe("sent");
    expect(overwritten.data.item.version).toBe(edited.data.item.version + 1);
    const read = await client.getItem(id);
    expect(read.data.item.properties.body).toBe("sent");
  });

  it("merges a natural-key upsert's properties over the row's, and keeps its tags unless it names them", async () => {
    const sourceId = `dedup-merge-${generateId()}`;
    const upsert = (properties: Record<string, unknown>, tags?: string[]) =>
      client.createItem(
        createNote({
          source: ctx.source,
          source_id: sourceId,
          properties,
          ...(tags === undefined ? {} : { tags }),
        }),
      );

    const first = await upsert({ title: "kept", body: "old" }, ["a"]);
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    trackItem(ctx, first.data.item.id);
    const id = first.data.item.id;

    const second = await upsert({ body: "new" });
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    expect(second.data.item.id).toBe(id);
    expect(second.data.item.properties).toEqual({
      title: "kept",
      body: "new",
    });
    expect(second.data.metadata.tags).toEqual(["a"]);

    const third = await upsert({ body: "new" }, ["b"]);
    expect(third.status, JSON.stringify(third.error)).toBe(200);
    expect(third.data.metadata.tags).toEqual(["b"]);

    const read = await client.rawRequest<{
      item: { properties: Record<string, unknown> };
      metadata: { tags: string[] };
    }>(`/items/${id}?include=metadata`);
    expect(read.data.metadata.tags).toEqual(["b"]);
    expect(read.data.item.properties).toEqual({ title: "kept", body: "new" });
  });

  it("lands concurrent creates of one natural key on one row", async () => {
    // Two devices sharing a claim, or a connector retrying in parallel: every
    // send is answered as the upsert, and none is refused. Several rounds,
    // because one round of a few sends can be served in order by chance.
    const SENDS = 4;
    for (let round = 0; round < 10; round++) {
      const sourceId = `dedup-race-${generateId()}`;
      const sends = await Promise.all(
        Array.from({ length: SENDS }, (_, i) =>
          client.createItem(
            createNote({
              source: ctx.source,
              source_id: sourceId,
              properties: { body: `send ${String(i)}` },
            }),
          ),
        ),
      );
      for (const sent of sends) {
        expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
      }
      const ids = new Set(sends.map((sent) => sent.data.item.id));
      expect(ids.size).toBe(1);
      const [id] = [...ids] as [string];
      trackItem(ctx, id);
      expect(sends.filter((sent) => sent.status === 201)).toHaveLength(1);
      const versions = sends
        .map((sent) => sent.data.item.version)
        .sort((a, b) => a - b);
      expect(versions).toEqual([1, 2, 3, 4]);
    }
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
