import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  TrashPurger,
  FeedExpirer,
  AuthSessionCleaner,
  runTenantCleanup,
} from "./retention.js";
import type { TenantFanout } from "./retention.js";

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
  tier: "library" | "feed";
  updatedAtIso: string;
  tenantId?: string;
}): Promise<void> {
  await ctx.storage.items.create(
    {
      id: opts.id,
      type: "core.note",
      properties: { body: `seed ${opts.id}` },
      tier: opts.tier,
    },
    opts.tenantId,
  );
  if (opts.state !== "active") {
    await ctx.storage.items.transition(opts.id, opts.state, opts.tenantId);
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
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    await s.__sqliteRun("UPDATE items SET updated_at = ? WHERE id = ?", [
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
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  // SQLite escape hatch doesn't bind params, but ids are well-formed
  // UUIDv7 hex+hyphens — no injection risk in this test-only context.
  const rows = await s.__sqliteAll(
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
      tier: "library",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 59 * MS_PER_DAY,
      ).toISOString(),
    });
    // Trashed just past the cutoff (61 days old): should be purged.
    await seedItemWithUpdatedAt({
      id: ids.oldTrash,
      state: "trashed",
      tier: "library",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 61 * MS_PER_DAY,
      ).toISOString(),
    });
    // Trashed 90 days old: also purged.
    await seedItemWithUpdatedAt({
      id: ids.ancientTrash,
      state: "trashed",
      tier: "feed",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 90 * MS_PER_DAY,
      ).toISOString(),
    });
    // Active item from 90 days ago: survives — state gate.
    await seedItemWithUpdatedAt({
      id: ids.activeAncient,
      state: "active",
      tier: "library",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 90 * MS_PER_DAY,
      ).toISOString(),
    });
    // Archived item from 90 days ago: survives — state gate.
    await seedItemWithUpdatedAt({
      id: ids.archivedAncient,
      state: "archived",
      tier: "library",
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
      tier: "library",
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
      tier: "library",
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

describe("FeedExpirer.runOnce — behavioural", () => {
  it("deletes feed items older than the retention window, keeps library items and newer feed items", async () => {
    const ids = {
      youngFeed: id("ddd1"),
      oldFeed: id("ddd2"),
      ancientFeed: id("ddd3"),
      ancientLibrary: id("ddd4"),
      ancientArchivedFeed: id("ddd5"),
      ancientTrashedFeed: id("ddd6"),
    };

    // Feed item inside retention window (29 days old): survives.
    await seedItemWithUpdatedAt({
      id: ids.youngFeed,
      state: "active",
      tier: "feed",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 29 * MS_PER_DAY,
      ).toISOString(),
    });
    // Feed item just past cutoff (31 days): expires.
    await seedItemWithUpdatedAt({
      id: ids.oldFeed,
      state: "active",
      tier: "feed",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 31 * MS_PER_DAY,
      ).toISOString(),
    });
    // Feed item 100 days old: expires.
    await seedItemWithUpdatedAt({
      id: ids.ancientFeed,
      state: "active",
      tier: "feed",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });
    // Library item, also 100 days old: survives (library gate).
    await seedItemWithUpdatedAt({
      id: ids.ancientLibrary,
      state: "active",
      tier: "library",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });
    // Feed item archived 100 days ago: still expires (state-agnostic).
    await seedItemWithUpdatedAt({
      id: ids.ancientArchivedFeed,
      state: "archived",
      tier: "feed",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });
    // Feed item trashed 100 days ago: also expires.
    await seedItemWithUpdatedAt({
      id: ids.ancientTrashedFeed,
      state: "trashed",
      tier: "feed",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 100 * MS_PER_DAY,
      ).toISOString(),
    });

    const expirer = new FeedExpirer(
      ctx.storage.items,
      30,
      3_600_000,
      () => FIXED_NOW,
    );

    const deleted = await expirer.runOnce();
    expect(deleted).toBe(4);

    expect(await rowExists(ids.youngFeed)).toBe(true);
    expect(await rowExists(ids.ancientLibrary)).toBe(true);
    expect(await rowExists(ids.oldFeed)).toBe(false);
    expect(await rowExists(ids.ancientFeed)).toBe(false);
    expect(await rowExists(ids.ancientArchivedFeed)).toBe(false);
    expect(await rowExists(ids.ancientTrashedFeed)).toBe(false);
  });

  it("is a no-op when retentionDays <= 0 (the default)", async () => {
    const itemId = id("eee1");
    await seedItemWithUpdatedAt({
      id: itemId,
      state: "active",
      tier: "feed",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 365 * MS_PER_DAY,
      ).toISOString(),
    });

    const disabled = new FeedExpirer(
      ctx.storage.items,
      0,
      3_600_000,
      () => FIXED_NOW,
    );
    expect(await disabled.runOnce()).toBe(0);
    expect(await rowExists(itemId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-050: per-tenant fan-out
// ---------------------------------------------------------------------------

describe("TrashPurger fan-out — per-tenant retention overrides", () => {
  it("honours per-tenant trash_retention_days, falling back to instance default for tenants without override and the NULL bucket", async () => {
    if (!ctx.storage.tenants) {
      // Should always be wired in current shape but guarding defensively.
      throw new Error("tenants store missing — test pre-condition violated");
    }
    const tenantA = await ctx.storage.tenants.create("tenant-A");
    const tenantB = await ctx.storage.tenants.create("tenant-B");
    const tenantC = await ctx.storage.tenants.create("tenant-C-default");
    // Tenant A: aggressive 1-day retention.
    await ctx.storage.tenants.updateConfig(tenantA.id, {
      trash_retention_days: 1,
    });
    // Tenant B: lax 30-day retention.
    await ctx.storage.tenants.updateConfig(tenantB.id, {
      trash_retention_days: 30,
    });
    // Tenant C: no override → uses instance default (5 days here).

    // Ten-day-old trashed items in each scope, including the NULL bucket.
    const ids2 = {
      a: id("fa01"),
      b: id("fa02"),
      c: id("fa03"),
      none: id("fa04"),
    };
    const tenDaysAgo = new Date(
      FIXED_NOW.getTime() - 10 * MS_PER_DAY,
    ).toISOString();
    await seedItemWithUpdatedAt({
      id: ids2.a,
      state: "trashed",
      tier: "library",
      updatedAtIso: tenDaysAgo,
      tenantId: tenantA.id,
    });
    await seedItemWithUpdatedAt({
      id: ids2.b,
      state: "trashed",
      tier: "library",
      updatedAtIso: tenDaysAgo,
      tenantId: tenantB.id,
    });
    await seedItemWithUpdatedAt({
      id: ids2.c,
      state: "trashed",
      tier: "library",
      updatedAtIso: tenDaysAgo,
      tenantId: tenantC.id,
    });
    await seedItemWithUpdatedAt({
      id: ids2.none,
      state: "trashed",
      tier: "library",
      updatedAtIso: tenDaysAgo,
    });

    const fanout: TenantFanout = {
      tenants: ctx.storage.tenants,
      configField: "trash_retention_days",
    };
    const purger = new TrashPurger(
      ctx.storage.items,
      5, // instance default — applies to tenant C and the NULL bucket
      3_600_000,
      () => FIXED_NOW,
      ctx.storage.coordination,
      fanout,
    );

    const deleted = await purger.runOnce();
    // A (10 > 1) purged, B (10 < 30) survives, C (10 > 5) purged,
    // NULL (10 > 5) purged → 3 deletions.
    expect(deleted).toBe(3);
    expect(await rowExists(ids2.a)).toBe(false);
    expect(await rowExists(ids2.b)).toBe(true);
    expect(await rowExists(ids2.c)).toBe(false);
    expect(await rowExists(ids2.none)).toBe(false);
  });

  it("treats per-tenant trash_retention_days = 0 as 'disable for that tenant'", async () => {
    if (!ctx.storage.tenants) throw new Error("tenants store missing");
    const t = await ctx.storage.tenants.create("disabled-tenant");
    await ctx.storage.tenants.updateConfig(t.id, {
      trash_retention_days: 0,
    });
    const itemId = id("fb01");
    await seedItemWithUpdatedAt({
      id: itemId,
      state: "trashed",
      tier: "library",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 365 * MS_PER_DAY,
      ).toISOString(),
      tenantId: t.id,
    });

    const fanout: TenantFanout = {
      tenants: ctx.storage.tenants,
      configField: "trash_retention_days",
    };
    const purger = new TrashPurger(
      ctx.storage.items,
      60,
      3_600_000,
      () => FIXED_NOW,
      ctx.storage.coordination,
      fanout,
    );
    const deleted = await purger.runOnce();
    expect(deleted).toBe(0);
    expect(await rowExists(itemId)).toBe(true);
  });
});

describe("FeedExpirer fan-out — per-tenant retention overrides", () => {
  it("honours per-tenant feed_retention_days independently from trash retention", async () => {
    if (!ctx.storage.tenants) throw new Error("tenants store missing");
    const tA = await ctx.storage.tenants.create("feed-tenant-A");
    const tB = await ctx.storage.tenants.create("feed-tenant-B");
    await ctx.storage.tenants.updateConfig(tA.id, {
      feed_retention_days: 1,
    });
    await ctx.storage.tenants.updateConfig(tB.id, {
      feed_retention_days: 14,
    });

    const ids2 = { a: id("fc01"), b: id("fc02") };
    const sevenDaysAgo = new Date(
      FIXED_NOW.getTime() - 7 * MS_PER_DAY,
    ).toISOString();
    await seedItemWithUpdatedAt({
      id: ids2.a,
      state: "active",
      tier: "feed",
      updatedAtIso: sevenDaysAgo,
      tenantId: tA.id,
    });
    await seedItemWithUpdatedAt({
      id: ids2.b,
      state: "active",
      tier: "feed",
      updatedAtIso: sevenDaysAgo,
      tenantId: tB.id,
    });

    const fanout: TenantFanout = {
      tenants: ctx.storage.tenants,
      configField: "feed_retention_days",
    };
    const expirer = new FeedExpirer(
      ctx.storage.items,
      0, // instance default disabled — purely per-tenant
      3_600_000,
      () => FIXED_NOW,
      ctx.storage.coordination,
      fanout,
    );
    const deleted = await expirer.runOnce();
    expect(deleted).toBe(1); // A (7 > 1) expires, B (7 < 14) survives
    expect(await rowExists(ids2.a)).toBe(false);
    expect(await rowExists(ids2.b)).toBe(true);
  });
});

describe("runTenantCleanup — audit and event-log fan-out", () => {
  it("calls the sweep function with each tenant's effective retention", async () => {
    if (!ctx.storage.tenants) throw new Error("tenants store missing");
    const tA = await ctx.storage.tenants.create("audit-tenant-A");
    const tB = await ctx.storage.tenants.create("audit-tenant-B");
    await ctx.storage.tenants.updateConfig(tA.id, {
      audit_retention_days: 7,
    });
    await ctx.storage.tenants.updateConfig(tB.id, {
      // No override — tB falls through to instance default.
    });

    const calls: { retention: number; tenantId: string | null | undefined }[] =
      [];
    const total = await runTenantCleanup({
      jobName: "test-audit-cleanup",
      coordination: ctx.storage.coordination,
      fanout: {
        tenants: ctx.storage.tenants,
        configField: "audit_retention_days",
      },
      instanceDefault: 30,
      unitMs: MS_PER_DAY,
      sweep: (retention, tenantId) => {
        calls.push({ retention, tenantId });
        return Promise.resolve(1); // pretend each scope deleted one row
      },
    });

    // Three calls expected: tA(7), tB(30), NULL(30). Plus the total
    // sums those.
    const byTenant = new Map(calls.map((c) => [c.tenantId, c.retention]));
    expect(byTenant.get(tA.id)).toBe(7);
    expect(byTenant.get(tB.id)).toBe(30);
    expect(byTenant.get(null)).toBe(30);
    expect(calls.length).toBe(3);
    expect(total).toBe(3);
  });

  it("skips tenants whose effective retention is 0 (disabled)", async () => {
    if (!ctx.storage.tenants) throw new Error("tenants store missing");
    const t = await ctx.storage.tenants.create("disabled-event-log");
    await ctx.storage.tenants.updateConfig(t.id, {
      event_log_retention_hours: 0,
    });

    const calls: { retention: number; tenantId: string | null | undefined }[] =
      [];
    await runTenantCleanup({
      jobName: "test-eventlog-cleanup",
      coordination: ctx.storage.coordination,
      fanout: {
        tenants: ctx.storage.tenants,
        configField: "event_log_retention_hours",
      },
      instanceDefault: 168,
      unitMs: 3_600_000,
      sweep: (retention, tenantId) => {
        calls.push({ retention, tenantId });
        return Promise.resolve(0);
      },
    });

    // The disabled tenant is skipped; only the NULL-bucket sweep runs
    // (instance default = 168h).
    const tenants = calls.map((c) => c.tenantId);
    expect(tenants).not.toContain(t.id);
    expect(tenants).toContain(null);
  });

  it("falls back to a single global sweep when no fanout is provided", async () => {
    const calls: { retention: number; tenantId: string | null | undefined }[] =
      [];
    const total = await runTenantCleanup({
      jobName: "test-no-fanout",
      coordination: ctx.storage.coordination,
      fanout: undefined,
      instanceDefault: 90,
      unitMs: MS_PER_DAY,
      sweep: (retention, tenantId) => {
        calls.push({ retention, tenantId });
        return Promise.resolve(5);
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.retention).toBe(90);
    expect(calls[0]?.tenantId).toBeUndefined();
    expect(total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// T-097: AuthSessionCleaner — drop expired better-auth session rows.
// ---------------------------------------------------------------------------

/**
 * Insert an `auth_session` row directly via the storage escape hatches.
 * We seed a parent `auth_user` row first because of the FK constraint,
 * then plant the session with a contrived `expires_at`. PG accepts ISO
 * strings via `__pgClient`; SQLite stores `integer({ mode: "timestamp" })`
 * as Unix seconds.
 */
async function seedAuthSession(opts: {
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const nowIso = new Date().toISOString();
  const expiresIso = opts.expiresAt.toISOString();
  if (dialect === "pg") {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(
      `INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (id) DO NOTHING`,
      [opts.userId, "test", `${opts.userId}@example.com`, true, nowIso],
    );
    await s.__pgClient(
      `INSERT INTO auth_session (id, expires_at, token, created_at, updated_at, user_id)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [opts.sessionId, expiresIso, opts.token, nowIso, opts.userId],
    );
  } else {
    const s = ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresSec = Math.floor(opts.expiresAt.getTime() / 1000);
    await s.__sqliteRun(
      `INSERT OR IGNORE INTO auth_user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [opts.userId, "test", `${opts.userId}@example.com`, 1, nowSec, nowSec],
    );
    await s.__sqliteRun(
      `INSERT INTO auth_session (id, expires_at, token, created_at, updated_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [opts.sessionId, expiresSec, opts.token, nowSec, nowSec, opts.userId],
    );
  }
}

async function authSessionExists(sessionId: string): Promise<boolean> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  if (dialect === "pg") {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    const rows = await s.__pgClient(
      "SELECT 1 FROM auth_session WHERE id = $1",
      [sessionId],
    );
    return rows.length > 0;
  }
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = await s.__sqliteAll(
    `SELECT 1 FROM auth_session WHERE id = '${sessionId.replace(/'/g, "''")}'`,
  );
  return rows.length > 0;
}

describe("AuthSessionCleaner.runOnce — drops expired auth_session rows", () => {
  it("deletes rows whose expires_at is strictly before now, keeps the rest", async () => {
    if (!ctx.storage.authSessions) {
      throw new Error("storage.authSessions not wired in test context");
    }

    const userId = "test-user-t097";
    await seedAuthSession({
      userId,
      sessionId: "sess-expired",
      token: "tok-expired",
      expiresAt: new Date(FIXED_NOW.getTime() - 60_000),
    });
    await seedAuthSession({
      userId,
      sessionId: "sess-active",
      token: "tok-active",
      expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
    });

    const cleaner = new AuthSessionCleaner(
      ctx.storage.authSessions,
      3_600_000,
      () => FIXED_NOW,
    );

    const deleted = await cleaner.runOnce();
    expect(deleted).toBe(1);
    expect(await authSessionExists("sess-expired")).toBe(false);
    expect(await authSessionExists("sess-active")).toBe(true);
  });

  it("is idempotent — running twice with no fresh expiries returns 0 the second time", async () => {
    if (!ctx.storage.authSessions) {
      throw new Error("storage.authSessions not wired in test context");
    }

    await seedAuthSession({
      userId: "test-user-t097-idem",
      sessionId: "sess-idem",
      token: "tok-idem",
      expiresAt: new Date(FIXED_NOW.getTime() - 60_000),
    });

    const cleaner = new AuthSessionCleaner(
      ctx.storage.authSessions,
      3_600_000,
      () => FIXED_NOW,
    );

    expect(await cleaner.runOnce()).toBe(1);
    expect(await cleaner.runOnce()).toBe(0);
  });
});
