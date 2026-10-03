import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { itemWrites } from "./item-writes.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  TrashPurger,
  RevokedGrantPurger,
  RevokedKeyReaper,
  AuthSessionCleaner,
  DcrClientCleaner,
  runSweepAtRetention,
} from "./retention.js";
import type { RetentionOverride } from "./retention.js";
import { TEST_API_KEY_SALT } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { writeInstanceConfig } from "./instance-config.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
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
}): Promise<void> {
  await itemWrites(ctx.storage).create({
    id: opts.id,
    type: "core.note",
    properties: { body: `seed ${opts.id}` },
    tier: opts.tier,
  });
  if (opts.state !== "active") {
    await itemWrites(ctx.storage).transition(opts.id, opts.state);
  }
  // Force the timestamps to a contrived value via raw SQL through the
  // storage escape hatches.
  //
  // `trashed_at` moves with `updated_at`, because "seed a row this old" is
  // one intent and the trash sweep reads the stamp in preference to the
  // modification time. Left alone where it is null, so an active row does
  // not acquire a removal time it never had.
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  await s.__sqliteRun(
    `UPDATE items SET updated_at = ?,
       trashed_at = CASE WHEN trashed_at IS NULL THEN NULL ELSE ? END
     WHERE id = ?`,
    [opts.updatedAtIso, opts.updatedAtIso, opts.id],
  );
}

const id = (suffix: string): string =>
  `019d0000-0000-7000-a000-${suffix.padStart(12, "0")}`;

/**
 * Asserts the items-table row's existence directly. `items.get()`
 * suppresses trashed rows, so we go straight to the table.
 */
