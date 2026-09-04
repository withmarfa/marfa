import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});

const MS_PER_DAY = 86_400_000;
const FIXED_NOW = new Date("2026-04-15T12:00:00.000Z");

const id = (suffix: string): string =>
  `019d0000-0000-7000-a000-${suffix.padStart(12, "0")}`;

const isPg = (): boolean => (process.env.DB_DIALECT ?? "sqlite") === "pg";

/**
 * Returns the FTS row count for an item id. Always 0 on Postgres (no FTS
 * table — tsvectors are computed at query time). On SQLite, queries the
 * items_fts virtual table directly.
 */
async function ftsRowCount(itemId: string): Promise<number> {
  if (isPg()) return 0;
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  // ids are well-formed UUIDv7 hex+hyphens; safe to interpolate in this
  // test-only context (the escape hatch doesn't bind params).
  const rows = await s.__sqliteAll(
    `SELECT 1 FROM items_fts WHERE item_id = '${itemId.replace(/'/g, "''")}'`,
  );
  return rows.length;
}

/**
 * Ages an item via the dialect-specific escape hatch, so retention tests
 * can choose timestamps freely (every write path stamps `now`).
 *
 * Both clocks move together, because "make this row look old" is one
 * intent and the sweep reads `trashed_at` in preference to `updated_at`.
 * `trashed_at` is left alone where it is null, so an active row does not
 * acquire a removal time it never had.
 */
async function ageItem(itemId: string, isoDate: string): Promise<void> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(
      `UPDATE items SET updated_at = $1,
         trashed_at = CASE WHEN trashed_at IS NULL THEN NULL ELSE $1 END
       WHERE id = $2`,
      [isoDate, itemId],
    );
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await s.__sqliteRun(
      `UPDATE items SET updated_at = ?,
         trashed_at = CASE WHEN trashed_at IS NULL THEN NULL ELSE ? END
       WHERE id = ?`,
      [isoDate, isoDate, itemId],
    );
  }
}

/**
 * Blanks the stamp, reproducing a row soft-deleted by a build that predates
 * the column — the only shape the sweep's fallback exists for.
 */
async function clearTrashedAt(itemId: string): Promise<void> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(`UPDATE items SET trashed_at = NULL WHERE id = $1`, [
      itemId,
    ]);
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await s.__sqliteRun("UPDATE items SET trashed_at = NULL WHERE id = ?", [
      itemId,
    ]);
  }
}

/** Reads `updated_at` back, for asserting a write actually moved it. */
async function readUpdatedAt(itemId: string): Promise<string | undefined> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    const rows = (await s.__pgClient(
      `SELECT updated_at FROM items WHERE id = $1`,
      [itemId],
    )) as { updated_at: string }[];
    return rows[0]?.updated_at;
  }
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = (await s.__sqliteAll(
    `SELECT updated_at FROM items WHERE id = '${itemId.replace(/'/g, "''")}'`,
  )) as { updated_at: string }[];
  return rows[0]?.updated_at;
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
    expect(await ftsRowCount(itemId)).toBe(0);

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
    await ageItem(
      itemId,
      new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY).toISOString(),
    );

    const deleted = await ctx.storage.items.purgeTrashedOlderThan(
      FIXED_NOW.toISOString(),
    );
    expect(deleted).toBe(1);

    expect(await ftsRowCount(itemId)).toBe(0);

    const after = await ctx.storage.search.search("charliedelta", {});
    expect(after.some((h) => h.item.id === itemId)).toBe(false);
  });
});

