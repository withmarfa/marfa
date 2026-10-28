import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import {
  createBookmark,
  createNote,
  generateId,
} from "../../generators/items.js";

/**
 * A single create that asks never to overwrite (`items/create-only-source`,
 * `items/create-only-id`). The bulk door has had the mode since it was
 * written; this is the same name and the same values on `POST /items`.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let owner: MarfaClient;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "create-only",
  ));
  owner = getOwnerClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

interface Refusal {
  error: {
    code: string;
    details?: { existing_id?: string; matched_by?: string };
  };
}

/** A note written the ordinary way, tracked for clean-up. */
async function seed(
  overrides: Parameters<typeof createNote>[0] = {},
): Promise<{ id: string; version: number }> {
  const made = await client.createItem(createNote(overrides));
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return { id: made.data.item.id, version: made.data.item.version };
}

/** The item as stored, to show a refusal left it as it was. */
async function stored(id: string) {
  const read = await client.getItem(id);
  expect(read.ok).toBe(true);
  return read.data.item;
}

describe("a single create with mode create_only", () => {
  it("creates an item no one holds the keys of", async () => {
    const sourceId = `new-${generateId()}`;
    const made = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        mode: "create_only",
      }),
    );
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    expect(made.data.item.version).toBe(1);

    const id = generateId();
    const minted = await client.createItem(
      createNote({ id, mode: "create_only" }),
    );
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackItem(ctx, id);
    expect(minted.data.item.id).toBe(id);
  });

  it("refuses a source and source id an item holds, and leaves the item as it was", async () => {
    const sourceId = `held-${generateId()}`;
    const first = await seed({
      source: ctx.source,
      source_id: sourceId,
      properties: { body: "first" },
    });
    const before = await stored(first.id);

    const again = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "second" },
        mode: "create_only",
      }),
    );
    expect(again.status).toBe(409);
    const refusal = again.data as unknown as Refusal;
    expect(refusal.error.code).toBe("item_exists");
    expect(refusal.error.details).toMatchObject({
      existing_id: first.id,
      matched_by: "source_id",
    });
    expect(await stored(first.id)).toEqual(before);

    // The witness: the same request without the mode updates the item, so
    // the refusal above is the mode and not a create that could not write.
    const upserted = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        properties: { body: "second" },
      }),
    );
    expect(upserted.status).toBe(200);
    expect(upserted.data.item.version).toBe(first.version + 1);
  });

  it("refuses one that an item in the bin holds, and leaves it in the bin", async () => {
    const sourceId = `binned-${generateId()}`;
    const id = generateId();
    const first = await seed({
      id,
      source: ctx.source,
      source_id: sourceId,
    });
    expect((await client.deleteItem(first.id)).ok).toBe(true);
    // A create without the mode acknowledges a row in the bin and writes
    // nothing, which is how a key reads one.
    const inBin = async () => {
      const read = await client.createItem(
        createNote({ source: ctx.source, source_id: sourceId }),
      );
      expect(read.status).toBe(200);
      expect(read.data.acknowledged).toBe(true);
      return read.data.item;
    };
    const before = await inBin();
    expect(before.state).toBe("trashed");

    const byKey = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        mode: "create_only",
      }),
    );
    expect(byKey.status).toBe(409);
    expect(byKey.data as unknown as Refusal).toMatchObject({
      error: {
        code: "item_exists",
        details: { existing_id: first.id, matched_by: "source_id" },
      },
    });

    const byId = await client.createItem(
      createNote({ id, mode: "create_only" }),
    );
    expect(byId.status).toBe(409);
    expect(byId.data as unknown as Refusal).toMatchObject({
      error: {
        code: "item_exists",
        details: { existing_id: first.id, matched_by: "id" },
      },
    });
    expect(await inBin()).toEqual(before);
  });

  it("refuses an id an item holds, of any type, and leaves the item as it was", async () => {
    const id = generateId();
    const first = await seed({ id, properties: { body: "first" } });
    const before = await stored(first.id);

    const same = await client.createItem(
      createNote({ id, properties: { body: "second" }, mode: "create_only" }),
    );
    expect(same.status).toBe(409);
    expect(same.data as unknown as Refusal).toMatchObject({
      error: {
        code: "item_exists",
        details: { existing_id: id, matched_by: "id" },
      },
    });

    const other = await client.createItem(
      createBookmark({ id, mode: "create_only" }),
    );
    expect(other.status).toBe(409);
    expect((other.data as unknown as Refusal).error.code).toBe("item_exists");
    expect(await stored(id)).toEqual(before);

    // The witness: without the mode the repeat is acknowledged, and a
    // create of another type under the id is `id_reused`.
    const repeated = await client.createItem(createNote({ id }));
    expect(repeated.status).toBe(200);
    expect(repeated.data.acknowledged).toBe(true);
  });

  it("names the item its natural key resolves before the one its id names", async () => {
    const sourceId = `both-${generateId()}`;
    const byKey = await seed({ source: ctx.source, source_id: sourceId });
    const byId = await seed({});

    const refused = await client.createItem(
      createNote({
        id: byId.id,
        source: ctx.source,
        source_id: sourceId,
        mode: "create_only",
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.data as unknown as Refusal).toMatchObject({
      error: {
        code: "item_exists",
        details: { existing_id: byKey.id, matched_by: "source_id" },
      },
    });
  });

  it("creates one item when sends of one natural key arrive together", async () => {
    // Several rounds, because one round of a few sends can be served in
    // order by chance.
    const SENDS = 4;
    for (let round = 0; round < 10; round++) {
      const sourceId = `race-${generateId()}`;
      const sends = await Promise.all(
        Array.from({ length: SENDS }, (_, i) =>
          client.createItem(
            createNote({
              source: ctx.source,
              source_id: sourceId,
              properties: { body: `send ${String(i)}` },
              mode: "create_only",
            }),
          ),
        ),
      );
      const created = sends.filter((sent) => sent.status === 201);
      expect(created, JSON.stringify(sends.map((s) => s.status))).toHaveLength(
        1,
      );
      const [winner] = created as [(typeof created)[number]];
      trackItem(ctx, winner.data.item.id);
      for (const sent of sends.filter((s) => s !== winner)) {
        expect(sent.status).toBe(409);
        expect(sent.data as unknown as Refusal).toMatchObject({
          error: {
            code: "item_exists",
            details: { existing_id: winner.data.item.id },
          },
        });
      }
      const row = await stored(winner.data.item.id);
      expect(row.version).toBe(1);
    }
  });

  it("updates the item as before under mode upsert and under no mode", async () => {
    const sourceId = `upsert-${generateId()}`;
    const first = await seed({ source: ctx.source, source_id: sourceId });
    for (const [i, mode] of [undefined, "upsert" as const].entries()) {
      const sent = await client.createItem(
        createNote({
          source: ctx.source,
          source_id: sourceId,
          properties: { body: `again ${String(i)}` },
          ...(mode === undefined ? {} : { mode }),
        }),
      );
      expect(sent.status).toBe(200);
      expect(sent.data.item.id).toBe(first.id);
      expect(sent.data.item.version).toBe(first.version + i + 1);
    }
  });

  it("refuses a mode the door does not take", async () => {
    const refused = await client.rawRequest<Refusal>("/items", {
      method: "POST",
      body: { type: "core.note", properties: { body: "x" }, mode: "replace" },
    });
    expect(refused.status).toBe(400);
    expect(refused.data.error.code).toBe("validation_error");
  });

  it("answers a create repeated under one Idempotency-Key with its first answer, the item it created included", async () => {
    const sourceId = `replay-${generateId()}`;
    const key = `create-only-${ctx.runId}-${generateId()}`;
    const send = () =>
      client.rawRequest<{ item: { id: string; version: number } }>("/items", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          type: "core.note",
          properties: { body: "once" },
          source: ctx.source,
          source_id: sourceId,
          mode: "create_only",
        },
      });
    const first = await send();
    expect(first.status).toBe(201);
    trackItem(ctx, first.data.item.id);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();

    const repeat = await send();
    expect(repeat.status, "the repeat found the first send's own item").toBe(
      201,
    );
    expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
    expect(repeat.data.item.id).toBe(first.data.item.id);
    expect((await stored(first.data.item.id)).version).toBe(1);
  });

  it("replays the refusal of a create that found an item", async () => {
    const sourceId = `replay-refused-${generateId()}`;
    const held = await seed({ source: ctx.source, source_id: sourceId });
    const key = `create-only-${ctx.runId}-${generateId()}`;
    const send = () =>
      client.rawRequest<Refusal>("/items", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          type: "core.note",
          properties: { body: "refused" },
          source: ctx.source,
          source_id: sourceId,
          mode: "create_only",
        },
      });
    const first = await send();
    expect(first.status).toBe(409);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();

    const repeat = await send();
    expect(repeat.status).toBe(409);
    expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
    expect(repeat.data).toEqual(first.data);
    expect(repeat.data.error.details?.existing_id).toBe(held.id);
  });
});

