import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { itemWrites } from "./item-writes.js";
import { createTestContext, sweepTrashBefore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { writeItem } from "./item-write.js";

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

/**
 * Returns the FTS row count for an item id, read from the items_fts
 * virtual table directly.
 */
async function ftsRowCount(itemId: string): Promise<number> {
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  // ids are well-formed UUIDv7 hex+hyphens; safe to interpolate in this
  // test-only context (the escape hatch doesn't bind params).
  const rows = await s.__sqliteAll(
    `SELECT 1 FROM items_fts WHERE rowid = (SELECT seq FROM item_search_keys WHERE item_id = '${itemId.replace(/'/g, "''")}')`,
  );
  return rows.length;
}

/**
 * Ages an item via the store's escape hatch, so retention tests
 * can choose timestamps freely (every write path stamps `now`).
 *
 * Both clocks move together, because "make this row look old" is one
 * intent. `trashed_at` is left alone where it is null, so an active row
 * does not acquire a removal time it never had.
 */
async function ageItem(itemId: string, isoDate: string): Promise<void> {
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

/**
 * Moves the modification time alone, leaving the stamp exactly where it is.
 *
 * `ageItem` moves both by design, which is right for "make this row look
 * old" and is why the one case where the two clocks disagree cannot be
 * written with it.
 */
async function ageUpdatedAtOnly(
  itemId: string,
  isoDate: string,
): Promise<void> {
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  await s.__sqliteRun("UPDATE items SET updated_at = ? WHERE id = ?", [
    isoDate,
    itemId,
  ]);
}

/** Reads the stamp back, for the assertions about the column itself. */
async function readTrashedAt(itemId: string): Promise<string | null> {
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = (await s.__sqliteAll(
    `SELECT trashed_at FROM items WHERE id = '${itemId.replace(/'/g, "''")}'`,
  )) as { trashed_at: string | null }[];
  return rows[0]?.trashed_at ?? null;
}

/** Reads `updated_at` back, for asserting a write actually moved it. */
async function readUpdatedAt(itemId: string): Promise<string | undefined> {
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = (await s.__sqliteAll(
    `SELECT updated_at FROM items WHERE id = '${itemId.replace(/'/g, "''")}'`,
  )) as { updated_at: string }[];
  return rows[0]?.updated_at;
}

describe("ItemStore purge methods — FTS coverage", () => {
  it("purge removes the item and its FTS entry", async () => {
    const itemId = id("aaa1");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "alphabravo searchable" },
      tier: "library",
    });

    // Sanity-check the item is searchable before purge.
    const before = await ctx.storage.search.search("alphabravo", {});
    expect(before.some((h) => h.item.id === itemId)).toBe(true);

    await itemWrites(ctx.storage).delete(itemId);
    await itemWrites(ctx.storage).purge(itemId);

    // The FTS row is gone.
    expect(await ftsRowCount(itemId)).toBe(0);

    const after = await ctx.storage.search.search("alphabravo", {});
    expect(after.some((h) => h.item.id === itemId)).toBe(false);
  });

  it("the trash sweep removes FTS entries for purged trashed items", async () => {
    const itemId = id("aaa2");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "charliedelta searchable" },
      tier: "library",
    });
    await itemWrites(ctx.storage).transition(itemId, "trashed");
    // Force updated_at well before our cutoff.
    await ageItem(
      itemId,
      new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY).toISOString(),
    );

    const deleted = await sweepTrashBefore(
      ctx.storage,
      FIXED_NOW.toISOString(),
    );
    expect(deleted).toBe(1);

    expect(await ftsRowCount(itemId)).toBe(0);

    const after = await ctx.storage.search.search("charliedelta", {});
    expect(after.some((h) => h.item.id === itemId)).toBe(false);
  });
});

describe("TrashPurger — edge cleanup", () => {
  it("drops edges on both sides of a purged item and leaves unrelated edges", async () => {
    const doomed = id("ccc1");
    const neighbor = id("ccc2");
    const bystander = id("ccc3");

    for (const itemId of [doomed, neighbor, bystander]) {
      await itemWrites(ctx.storage).create({
        id: itemId,
        type: "core.note",
        properties: { body: `note ${itemId}` },
        tier: "library",
      });
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

    await itemWrites(ctx.storage).transition(doomed, "trashed");
    await ageItem(
      doomed,
      new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY).toISOString(),
    );

    const deleted = await sweepTrashBefore(
      ctx.storage,
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
      await itemWrites(ctx.storage).create({
        id: itemId,
        type: "core.note",
        properties: { body: `note ${itemId}` },
        tier: "library",
      });
    }
    const edge = await ctx.storage.edges.createRaw({
      source_id: a,
      target_id: b,
      edge_type: "references",
    });

    // `a` is trashed but still inside the retention window.
    await itemWrites(ctx.storage).transition(a, "trashed");
    await ageItem(a, FIXED_NOW.toISOString());

    const deleted = await sweepTrashBefore(
      ctx.storage,
      new Date(FIXED_NOW.getTime() - MS_PER_DAY).toISOString(),
    );
    expect(deleted).toBe(0);
    expect(await ctx.storage.edges.get(edge.id)).not.toBeNull();
  });
});

