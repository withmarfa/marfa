import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "item-limits"));
});

afterAll(async () => {
  await cleanup(ctx);
});

const MAX_TAGS = 100;

function tagsOf(count: number, prefix = "t"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i)}`);
}

async function noteHolding(count: number): Promise<string> {
  const created = await client.createItem(
    createNote({ source: ctx.source, tags: tagsOf(count) }),
  );
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

async function tagsHeld(id: string): Promise<string[]> {
  const read = await client.rawRequest<{ metadata: { tags: string[] } }>(
    `/items/${id}?include=metadata`,
  );
  expect(read.ok).toBe(true);
  return read.data.metadata.tags;
}

describe("the 100-tags-per-item limit", () => {
  it("refuses a create carrying more than 100 tags, and takes one of 100", async () => {
    const sourceId = `limit-create-${generateId()}`;
    const refused = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        tags: tagsOf(MAX_TAGS + 1),
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");

    // Nothing was written: the same natural key is a create, not an upsert
    // onto a row the refusal left behind.
    const accepted = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        tags: tagsOf(MAX_TAGS),
      }),
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(201);
    trackItem(ctx, accepted.data.item.id);
    expect(accepted.data.metadata.tags).toHaveLength(MAX_TAGS);
    expect(new Set(await tagsHeld(accepted.data.item.id))).toEqual(
      new Set(tagsOf(MAX_TAGS)),
    );
  });

  it("refuses a tag write that would leave an item more than 100 tags, on each tag operation", async () => {
    // Each operation with a write that leaves 101 tags on a full item, and one
    // that leaves 100 on an item holding 99.
    const operations = [
      {
        name: "POST /items/{id}/tags",
        send: (id: string, tags: string[]) =>
          client.rawRequest(`/items/${id}/tags`, {
            method: "POST",
            body: { tags },
          }),
        over: ["one-more"],
        within: ["one-more"],
      },
      {
        name: "PATCH /items/{id}/metadata",
        send: (id: string, tags: string[]) =>
          client.rawRequest(`/items/${id}/metadata`, {
            method: "PATCH",
            body: { tags },
          }),
        over: ["one-more"],
        within: ["one-more"],
      },
      {
        name: "PUT /items/{id}/metadata",
        send: (id: string, tags: string[]) =>
          client.rawRequest(`/items/${id}/metadata`, {
            method: "PUT",
            body: { tags },
          }),
        over: tagsOf(MAX_TAGS + 1, "put"),
        within: tagsOf(MAX_TAGS, "put"),
      },
    ];
    const full = await noteHolding(MAX_TAGS);
    for (const { name, send, over } of operations) {
      const refused = await send(full, over);
      expect([refused.status, refused.error?.error.code], name).toEqual([
        400,
        "validation_error",
      ]);
      expect(
        new Set(await tagsHeld(full)),
        `${name} changed the tags of an item it refused`,
      ).toEqual(new Set(tagsOf(MAX_TAGS)));
    }

    // The witness: an item one tag short takes the same write on each
    // operation, so each refusal above is the limit.
    for (const { name, send, within } of operations) {
      const short = await noteHolding(MAX_TAGS - 1);
      expect((await send(short, within)).status, name).toBe(200);
      expect(await tagsHeld(short), name).toHaveLength(MAX_TAGS);
    }
  });
});
