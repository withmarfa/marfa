import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { TrashPurger, AmbientExpirer } from "./retention.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.cleanup();
});

const MS_PER_DAY = 86_400_000;
const FIXED_NOW = new Date("2026-04-15T12:00:00.000Z");

/**
 * Insert an item directly via the storage layer with a contrived
 * `updated_at`. Bypasses the route layer because the route always stamps
 * `now` — these tests need to choose timestamps explicitly.
 */
async function seedItemWithUpdatedAt(opts: {
  id: string;
  state: "active" | "archived" | "trashed";
  library: boolean;
  updatedAtIso: string;
}): Promise<void> {
  await ctx.storage.items.create(
    {
      id: opts.id,
      type: "core.note",
      properties: { body: `seed ${opts.id}` },
      library: opts.library,
    },
    undefined,
  );
  if (opts.state !== "active") {
    await ctx.storage.items.transition(opts.id, opts.state, undefined);
  }
  // Force the updated_at to a contrived value via raw SQL — both dialects
  // expose `_pgTruncate` / `__sqliteAll` escape hatches on storage; here
  // we just write directly through the Drizzle internals.
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  if (dialect === "pg") {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(`UPDATE items SET updated_at = $1 WHERE id = $2`, [
      opts.updatedAtIso,
      opts.id,
    ]);
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => unknown;
    };
    s.__sqliteRun("UPDATE items SET updated_at = ? WHERE id = ?", [
      opts.updatedAtIso,
      opts.id,
    ]);
  }
}

const id = (suffix: string): string =>
  `019d0000-0000-7000-a000-${suffix.padStart(12, "0")}`;

/**
 * Asserts the items-table row's existence directly. `items.get()`
 * suppresses trashed rows, so we go straight to the table.
 */
async function rowExists(itemId: string): Promise<boolean> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  if (dialect === "pg") {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    const rows = await s.__pgClient("SELECT 1 FROM items WHERE id = $1", [
      itemId,
    ]);
    return rows.length > 0;
  }
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => unknown[];
  };
  // SQLite escape hatch doesn't bind params, but ids are well-formed
  // UUIDv7 hex+hyphens — no injection risk in this test-only context.
  const rows = s.__sqliteAll(
    `SELECT 1 FROM items WHERE id = '${itemId.replace(/'/g, "''")}'`,
  );
  return rows.length > 0;
}

describe("TrashPurger.runOnce — behavioural", () => {
  it("deletes trashed items older than the retention window, keeps newer trashed and any non-trashed", async () => {
    const ids = {
      youngTrash: id("aaa1"),
      oldTrash: id("aaa2"),
      ancientTrash: id("aaa3"),
      activeAncient: id("aaa4"),
      archivedAncient: id("aaa5"),
    };

    // Trashed inside retention window (59 days old): should survive.
    await seedItemWithUpdatedAt({
      id: ids.youngTrash,
      state: "trashed",
      library: true,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 59 * MS_PER_DAY,
      ).toISOString(),
    });
    // Trashed just past the cutoff (61 days old): should be purged.
    await seedItemWithUpdatedAt({
      id: ids.oldTrash,
      state: "trashed",
      library: true,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 61 * MS_PER_DAY,
      ).toISOString(),
    });
    // Trashed 90 days old: also purged.
    await seedItemWithUpdatedAt({
      id: ids.ancientTrash,
      state: "trashed",
      library: false,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 90 * MS_PER_DAY,
      ).toISOString(),
    });
    // Active item from 90 days ago: survives — state gate.
    await seedItemWithUpdatedAt({
      id: ids.activeAncient,
      state: "active",
      library: true,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 90 * MS_PER_DAY,
      ).toISOString(),
    });
    // Archived item from 90 days ago: survives — state gate.
    await seedItemWithUpdatedAt({
      id: ids.archivedAncient,
      state: "archived",
      library: true,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 90 * MS_PER_DAY,
      ).toISOString(),
    });

    const purger = new TrashPurger(
      ctx.storage.items,
      60,
      3_600_000,
      () => FIXED_NOW,
    );

    const deleted = await purger.runOnce();
    expect(deleted).toBe(2);

    expect(await rowExists(ids.youngTrash)).toBe(true);
    expect(await rowExists(ids.activeAncient)).toBe(true);
    expect(await rowExists(ids.archivedAncient)).toBe(true);
    expect(await rowExists(ids.oldTrash)).toBe(false);
    expect(await rowExists(ids.ancientTrash)).toBe(false);
  });

  it("is a no-op when retentionDays <= 0", async () => {
    const itemId = id("bbb1");
    await seedItemWithUpdatedAt({
      id: itemId,
      state: "trashed",
      library: true,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 365 * MS_PER_DAY,
      ).toISOString(),
    });

    const disabled = new TrashPurger(
      ctx.storage.items,
      0,
      3_600_000,
      () => FIXED_NOW,
    );
    expect(await disabled.runOnce()).toBe(0);
    expect(await rowExists(itemId)).toBe(true);
  });

  it("re-purges items that fall out of the window between runs", async () => {
    const itemId = id("ccc1");
    // Created 30 days ago (still inside default 60-day window).
    await seedItemWithUpdatedAt({
      id: itemId,
      state: "trashed",
      library: true,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 30 * MS_PER_DAY,
      ).toISOString(),
    });

    const purger = new TrashPurger(
      ctx.storage.items,
      60,
      3_600_000,
      () => FIXED_NOW,
    );
    expect(await purger.runOnce()).toBe(0);
    expect(await rowExists(itemId)).toBe(true);

    // Advance the clock past the cutoff and re-run.
    const laterPurger = new TrashPurger(
      ctx.storage.items,
      60,
      3_600_000,
      () => new Date(FIXED_NOW.getTime() + 31 * MS_PER_DAY),
    );
    expect(await laterPurger.runOnce()).toBe(1);
    expect(await rowExists(itemId)).toBe(false);
  });
});

