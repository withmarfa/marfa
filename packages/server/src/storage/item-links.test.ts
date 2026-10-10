import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemWrites } from "./item-writes.js";
import { MarfaError } from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";
import { createTestContext, sweepTrashBefore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// The link index and tombstones where a fixture cannot reach: the trash
// sweep ages rows by days, and no door reads a deleted type's tombstones.

let ctx: TestContext;
let seq = 0;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

async function linkedType(
  extra: Partial<TypeSchema> = {},
): Promise<TypeSchema> {
  seq += 1;
  const schema: TypeSchema = {
    id: `user.linked-${String(seq)}-${String(Date.now())}`,
    version: 1,
    fields: {
      vendor_id: { type: "string" },
      body: { type: "string" },
    },
    link_field: "vendor_id",
    ...extra,
  };
  return ctx.storage.types.create(schema);
}

async function refusal(write: Promise<unknown>): Promise<MarfaError> {
  try {
    await write;
  } catch (err) {
    if (err instanceof MarfaError) return err;
    throw err;
  }
  throw new Error("the write was not refused");
}

describe("the link index", () => {
  it("is built when a type gains a link, and the type is refused one its rows share", async () => {
    const plain = await linkedType({ link_field: undefined });
    const a = await itemWrites(ctx.storage).create({
      writer: null,
      type: plain.id,
      properties: { vendor_id: "v-1", body: "a" },
      source: "test",
    });
    const b = await itemWrites(ctx.storage).create({
      writer: null,
      type: plain.id,
      properties: { vendor_id: "v-1", body: "b" },
      source: "test",
    });
    // The witness: with no link named, two rows hold one value freely.
    expect(a.id).not.toBe(b.id);

    const refused = await refusal(
      ctx.storage.types.update(plain.id, {
        ...plain,
        version: 2,
        link_field: "vendor_id",
      }),
    );
    expect(refused.code).toBe("link_taken");
    expect(refused.details).toEqual({ type: plain.id, field: "vendor_id" });
    expect((await ctx.storage.types.get(plain.id))?.link_field).toBeUndefined();

    await itemWrites(ctx.storage).update(b.id, {
      writer: null,
      properties: { vendor_id: "v-2" },
    });
    await ctx.storage.types.update(plain.id, {
      ...plain,
      version: 2,
      link_field: "vendor_id",
    });
    const found = await ctx.storage.items.findByLinks(plain.id, ["v-1", "v-2"]);
    expect(found.get("v-1")?.id).toBe(a.id);
    expect(found.get("v-2")?.id).toBe(b.id);
    const third = await refusal(
      itemWrites(ctx.storage).create({
        writer: null,
        type: plain.id,
        properties: { vendor_id: "v-1", body: "c" },
        source: "test",
      }),
    );
    expect(third.code).toBe("link_taken");
    expect(third.details?.existing_id).toBe(a.id);
  });

  it("keeps the link off a keep-both copy of a linked row", async () => {
    const type = await linkedType({
      merge_policy: { fields: { body: "keep_both_copies" } },
    });
    const row = await itemWrites(ctx.storage).create({
      writer: null,
      type: type.id,
      properties: { vendor_id: "copied", body: "as written" },
      source: "test",
    });
    await itemWrites(ctx.storage).update(row.id, {
      writer: null,
      properties: { body: "changed here" },
      version: 1,
      may_read_type: () => true,
    });
    const resolved = await itemWrites(ctx.storage).update(row.id, {
      writer: null,
      properties: { body: "changed there" },
      version: 1,
      may_read_type: () => true,
      conflict_mode: "auto",
    });
    if ("error" in resolved) throw new Error(JSON.stringify(resolved));
    const sibling = resolved.conflict_sibling;
    // The witness: the copy exists and carries the losing body.
    expect(sibling?.properties.body).toBe("changed there");
    expect(sibling?.properties).not.toHaveProperty("vendor_id");
    const found = await ctx.storage.items.findByLinks(type.id, ["copied"]);
    expect(found.get("copied")?.id).toBe(row.id);
  });
});

describe("the timed trash sweep", () => {
  it("leaves a tombstone for a row's link and its natural key", async () => {
    const type = await linkedType();
    const row = await itemWrites(ctx.storage).create({
      writer: null,
      type: type.id,
      properties: { vendor_id: "swept", body: "b" },
      source: "sweep-source",
      source_id: "sweep-1",
    });
    await itemWrites(ctx.storage).delete(row.id);
    const before = await ctx.storage.items.tombstones(type.id, {
      links: ["swept"],
    });
    // The witness: a trashed row still holds its link and leaves nothing.
    expect(before).toEqual([]);
    expect(
      (await ctx.storage.items.findByLinks(type.id, ["swept"])).get("swept")
        ?.state,
    ).toBe("trashed");

    const purged = await sweepTrashBefore(
      ctx.storage,
      "2999-01-01T00:00:00.000Z",
    );
    expect(purged).toBeGreaterThanOrEqual(1);

    const [link] = await ctx.storage.items.tombstones(type.id, {
      links: ["swept"],
    });
    expect(link?.key).toBe("swept");
    expect(link?.settled_at).toBe(link?.purged_at);
    const [naturalKey] = await ctx.storage.items.tombstones(type.id, {
      source: "sweep-source",
      source_ids: ["sweep-1"],
    });
    expect(naturalKey?.key).toBe("sweep-1");
    expect(naturalKey?.purged_at).toBe(link?.purged_at);
    // The swept row's link entry went with it, so the value is free.
    const again = await itemWrites(ctx.storage).create({
      writer: null,
      type: type.id,
      properties: { vendor_id: "swept", body: "again" },
      source: "test",
    });
    expect(
      (await ctx.storage.items.findByLinks(type.id, ["swept"])).get("swept")
        ?.id,
    ).toBe(again.id);
  });

  it("leaves a registered-again type none of the tombstones its orphaned rows left", async () => {
    const type = await linkedType();
    const orphan = await itemWrites(ctx.storage).create({
      writer: null,
      type: type.id,
      properties: { vendor_id: "orphaned", body: "b" },
      source: "orphan-source",
      source_id: "orphan-1",
    });
    await itemWrites(ctx.storage).delete(orphan.id);
    await ctx.storage.types.delete(type.id);
    await sweepTrashBefore(ctx.storage, "2999-01-01T00:00:00.000Z");
    const byKey = { source: "orphan-source", source_ids: ["orphan-1"] };
    // The witness: the sweep left one under the identifier no type holds.
    expect(await ctx.storage.items.tombstones(type.id, byKey)).toHaveLength(1);

    await ctx.storage.types.create(type);
    expect(await ctx.storage.items.tombstones(type.id, byKey)).toEqual([]);
  });
});

describe("deleting a type", () => {
  async function keptUnder(type: string): Promise<string[]> {
    const storage = ctx.storage as unknown as {
      __sqliteAll: (query: string) => Promise<unknown[]>;
    };
    const quoted = `'${type.replace(/'/g, "''")}'`;
    return [
      ...(await storage.__sqliteAll(
        `SELECT value AS key FROM link_tombstones WHERE type = ${quoted}`,
      )),
      ...(await storage.__sqliteAll(
        `SELECT source_id AS key FROM natural_key_tombstones WHERE type = ${quoted}`,
      )),
    ].map((row) => (row as { key: string }).key);
  }

  it("takes the type's tombstones with it", async () => {
    const type = await linkedType();
    const row = await itemWrites(ctx.storage).create({
      writer: null,
      type: type.id,
      properties: { vendor_id: "deleted-with", body: "b" },
      source: "delete-source",
      source_id: "delete-1",
    });
    await itemWrites(ctx.storage).delete(row.id);
    await itemWrites(ctx.storage).purge(row.id);
    // The witness: the purge left one of each under the type.
    expect(await keptUnder(type.id)).toEqual(["deleted-with", "delete-1"]);

    await ctx.storage.types.delete(type.id);
    expect(await keptUnder(type.id)).toEqual([]);
  });
});