describe("ItemStore.purge — the trash gate", () => {
  it("takes only a row in its type's soft-deleted state", async () => {
    const make = async (type: string, properties: Record<string, unknown>) =>
      (await itemWrites(ctx.storage).create({ type, properties })).id;
    const connection = {
      kind: "app",
      status: "active",
      granted_at: new Date().toISOString(),
    };
    const trashedNote = await make("core.note", { body: "gone" });
    await itemWrites(ctx.storage).delete(trashedNote);
    const activeNote = await make("core.note", { body: "kept" });
    const revoked = await make("system.connection", connection);
    await itemWrites(ctx.storage).delete(revoked);
    const live = await make("system.connection", connection);

    for (const taken of [trashedNote, revoked]) {
      await itemWrites(ctx.storage).purge(taken);
      expect(await ctx.storage.items.getIncludingTrashed(taken)).toBeNull();
    }
    for (const kept of [activeNote, live]) {
      await expect(itemWrites(ctx.storage).purge(kept)).rejects.toMatchObject({
        code: "invalid_transition",
      });
      expect((await ctx.storage.items.get(kept))?.state).toBe("active");
    }
    await expect(
      itemWrites(ctx.storage).purge(id("ffff")),
    ).rejects.toMatchObject({
      code: "item_not_found",
    });
  });
});

describe("a purge through the item write — atomicity", () => {
  // `items_fts` is a virtual table mutated separately from `items`, so
  // without a transaction a failure after the DELETE would leave the row
  // gone and still searchable, or present and unsearchable.
  it("rolls the row back if its FTS removal fails", async () => {
    const id1 = id("bbb1");
    await itemWrites(ctx.storage).create({
      id: id1,
      type: "core.note",
      properties: { body: "rollbackalpha searchable" },
      tier: "library",
    });
    await itemWrites(ctx.storage).delete(id1);

    const search = ctx.storage.search as unknown as {
      remove: (id: string) => Promise<void>;
    };
    vi.spyOn(search, "remove").mockImplementationOnce(() =>
      Promise.reject(new Error("simulated FTS failure")),
    );

    await expect(
      writeItem(ctx.storage, { kind: "platform" }, { op: "purge", id: id1 }),
    ).rejects.toThrow(/simulated FTS failure/);

    expect(await ctx.storage.items.getIncludingTrashed(id1)).not.toBeNull();
  });
});

/**
 * The sweep's window runs from when the row entered the bin, a stamp set
 * by the transition into the soft-deleted state and by nothing else.
 * `updated_at` is the modification time and moves on any write to the row,
 * a tag or extension write included, so a sweep reading it would restart
 * the retention clock on an edit made in the bin.
 */