describe("AmbientExpirer.runOnce — behavioural", () => {
  it("deletes ambient items older than the retention window, keeps library items and newer ambients", async () => {
    const ids = {
      youngAmbient: id("ddd1"),
      oldAmbient: id("ddd2"),
      ancientAmbient: id("ddd3"),
      ancientLibrary: id("ddd4"),
      ancientArchivedAmbient: id("ddd5"),
      ancientTrashedAmbient: id("ddd6"),
    };

    // Ambient inside retention window (29 days old): survives.
    await seedItemWithUpdatedAt({
      id: ids.youngAmbient,
      state: "active",
      library: false,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 29 * MS_PER_DAY,
      ).toISOString(),
    });
    // Ambient just past cutoff (31 days): expires.
    await seedItemWithUpdatedAt({
      id: ids.oldAmbient,
      state: "active",
      library: false,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 31 * MS_PER_DAY,
      ).toISOString(),
    });
    // Ambient 100 days old: expires.
    await seedItemWithUpdatedAt({
      id: ids.ancientAmbient,
      state: "active",
      library: false,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });
    // Library item, also 100 days old: survives (library gate).
    await seedItemWithUpdatedAt({
      id: ids.ancientLibrary,
      state: "active",
      library: true,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });
    // Ambient archived 100 days ago: still expires (state-agnostic).
    await seedItemWithUpdatedAt({
      id: ids.ancientArchivedAmbient,
      state: "archived",
      library: false,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });
    // Ambient trashed 100 days ago: also expires.
    await seedItemWithUpdatedAt({
      id: ids.ancientTrashedAmbient,
      state: "trashed",
      library: false,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });

    const expirer = new AmbientExpirer(
      ctx.storage.items,
      30,
      3_600_000,
      () => FIXED_NOW,
    );

    const deleted = await expirer.runOnce();
    expect(deleted).toBe(4);

    expect(await rowExists(ids.youngAmbient)).toBe(true);
    expect(await rowExists(ids.ancientLibrary)).toBe(true);
    expect(await rowExists(ids.oldAmbient)).toBe(false);
    expect(await rowExists(ids.ancientAmbient)).toBe(false);
    expect(await rowExists(ids.ancientArchivedAmbient)).toBe(false);
    expect(await rowExists(ids.ancientTrashedAmbient)).toBe(false);
  });

  it("is a no-op when retentionDays <= 0 (the V0 default)", async () => {
    const itemId = id("eee1");
    await seedItemWithUpdatedAt({
      id: itemId,
      state: "active",
      library: false,
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 365 * MS_PER_DAY,
      ).toISOString(),
    });

    const disabled = new AmbientExpirer(
      ctx.storage.items,
      0,
      3_600_000,
      () => FIXED_NOW,
    );
    expect(await disabled.runOnce()).toBe(0);
    expect(await rowExists(itemId)).toBe(true);
  });
});