describe("ItemStore.purgeTrashedOlderThan — edge cleanup", () => {
  it("drops edges on both sides of a purged item and leaves unrelated edges", async () => {
    const doomed = id("ccc1");
    const neighbor = id("ccc2");
    const bystander = id("ccc3");

    for (const itemId of [doomed, neighbor, bystander]) {
      await ctx.storage.items.create(
        {
          id: itemId,
          type: "core.note",
          properties: { body: `note ${itemId}` },
          tier: "library",
        },
        undefined,
      );
    }

    // createRaw bypasses cardinality / cycle enforcement — this exercises the
    // storage layer, not the constraint layer above it.
    const outbound = await ctx.storage.edges.createRaw({
      source_id: doomed,
      target_id: neighbor,
      edge_type: "references",
    });
    const inbound = await ctx.storage.edges.createRaw({
      source_id: bystander,
      target_id: doomed,
      edge_type: "references",
    });
    const unrelated = await ctx.storage.edges.createRaw({
      source_id: bystander,
      target_id: neighbor,
      edge_type: "references",
    });

    await ctx.storage.items.transition(doomed, "trashed", undefined);
    await ageItem(
      doomed,
      new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY).toISOString(),
    );

    const deleted = await ctx.storage.items.purgeTrashedOlderThan(
      FIXED_NOW.toISOString(),
    );
    expect(deleted).toBe(1);

    // Both directions must be gone — edges carry no FK to items, so nothing
    // else would ever collect them.
    expect(await ctx.storage.edges.get(outbound.id)).toBeNull();
    expect(await ctx.storage.edges.get(inbound.id)).toBeNull();
    const fromDoomed = await ctx.storage.edges.listFromSource(doomed);
    const toDoomed = await ctx.storage.edges.listToTarget(doomed);
    expect(fromDoomed.data).toHaveLength(0);
    expect(toDoomed.data).toHaveLength(0);

    // An edge between two surviving items is untouched.
    expect(await ctx.storage.edges.get(unrelated.id)).not.toBeNull();
  });

  it("leaves edges alone when the retention sweep purges nothing", async () => {
    const a = id("ddd1");
    const b = id("ddd2");
    for (const itemId of [a, b]) {
      await ctx.storage.items.create(
        {
          id: itemId,
          type: "core.note",
          properties: { body: `note ${itemId}` },
          tier: "library",
        },
        undefined,
      );
    }
    const edge = await ctx.storage.edges.createRaw({
      source_id: a,
      target_id: b,
      edge_type: "references",
    });

    // `a` is trashed but still inside the retention window.
    await ctx.storage.items.transition(a, "trashed", undefined);
    await ageItem(a, FIXED_NOW.toISOString());

    const deleted = await ctx.storage.items.purgeTrashedOlderThan(
      new Date(FIXED_NOW.getTime() - MS_PER_DAY).toISOString(),
    );
    expect(deleted).toBe(0);
    expect(await ctx.storage.edges.get(edge.id)).not.toBeNull();
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
        remove: (id: string) => Promise<void>;
      };
      const orig = search.remove.bind(search);
      let calls = 0;
      vi.spyOn(search, "remove").mockImplementation(
        async (targetId: string) => {
          calls += 1;
          if (calls === 2) throw new Error("simulated FTS failure");
          await orig(targetId);
        },
      );

      await expect(ctx.storage.items.bulkPurge([id1, id2])).rejects.toThrow(
        /simulated FTS failure/,
      );

      // Both items must still be present — the items DELETE never ran, and
      // the first FTS removal must have been rolled back.
      expect(await ctx.storage.items.get(id1)).not.toBeNull();
      expect(await ctx.storage.items.get(id2)).not.toBeNull();
      expect(await ftsRowCount(id1)).toBe(1);
      expect(await ftsRowCount(id2)).toBe(1);
    },
  );
});

/**
 * The sweep's window runs from when the row entered the bin.
 *
 * It used to run from `updated_at`, which is the modification time and
 * moves on any write to the row — so editing something already in the bin
 * silently restarted its retention clock, and a tag or extension write did
 * it too. The stamp the sweep now reads is set by the transition into the
 * soft-deleted state and by nothing else.
 */
describe("ItemStore.purgeTrashedOlderThan — the clock it reads", () => {
  const CUTOFF = FIXED_NOW.toISOString();
  const LONG_AGO = new Date(
    FIXED_NOW.getTime() - 90 * MS_PER_DAY,
  ).toISOString();

  it("purges a trashed item that was written to after it entered the bin", async () => {
    const itemId = id("c10c");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { body: "past the window" },
        tier: "library",
      },
      undefined,
    );
    await ctx.storage.items.delete(itemId);
    await ageItem(itemId, LONG_AGO);

    // The edit. A tag write is the ordinary way this happens and reaches
    // `updated_at` without touching the row's state at all, which is what
    // made the old key so easy to reset by accident.
    await ctx.storage.metadata.addTags(itemId, ["still-in-the-bin"]);
    const afterEdit = await readUpdatedAt(itemId);
    expect(afterEdit).toBeDefined();
    expect(afterEdit! > LONG_AGO).toBe(true);

    expect(await ctx.storage.items.purgeTrashedOlderThan(CUTOFF)).toBe(1);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).toBeNull();
  });

  it("leaves a trashed item whose stamp is inside the window", async () => {
    const itemId = id("c11c");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { body: "recently binned" },
        tier: "library",
      },
      undefined,
    );
    // Old as far as the modification time is concerned, and binned just
    // now. The two clocks disagree and the stamp is the one that decides.
    await ageItem(itemId, LONG_AGO);
    await ctx.storage.items.delete(itemId);

    expect(await ctx.storage.items.purgeTrashedOlderThan(CUTOFF)).toBe(0);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).not.toBeNull();
  });

  it("starts a fresh window when an item is restored and binned again", async () => {
    const itemId = id("c12c");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { body: "back out and in again" },
        tier: "library",
      },
      undefined,
    );
    await ctx.storage.items.delete(itemId);
    await ageItem(itemId, LONG_AGO);

    // Out of the bin clears the stamp; back in sets a new one. Inheriting
    // the first would purge this row on its next tick, sixty days early.
    await ctx.storage.items.restore(itemId);
    await ctx.storage.items.delete(itemId);

    expect(await ctx.storage.items.purgeTrashedOlderThan(CUTOFF)).toBe(0);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).not.toBeNull();
  });

  it("falls back to the modification time for a row with no stamp", async () => {
    // The rolling-deploy case: a replica running the previous build
    // soft-deletes a row and writes no stamp. Reproducing the old behavior
    // is worse than the stamp and far better than a row nothing can purge.
    const itemId = id("c13c");
    await ctx.storage.items.create(
      {
        id: itemId,
        type: "core.note",
        properties: { body: "no stamp" },
        tier: "library",
      },
      undefined,
    );
    await ctx.storage.items.delete(itemId);
    await ageItem(itemId, LONG_AGO);
    await clearTrashedAt(itemId);

    expect(await ctx.storage.items.purgeTrashedOlderThan(CUTOFF)).toBe(1);
  });
});