describe("TrashPurger — the clock it reads", () => {
  const CUTOFF = FIXED_NOW.toISOString();
  const LONG_AGO = new Date(
    FIXED_NOW.getTime() - 90 * MS_PER_DAY,
  ).toISOString();

  it("purges a trashed item that was written to after it entered the bin", async () => {
    const itemId = id("c10c");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "past the window" },
      tier: "library",
    });
    await itemWrites(ctx.storage).delete(itemId);
    await ageItem(itemId, LONG_AGO);

    // The edit. A tag write is the ordinary way this happens and reaches
    // `updated_at` without touching the row's state at all.
    await ctx.storage.metadata.addTags(itemId, ["still-in-the-bin"]);
    const afterEdit = await readUpdatedAt(itemId);
    expect(afterEdit).toBeDefined();
    expect(afterEdit! > LONG_AGO).toBe(true);

    expect(await sweepTrashBefore(ctx.storage, CUTOFF)).toBe(1);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).toBeNull();
  });

  it("leaves a trashed item whose stamp is inside the window", async () => {
    const itemId = id("c11c");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "recently binned" },
      tier: "library",
    });
    await itemWrites(ctx.storage).delete(itemId);

    expect(await sweepTrashBefore(ctx.storage, CUTOFF)).toBe(0);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).not.toBeNull();
  });

  /**
   * The one case where the two clocks disagree in the direction that
   * matters: a stamp inside the window, a modification time outside it.
   *
   * **The write paths cannot produce this row, and that is deliberate.**
   * Every write stamps `updated_at` with `now`, and the stamp is only ever
   * set by a transition that stamps `updated_at` alongside it, so
   * `trashed_at <= updated_at` holds on every row the API can make. The
   * fixture is built by hand for that reason, and what it pins is the
   * predicate rather than a reachable state: the stamp decides alone, and
   * the modification time has no vote.
   *
   * Worth holding because the rewrite a later reader is most likely to
   * reach for, asking both columns and purging when either is old, reads
   * as more robust and is caught by nothing else in this block.
   */
  it("does not let the modification time vote once a stamp exists", async () => {
    const itemId = id("c15c");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "stamp inside, modification time outside" },
      tier: "library",
    });
    await itemWrites(ctx.storage).delete(itemId);
    await ageUpdatedAtOnly(itemId, LONG_AGO);

    // The fixture is the point, so it is asserted rather than assumed.
    const stamp = await readTrashedAt(itemId);
    expect(stamp).not.toBeNull();
    expect(stamp! > CUTOFF).toBe(true);
    expect(await readUpdatedAt(itemId)).toBe(LONG_AGO);

    expect(await sweepTrashBefore(ctx.storage, CUTOFF)).toBe(0);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).not.toBeNull();
  });

  it("clears the stamp when an item leaves the bin", async () => {
    // The sweep cannot see this: it filters on `state = 'trashed'` before
    // it reads the stamp, so a stale one on a restored row stays invisible
    // until something else reads the column. The column's meaning is the
    // contract, so the assertion is on the column.
    const itemId = id("c14c");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "in and back out" },
      tier: "library",
    });
    expect(await readTrashedAt(itemId)).toBeNull();

    await itemWrites(ctx.storage).delete(itemId);
    expect(await readTrashedAt(itemId)).not.toBeNull();

    await itemWrites(ctx.storage).restore(itemId);
    expect(await readTrashedAt(itemId)).toBeNull();

    // And the explicit transition door agrees with the two beside it.
    await itemWrites(ctx.storage).transition(itemId, "trashed");
    expect(await readTrashedAt(itemId)).not.toBeNull();
    await itemWrites(ctx.storage).transition(itemId, "active");
    expect(await readTrashedAt(itemId)).toBeNull();
  });

  it("starts a fresh window when an item is restored and binned again", async () => {
    const itemId = id("c12c");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "back out and in again" },
      tier: "library",
    });
    await itemWrites(ctx.storage).delete(itemId);
    await ageItem(itemId, LONG_AGO);

    // Out of the bin clears the stamp; back in sets a new one. Inheriting
    // the first would purge this row on its next tick, sixty days early.
    await itemWrites(ctx.storage).restore(itemId);
    await itemWrites(ctx.storage).delete(itemId);

    expect(await sweepTrashBefore(ctx.storage, CUTOFF)).toBe(0);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).not.toBeNull();
  });

  it("leaves a trashed row that carries no stamp alone", async () => {
    // The store still takes a `system.*` item straight into `trashed`, a
    // state its own lifecycle does not contain, and stamps nothing for it;
    // every door that could hand it one refuses the state first (the create
    // doors and the archive restore), so the sweep measures from the stamp
    // alone and a row without one is not its to remove.
    const itemId = id("c16c");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "system.folder",
      state: "trashed",
      properties: { title: "restored into the bin" },
      source: "test/purge",
    });
    expect(await readTrashedAt(itemId)).toBeNull();
    await ageItem(itemId, LONG_AGO);
    expect(await readTrashedAt(itemId)).toBeNull();
    expect(await readUpdatedAt(itemId)).toBe(LONG_AGO);

    expect(await sweepTrashBefore(ctx.storage, CUTOFF)).toBe(0);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).not.toBeNull();
  });

  it("keeps a row that entered the bin exactly at the cutoff", async () => {
    // The window is strictly before the cutoff, as the interface says: a
    // row stamped at the instant itself is inside it.
    const itemId = id("c17c");
    await itemWrites(ctx.storage).create({
      id: itemId,
      type: "core.note",
      properties: { body: "on the line" },
      source: "test/purge",
    });
    await itemWrites(ctx.storage).delete(itemId);
    await ageItem(itemId, CUTOFF);
    expect(await readTrashedAt(itemId)).toBe(CUTOFF);

    expect(await sweepTrashBefore(ctx.storage, CUTOFF)).toBe(0);
    expect(await ctx.storage.items.getIncludingTrashed(itemId)).not.toBeNull();
  });
});
