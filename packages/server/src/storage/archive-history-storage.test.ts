import { afterAll, describe, expect, it } from "vitest";
import type { Version } from "@withmarfa/shared";
import {
  archiveDates,
  archiveVersions,
} from "../routes/restore-archive-history.js";
import {
  createTestContext,
  closeTestContexts,
  type TestContext,
} from "../test-utils.js";
import { itemWrites } from "./item-writes.js";
import type { SqliteVersionStore } from "./sqlite/version-store.js";

const contexts: TestContext[] = [];
async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}
afterAll(() => closeTestContexts(contexts));

function store(ctx: TestContext): SqliteVersionStore {
  return ctx.storage.versions as SqliteVersionStore;
}

function snapshots(itemId: string): Version[] {
  return [1, 2].map((version) => ({
    id: `01912345-0000-7000-8000-00000000000${String(version)}`,
    item_id: itemId,
    version,
    properties: { obsolete_field: [version, null, { preserved: true }] },
    type: "user.retired_type",
    tier: "feed",
    occurred_at: "2020-02-29T12:34:56.789+02:00",
    source_id: version === 1 ? "old-source" : null,
    writer: version === 1 ? { kind: "key", id: "a-key", name: "A key" } : null,
    created_at: "2023-05-06T01:02:03.456Z",
  }));
}

async function note(ctx: TestContext) {
  return itemWrites(ctx.storage).create({
    type: "core.note",
    properties: { body: "current" },
    version: 3,
  });
}

describe("archive history storage", () => {
  it("stores every historical field exactly without requiring the historical type's current schema", async () => {
    const ctx = await context();
    const item = await note(ctx);
    const original = snapshots(item.id);
    const validated = archiveVersions(
      item as unknown as Record<string, unknown>,
      original,
      0,
      new Set(),
    );
    expect(validated).toEqual(original);
    await store(ctx).restore(validated);
    expect(await ctx.storage.versions.all(item.id)).toEqual(original);
    expect(await ctx.storage.items.get(item.id)).toEqual(item);
    expect(
      archiveDates(
        "item",
        {
          id: item.id,
          created_at: original[0]!.occurred_at,
          updated_at: original[0]!.created_at,
        },
        0,
      ),
    ).toEqual({
      created_at: "2020-02-29T10:34:56.789Z",
      updated_at: original[0]!.created_at,
    });
  });

  it("rejects an impossible archived date before storing any snapshot", async () => {
    const ctx = await context();
    const item = await note(ctx);
    const history = snapshots(item.id);
    history[1]!.created_at = "2020-02-30T00:00:00.000Z";
    expect(() =>
      archiveVersions(
        item as unknown as Record<string, unknown>,
        history,
        0,
        new Set(),
      ),
    ).toThrow("created_at must be a valid instant");
    expect(await ctx.storage.versions.all(item.id)).toHaveLength(0);
  });

  it("rolls back earlier snapshots on an unrelated snapshot ID collision", async () => {
    const ctx = await context();
    const item = await note(ctx);
    const unrelated = await note(ctx);
    const incoming = snapshots(item.id);
    const existing = { ...incoming[1]!, item_id: unrelated.id };
    await store(ctx).restore([existing]);
    expect(await ctx.storage.versions.all(unrelated.id)).toEqual([existing]);
    await expect(store(ctx).restore(incoming)).rejects.toMatchObject({
      code: "conflict",
      details: { snapshot_id: existing.id },
    });
    expect(await ctx.storage.versions.all(item.id)).toHaveLength(0);
    expect(await ctx.storage.versions.all(unrelated.id)).toEqual([existing]);
  });

  it("propagates a native insert failure and rolls back an earlier snapshot", async () => {
    const ctx = await context();
    const item = await note(ctx);
    const sql = ctx.storage as typeof ctx.storage & {
      __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
    };
    await sql.__sqliteRun(
      "CREATE TRIGGER refuse_second_history BEFORE INSERT ON versions WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'native history failure'); END",
      [],
    );
    const failure: unknown = await store(ctx)
      .restore(snapshots(item.id))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ code: "conflict" });
    expect(await ctx.storage.versions.all(item.id)).toHaveLength(0);
    expect(await ctx.storage.items.get(item.id)).toEqual(item);
  });

  it("joins the enclosing row transaction so a later failure undoes restored history", async () => {
    const ctx = await context();
    const item = await note(ctx);
    await expect(
      ctx.storage.runInTransaction(async () => {
        await store(ctx).restore(snapshots(item.id));
        expect(await ctx.storage.versions.all(item.id)).toHaveLength(2);
        throw new Error("later restore failure");
      }),
    ).rejects.toThrow("later restore failure");
    expect(await ctx.storage.versions.all(item.id)).toHaveLength(0);
  });
});