describe("a create with mode create_only meeting an item the key may not read", () => {
  /** A key that writes notes alone, sharing a source with one that writes bookmarks. */
  async function keys(): Promise<{
    folder: string;
    writer: MarfaClient;
    notesOnly: MarfaClient;
  }> {
    const folder = `${ctx.source}-co-${generateId().slice(-8)}`;
    const mint = async (
      label: string,
      type_permissions: Record<string, string>,
    ): Promise<MarfaClient> => {
      const minted = await owner.createKey({
        label: `${label}-${generateId().slice(-6)}`,
        source: `${ctx.source}-${label}-${generateId().slice(-6)}`,
        sources: [folder],
        type_permissions,
      });
      expect(minted.status, `could not mint ${label}`).toBe(201);
      trackKey(ctx, minted.data.id);
      return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    };
    return {
      folder,
      writer: await mint("co-writer", {
        "core.note": "write",
        "core.bookmark": "write",
      }),
      notesOnly: await mint("co-notes", { "core.note": "write" }),
    };
  }

  const secret = { url: "https://example.com/hidden", title: "Hidden" };

  /** What a refusal names of the row, which it must not. */
  const disclosed = (answer: unknown, named: string[]): string[] => {
    const text = JSON.stringify(answer);
    return named.filter((name) => text.includes(name));
  };

  it("tells a key whose natural key an unreadable item holds nothing of the item", async () => {
    const { folder, writer, notesOnly } = await keys();
    const sourceId = `hidden-${generateId()}`;
    const made = await writer.createItem({
      type: "core.bookmark",
      source: folder,
      source_id: sourceId,
      properties: secret,
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);

    // The witness: the key that may read the bookmark is told which item
    // holds the key.
    const told = await writer.createItem({
      type: "core.bookmark",
      source: folder,
      source_id: sourceId,
      properties: secret,
      mode: "create_only",
    });
    expect(told.status).toBe(409);
    expect((told.data as unknown as Refusal).error.details?.existing_id).toBe(
      made.data.item.id,
    );

    const hidden = await notesOnly.createItem(
      createNote({ source: folder, source_id: sourceId, mode: "create_only" }),
    );
    expect(hidden.status).toBe(403);
    expect((hidden.data as unknown as Refusal).error.code).toBe(
      "type_not_permitted",
    );
    expect(
      disclosed(hidden.data, [
        made.data.item.id,
        "core.bookmark",
        secret.url,
        secret.title,
      ]),
    ).toEqual([]);
  });

  it("tells a key whose id an unreadable item holds nothing of the item", async () => {
    const { writer, notesOnly } = await keys();
    const id = generateId();
    const made = await writer.createItem({
      type: "core.bookmark",
      id,
      properties: secret,
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, id);

    const hidden = await notesOnly.createItem(
      createNote({ id, mode: "create_only" }),
    );
    expect(hidden.status).toBe(409);
    expect((hidden.data as unknown as Refusal).error.code).toBe("conflict");
    expect(
      disclosed(hidden.data, ["core.bookmark", secret.url, secret.title]),
    ).toEqual([]);
  });
});