async function rowExists(itemId: string): Promise<boolean> {
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

describe("TrashPurger.runOnce — behavioral", () => {
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

    const purger = new TrashPurger(ctx.storage, 60, () => FIXED_NOW);

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

    const disabled = new TrashPurger(ctx.storage, 0, () => FIXED_NOW);
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

    const purger = new TrashPurger(ctx.storage, 60, () => FIXED_NOW);
    expect(await purger.runOnce()).toBe(0);
    expect(await rowExists(itemId)).toBe(true);

    // Advance the clock past the cutoff and re-run.
    const laterPurger = new TrashPurger(
      ctx.storage,
      60,
      () => new Date(FIXED_NOW.getTime() + 31 * MS_PER_DAY),
    );
    expect(await laterPurger.runOnce()).toBe(1);
    expect(await rowExists(itemId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The instance config override
// ---------------------------------------------------------------------------

describe("TrashPurger — the instance config override", () => {
  it("honors trash_retention_days from the instance config over the default", async () => {
    await writeInstanceConfig(ctx.storage.settings, {
      trash_retention_days: 1,
    });
    const itemId = id("fa01");
    await seedItemWithUpdatedAt({
      id: itemId,
      state: "trashed",
      tier: "library",
      updatedAtIso: new Date(
        FIXED_NOW.getTime() - 10 * MS_PER_DAY,
      ).toISOString(),
    });

    const retentionOverride: RetentionOverride = {
      settings: ctx.storage.settings,
      configField: "trash_retention_days",
    };
    const purger = new TrashPurger(
      ctx.storage,
      30, // the instance default the override beats
      () => FIXED_NOW,
      retentionOverride,
    );
    const deleted = await purger.runOnce();
    expect(deleted).toBe(1);
    expect(await rowExists(itemId)).toBe(false);
  });

  it("treats trash_retention_days = 0 in the config as disabled", async () => {
    await writeInstanceConfig(ctx.storage.settings, {
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
    });

    const retentionOverride: RetentionOverride = {
      settings: ctx.storage.settings,
      configField: "trash_retention_days",
    };
    const purger = new TrashPurger(
      ctx.storage,
      60,
      () => FIXED_NOW,
      retentionOverride,
    );
    const deleted = await purger.runOnce();
    expect(deleted).toBe(0);
    expect(await rowExists(itemId)).toBe(true);
  });
});

describe("runSweepAtRetention — audit and event-log retention", () => {
  it("calls the sweep function with the effective retention", async () => {
    await writeInstanceConfig(ctx.storage.settings, {
      audit_retention_days: 7,
    });

    const calls: { retention: number }[] = [];
    const total = await runSweepAtRetention({
      override: {
        settings: ctx.storage.settings,
        configField: "audit_retention_days",
      },
      instanceDefault: 30,
      sweep: (retention) => {
        calls.push({ retention });
        return Promise.resolve(1); // pretend the sweep deleted one row
      },
    });

    // The override, once: there is one sweep on an instance.
    expect(calls).toEqual([{ retention: 7 }]);
    expect(total).toBe(1);
  });

  it("skips the sweep when the effective retention is 0 (disabled)", async () => {
    await writeInstanceConfig(ctx.storage.settings, {
      event_log_retention_hours: 0,
    });

    const calls: { retention: number }[] = [];
    const total = await runSweepAtRetention({
      override: {
        settings: ctx.storage.settings,
        configField: "event_log_retention_hours",
      },
      instanceDefault: 168,
      sweep: (retention) => {
        calls.push({ retention });
        return Promise.resolve(0);
      },
    });

    expect(calls).toEqual([]);
    expect(total).toBe(0);
  });

  it("falls back to the instance default when no override is provided", async () => {
    const calls: { retention: number }[] = [];
    const total = await runSweepAtRetention({
      override: undefined,
      instanceDefault: 90,
      sweep: (retention) => {
        calls.push({ retention });
        return Promise.resolve(5);
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.retention).toBe(90);
    expect(total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// AuthSessionCleaner — drop expired better-auth session rows.
// ---------------------------------------------------------------------------

/**
 * Insert an `auth_session` row directly via the storage escape hatches.
 * We seed a parent `auth_user` row first because of the FK constraint,
 * then plant the session with a contrived `expires_at`. The column is
 * `integer({ mode: "timestamp" })`, stored as Unix seconds.
 */
async function seedAuthSession(opts: {
  userId: string;
  sessionId: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
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

async function authSessionExists(sessionId: string): Promise<boolean> {
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
      () => FIXED_NOW,
    );

    expect(await cleaner.runOnce()).toBe(1);
    expect(await cleaner.runOnce()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DcrClientCleaner — reap grantless DCR clients past the retention window.
// ---------------------------------------------------------------------------

/**
 * Seed an `auth_oauth_client` row via the typed store, then force its
 * `created_at` to a contrived value via the SQL escape hatch (the store
 * always stamps `now`). Public client by default — that's the DCR shape.
 */
async function seedOauthClient(opts: {
  clientId: string;
  createdAt: Date;
}): Promise<void> {
  const provider = ctx.storage.oauthProvider;
  if (!provider) throw new Error("storage.oauthProvider not wired");
  await provider.createClient({
    clientId: opts.clientId,
    name: `DCR ${opts.clientId}`,
    isPublic: true,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: ["core.note:read"],
    redirectUris: ["http://localhost:5173/callback"],
  });
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  await s.__sqliteRun(
    `UPDATE auth_oauth_client SET created_at = ? WHERE client_id = ?`,
    [Math.floor(opts.createdAt.getTime() / 1000), opts.clientId],
  );
}

/** Insert an auth_user so token FKs resolve (mirrors seedAuthSession). */
async function seedAuthUser(userId: string): Promise<void> {
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  await s.__sqliteRun(
    `INSERT OR IGNORE INTO auth_user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [userId, "test", `${userId}@example.com`, nowSec, nowSec],
  );
}

async function oauthClientExists(clientId: string): Promise<boolean> {
  const s = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = await s.__sqliteAll(
    `SELECT 1 FROM auth_oauth_client WHERE client_id = '${clientId.replace(/'/g, "''")}'`,
  );
  return rows.length > 0;
}

describe("DcrClientCleaner.runOnce — reaps grantless DCR clients", () => {
  it("removes only the old grantless client; spares recent ones and ones with any grant", async () => {
    const oldGrantless = "client_old_grantless";
    const recentGrantless = "client_recent_grantless";
    const oldWithToken = "client_old_with_token";
    const oldWithAppGrant = "client_old_with_app_grant";

    // (1) Old + grantless → the only reap target.
    await seedOauthClient({
      clientId: oldGrantless,
      createdAt: new Date(FIXED_NOW.getTime() - 45 * MS_PER_DAY),
    });
    // (2) Recent + grantless → inside the window, survives.
    await seedOauthClient({
      clientId: recentGrantless,
      createdAt: new Date(FIXED_NOW.getTime() - 5 * MS_PER_DAY),
    });
    // (3) Old but carries a live token pair → survives (grant signal).
    await seedOauthClient({
      clientId: oldWithToken,
      createdAt: new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY),
    });
    const tokenUser = "auth_user_token_holder";
    await seedAuthUser(tokenUser);
    await ctx.storage.oauthProvider?.mintTokenPair({
      accessTokenHash: hashApiKey("dcr-reaper-access", TEST_API_KEY_SALT),
      refreshTokenHash: hashApiKey("dcr-reaper-refresh", TEST_API_KEY_SALT),
      clientId: oldWithToken,
      authUserId: tokenUser,
      scopes: ["core.note:read"],
      accessTtlMs: 3_600_000,
    });
    // (4) Old but carries a projected system.connection app grant → survives.
    await seedOauthClient({
      clientId: oldWithAppGrant,
      createdAt: new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY),
    });
    await itemWrites(ctx.storage).create({
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "app",
        client_id: oldWithAppGrant,
        user_id: "some-user",
        scopes: ["core.note:read"],
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/dcr-reaper",
    });

    const cleaner = new DcrClientCleaner(ctx.storage, 30, () => FIXED_NOW);

    const deleted = await cleaner.runOnce();
    expect(deleted).toBe(1);

    expect(await oauthClientExists(oldGrantless)).toBe(false);
    expect(await oauthClientExists(recentGrantless)).toBe(true);
    expect(await oauthClientExists(oldWithToken)).toBe(true);
    expect(await oauthClientExists(oldWithAppGrant)).toBe(true);
  });

  it("is a no-op when retentionDays <= 0", async () => {
    await seedOauthClient({
      clientId: "client_disabled_job",
      createdAt: new Date(FIXED_NOW.getTime() - 365 * MS_PER_DAY),
    });
    const disabled = new DcrClientCleaner(ctx.storage, 0, () => FIXED_NOW);
    expect(await disabled.runOnce()).toBe(0);
    expect(await oauthClientExists("client_disabled_job")).toBe(true);
  });
});

/** Row-level existence for `api_keys`. `keys.get` suppresses revoked
 *  rows, so a revoked-but-present key is indistinguishable from a
 *  deleted one through the store. */
async function keyRowExists(keyId: string): Promise<boolean> {
  const st = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  // `__sqliteAll` takes no parameters, and a test table holds a handful
  // of rows, so read the ids and compare here rather than interpolating.
  const rows = (await st.__sqliteAll(`SELECT id FROM api_keys`)) as {
    id: string;
  }[];
  return rows.some((r) => r.id === keyId);
}

describe("RevokedKeyReaper.runOnce — behavioral", () => {
  it("drops long-revoked keys and leaves the young and the live alone", async () => {
    const oldRevoked = await ctx.storage.keys.create(
      {
        label: "old revoked",
        source: "probe:old",
        type_permissions: {},
        is_operator: true,
      },
      hashApiKey(`marfa_k1_oldRevoked`, TEST_API_KEY_SALT),
    );
    const youngRevoked = await ctx.storage.keys.create(
      {
        label: "young revoked",
        source: "probe:young",
        type_permissions: {},
        is_operator: true,
      },
      hashApiKey(`marfa_k1_youngRevoked`, TEST_API_KEY_SALT),
    );
    const live = await ctx.storage.keys.create(
      {
        label: "live",
        source: "probe:live",
        type_permissions: {},
        is_operator: true,
      },
      hashApiKey(`marfa_k1_live`, TEST_API_KEY_SALT),
    );

    const setRevoked = async (keyId: string, iso: string): Promise<void> => {
      const st = ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      };
      await st.__sqliteRun("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [
        iso,
        keyId,
      ]);
    };
    await setRevoked(
      oldRevoked.id,
      new Date(FIXED_NOW.getTime() - 31 * MS_PER_DAY).toISOString(),
    );
    await setRevoked(
      youngRevoked.id,
      new Date(FIXED_NOW.getTime() - 29 * MS_PER_DAY).toISOString(),
    );

    const reaper = new RevokedKeyReaper(ctx.storage, () => FIXED_NOW);
    expect(await reaper.runOnce()).toBe(1);

    // Read the table directly: `keys.get` hides revoked rows, so it
    // cannot tell "revoked" from "deleted" — which is the whole
    // distinction under test.
    expect(await keyRowExists(oldRevoked.id)).toBe(false);
    expect(await keyRowExists(youngRevoked.id)).toBe(true);
    expect(await keyRowExists(live.id)).toBe(true);
  });
});

describe("RevokedGrantPurger.runOnce — the revoked grant row sweep", () => {
  /**
   * A grant revoked through the user-facing path, which is the row this sweep
   * exists for. **`state` stays `active` deliberately** — the revoke writes
   * the status onto the properties and leaves the lifecycle alone so the
   * record survives as a record, which is exactly why neither the trash purge
   * nor the activity purge can reach it.
   */
  async function seedRevokedGrant(revokedAt: string) {
    const item = await itemWrites(ctx.storage).create({
      type: "system.connection",
      properties: {
        kind: "app",
        status: "revoked",
        granted_at: "2019-01-01T00:00:00.000Z",
        revoked_at: revokedAt,
        client_id: `client-${revokedAt}`,
      },
    });
    return item.id;
  }

  const OLD = "2020-01-01T00:00:00.000Z";
  const RECENT = new Date(Date.now() - 60_000).toISOString();
  const CUTOFF = "2021-01-01T00:00:00.000Z";

  it("removes an app grant row revoked before the window", async () => {
    const id = await seedRevokedGrant(OLD);
    const deleted = await itemWrites(
      ctx.storage,
    ).purgeRevokedAppGrantsOlderThan(CUTOFF);
    expect(deleted).toBe(1);
    await expect(ctx.storage.items.get(id)).resolves.toBeNull();
  });

  it("keeps one revoked inside the window", async () => {
    const id = await seedRevokedGrant(RECENT);
    await itemWrites(ctx.storage).purgeRevokedAppGrantsOlderThan(CUTOFF);
    expect(await ctx.storage.items.get(id)).not.toBeNull();
  });

  it("leaves a live grant alone, whatever its age", async () => {
    const live = await itemWrites(ctx.storage).create({
      type: "system.connection",
      properties: {
        kind: "app",
        status: "active",
        granted_at: "2019-01-01T00:00:00.000Z",
        client_id: "live",
      },
    });
    await itemWrites(ctx.storage).purgeRevokedAppGrantsOlderThan(CUTOFF);
    expect(await ctx.storage.items.get(live.id)).not.toBeNull();
  });

  it("is a no-op at retentionDays 0, like every other housekeeping job here", async () => {
    const id = await seedRevokedGrant(OLD);
    const purger = new RevokedGrantPurger(ctx.storage, 0);
    expect(await purger.runOnce()).toBe(0);
    expect(await ctx.storage.items.get(id)).not.toBeNull();
  });

  it("sweeps through the purger at its configured window", async () => {
    const id = await seedRevokedGrant(OLD);
    const purger = new RevokedGrantPurger(ctx.storage, 90);
    expect(await purger.runOnce()).toBe(1);
    await expect(ctx.storage.items.get(id)).resolves.toBeNull();
  });

  it("keeps an active grant that still carries an old revoked_at", async () => {
    // **This case exists because the mutation check found the suite passing
    // for the wrong reason.** Removing the `status = 'revoked'` predicate
    // reddened nothing, because the other live-grant case has no `revoked_at`
    // at all and so fails the date comparison regardless — it was testing the
    // date predicate twice and the status predicate never.
    //
    // A re-consent clears `revoked_at` when it flips the status back, so this
    // shape should not occur. That is the argument for pinning it rather than
    // against: if it ever does occur, the row is a LIVE grant and sweeping it
    // deletes an app's access with no revocation behind it.
    const resurrected = await itemWrites(ctx.storage).create({
      type: "system.connection",
      properties: {
        kind: "app",
        status: "active",
        granted_at: "2019-01-01T00:00:00.000Z",
        revoked_at: OLD,
        client_id: "revoked-then-reapproved",
      },
    });
    const deleted = await itemWrites(
      ctx.storage,
    ).purgeRevokedAppGrantsOlderThan(CUTOFF);
    expect(deleted).toBe(0);
    expect(await ctx.storage.items.get(resurrected.id)).not.toBeNull();
  });

  it("cannot be reached by the sweep that owns trash", async () => {
    // The needed correction: a predicate keyed on the item's `state` the
    // way the trash purge is matches none of these, because an
    // ordinarily-revoked grant sits at `state: "active"`.
    const id = await seedRevokedGrant(OLD);
    expect(await itemWrites(ctx.storage).purgeTrashedOlderThan(CUTOFF)).toBe(0);
    expect(await ctx.storage.items.get(id)).not.toBeNull();
  });
});
