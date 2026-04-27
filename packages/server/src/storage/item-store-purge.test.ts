import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

const MS_PER_DAY = 86_400_000;
const FIXED_NOW = new Date("2026-04-15T12:00:00.000Z");

const id = (suffix: string): string =>
  `019d0000-0000-7000-a000-${suffix.padStart(12, "0")}`;

const isPg = (): boolean => (process.env.STORAGE_DIALECT ?? "sqlite") === "pg";

/**
 * Returns the FTS row count for an item id. Always 0 on Postgres (no FTS
 * table — tsvectors are computed at query time). On SQLite, queries the
 * items_fts virtual table directly.
 */
function ftsRowCount(itemId: string): number {
  if (isPg()) return 0;
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => unknown[];
  };
  // ids are well-formed UUIDv7 hex+hyphens; safe to interpolate in this
  // test-only context (the escape hatch doesn't bind params).
  const rows = s.__sqliteAll(
    `SELECT 1 FROM items_fts WHERE item_id = '${itemId.replace(/'/g, "''")}'`,
  );
  return rows.length;
}

/**
 * Forces an item's `updated_at` to a given ISO timestamp via the dialect-
 * specific escape hatch, so retention tests can choose timestamps freely
 * (the route layer always stamps `now`).
 */
async function setUpdatedAt(itemId: string, isoDate: string): Promise<void> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(`UPDATE items SET updated_at = $1 WHERE id = $2`, [
      isoDate,
      itemId,
    ]);
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => unknown;
    };
    s.__sqliteRun("UPDATE items SET updated_at = ? WHERE id = ?", [
      isoDate,
      itemId,
    ]);
  }
}

describe("ItemStore purge methods — FTS coverage", () => {
  it("bulkPurge removes items and their FTS entries", async () => {
    const itemId = id("aaa1");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { body: "alphabravo searchable" },
        tier: "library",
      },
      undefined,
    );

    // Sanity-check the item is searchable before purge.
    const before = await ctx.storage.search.search("alphabravo", {});
    expect(before.some((h) => h.item.id === itemId)).toBe(true);

    const deleted = await ctx.storage.items.bulkPurge([itemId]);
    expect(deleted).toBe(1);

    // SQLite: FTS row gone. PG: vacuously 0.
    expect(ftsRowCount(itemId)).toBe(0);

    const after = await ctx.storage.search.search("alphabravo", {});
    expect(after.some((h) => h.item.id === itemId)).toBe(false);
  });

  it("purgeTrashedOlderThan removes FTS entries for purged trashed items", async () => {
    const itemId = id("aaa2");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { body: "charliedelta searchable" },
        tier: "library",
      },
      undefined,
    );
    await ctx.storage.items.transition(itemId, "trashed", undefined);
    // Force updated_at well before our cutoff.
    await setUpdatedAt(
      itemId,
      new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY).toISOString(),
    );

    const deleted = await ctx.storage.items.purgeTrashedOlderThan(
      FIXED_NOW.toISOString(),
    );
    expect(deleted).toBe(1);

    expect(ftsRowCount(itemId)).toBe(0);

    const after = await ctx.storage.search.search("charliedelta", {});
    expect(after.some((h) => h.item.id === itemId)).toBe(false);
  });

  it("expireFeedOlderThan removes FTS entries for expired feed items", async () => {
    const itemId = id("aaa3");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { body: "echofoxtrot searchable" },
        tier: "feed",
      },
      undefined,
    );
    await setUpdatedAt(
      itemId,
      new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY).toISOString(),
    );

    const deleted = await ctx.storage.items.expireFeedOlderThan(
      FIXED_NOW.toISOString(),
    );
    expect(deleted).toBe(1);

    expect(ftsRowCount(itemId)).toBe(0);

    const after = await ctx.storage.search.search("echofoxtrot", {});
    expect(after.some((h) => h.item.id === itemId)).toBe(false);
  });
});

describe("ItemStore.bulkPurge — atomicity", () => {
  // SQLite is the only dialect with a real FTS desync risk: the items_fts
  // virtual table is mutated separately from the items table, so without a
  // transaction a mid-purge failure would leave items present but unsearchable.
  // Postgres computes tsvectors at query time, so its searchStore.remove() is
  // a no-op and there's nothing to drift. This test covers SQLite.
  it.skipIf(isPg())(
    "rolls back the items DELETE if a mid-purge FTS removal fails",
    async () => {
      const id1 = id("bbb1");
      const id2 = id("bbb2");
      await ctx.storage.items.create(
        {
          id: id1,
          type: "core.note",
          properties: { body: "rollbackalpha searchable" },
          tier: "library",
        },
        undefined,
      );
      await ctx.storage.items.create(
        {
          id: id2,
          type: "core.note",
          properties: { body: "rollbackbravo searchable" },
          tier: "library",
        },
        undefined,
      );

      // Force the second FTS removal to throw, mid-transaction.
      const search = ctx.storage.search as unknown as {
        removeSync: (id: string) => void;
      };
      const orig = search.removeSync.bind(search);
      let calls = 0;
      vi.spyOn(search, "removeSync").mockImplementation((targetId: string) => {
        calls += 1;
        if (calls === 2) throw new Error("simulated FTS failure");
        orig(targetId);
      });

      await expect(ctx.storage.items.bulkPurge([id1, id2])).rejects.toThrow(
        /simulated FTS failure/,
      );

      // Both items must still be present — the items DELETE never ran, and
      // the first FTS removal must have been rolled back.
      expect(await ctx.storage.items.get(id1)).not.toBeNull();
      expect(await ctx.storage.items.get(id2)).not.toBeNull();
      expect(ftsRowCount(id1)).toBe(1);
      expect(ftsRowCount(id2)).toBe(1);
    },
  );
});
