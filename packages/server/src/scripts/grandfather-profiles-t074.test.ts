import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createPgStorage } from "../storage/pg/index.js";
import type { Storage } from "../storage/interface.js";
import { grandfatherProfilesT074 } from "./grandfather-profiles-t074.js";

/**
 * T-074: grandfather script coverage.
 *
 * Failure modes this catches:
 *
 *   - orphan auth_user rows left without `users` rows after run
 *     (would lock a real user out of /profile/me)
 *   - users rows left with NULL handle (would 4xx the new endpoints)
 *   - non-idempotent re-run (a second pass mutates state when it shouldn't)
 *   - reserved-name collisions silently accepted into `users.handle`
 *   - candidate-from-email mangling that produces an invalid handle
 *     shape (regex test for the candidate-derivation function lives
 *     here rather than in a separate file because the script is the
 *     only consumer)
 */

interface Ctx {
  storage: Storage;
  cleanup: () => Promise<void>;
}

async function makeStorage(): Promise<Ctx> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-grandfather-test-"));
  let storage: Storage;
  if (dialect === "pg") {
    const databaseUrl =
      process.env.DATABASE_URL ??
      "postgres://myme:myme_dev@localhost:5434/myme";
    storage = await createPgStorage(databaseUrl, { authMode: "hosted" });
    const s = storage as unknown as Record<string, unknown>;
    if (typeof s._pgTruncate === "function") {
      await (s._pgTruncate as () => Promise<void>)();
    }
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = createSqliteStorage(dbPath, { authMode: "hosted" });
  }
  return {
    storage,
    cleanup: async () => {
      await storage.close();
    },
  };
}

async function insertAuthUser(
  storage: Storage,
  row: { id: string; email: string; name?: string | null },
): Promise<void> {
  const dialect = (storage as { betterAuthDialect?: string }).betterAuthDialect;
  const now = new Date();
  if (dialect === "pg") {
    const db = (
      storage as unknown as {
        pgDb?: { execute: (q: unknown) => Promise<unknown> };
      }
    ).pgDb;
    if (!db) throw new Error("pgDb missing");
    const { sql } = await import("drizzle-orm");
    await db.execute(
      sql`INSERT INTO auth_user (id, email, name, email_verified, created_at, updated_at) VALUES (${row.id}, ${row.email}, ${row.name ?? "Test"}, ${true}, ${now}, ${now})`,
    );
    return;
  }
  const runner = (
    storage as unknown as {
      __sqliteRun?: (q: string, p: unknown[]) => { changes: number };
    }
  ).__sqliteRun;
  if (!runner) throw new Error("sqlite run missing");
  runner(
    "INSERT INTO auth_user (id, email, name, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [row.id, row.email, row.name ?? "Test", 1, now.getTime(), now.getTime()],
  );
}

const SALT = "test-salt-grandfather";

describe("grandfatherProfilesT074", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await makeStorage();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("provisions tenant + users + admin key for an orphan auth_user row", async () => {
    const id = `auth_${randomBytes(4).toString("hex")}`;
    await insertAuthUser(ctx.storage, {
      id,
      email: "alice.smith@example.com",
      name: "Alice Smith",
    });

    const before = await ctx.storage.users!.getByAuthUserId(id);
    expect(before).toBeNull();

    const report = await grandfatherProfilesT074(ctx.storage, SALT);
    expect(report.users_created).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);

    const after = await ctx.storage.users!.getByAuthUserId(id);
    expect(after).not.toBeNull();
    expect(after?.handle).toBe("alice-smith");
    expect(after?.tenant_id).toBeTruthy();
  });

  it("appends a numeric suffix on handle collisions", async () => {
    // Pre-claim "popular" by an existing user.
    const tenant = await ctx.storage.tenants!.create("Pre-Claim Tenant");
    await ctx.storage.users!.create({
      name: "Pre-claim",
      provider: "test",
      provider_id: "preclaim",
      tenant_id: tenant.id,
      handle: "popular",
    });

    // Now provision an orphan auth_user whose email local-part also
    // sanitises to "popular". The script must derive a non-colliding
    // handle automatically.
    const id = `auth_${randomBytes(4).toString("hex")}`;
    await insertAuthUser(ctx.storage, {
      id,
      email: "popular@example.com",
    });
    const report = await grandfatherProfilesT074(ctx.storage, SALT);
    expect(report.failed).toBe(0);
    const row = await ctx.storage.users!.getByAuthUserId(id);
    expect(row?.handle).toMatch(/^popular(?:-\d+)?$/);
    expect(row?.handle).not.toBe("popular");
  });

  it("avoids reserved handles by suffixing", async () => {
    const id = `auth_${randomBytes(4).toString("hex")}`;
    // `admin` is in RESERVED_HANDLE_WORDS — local-part of this email
    // sanitises straight to it.
    await insertAuthUser(ctx.storage, {
      id,
      email: "admin@example.com",
    });
    const report = await grandfatherProfilesT074(ctx.storage, SALT);
    expect(report.failed).toBe(0);
    const row = await ctx.storage.users!.getByAuthUserId(id);
    expect(row?.handle).toBeTruthy();
    expect(row?.handle).not.toBe("admin");
    expect(row?.handle?.startsWith("admin-")).toBe(true);
  });

  it("sets handle on existing users rows that have null handle", async () => {
    // Create an auth_user + an existing users row bound by auth_user_id
    // but no handle yet (the migration's email-match backfilled the FK
    // but the original users row never got a handle).
    const id = `auth_${randomBytes(4).toString("hex")}`;
    await insertAuthUser(ctx.storage, {
      id,
      email: "kate@example.com",
      name: "Kate",
    });
    const tenant = await ctx.storage.tenants!.create("Kate's Tenant");
    const user = await ctx.storage.users!.create({
      name: "Kate",
      provider: "legacy",
      provider_id: id,
      tenant_id: tenant.id,
      auth_user_id: id,
      // handle deliberately omitted
    });
    expect(user.handle).toBeNull();

    const report = await grandfatherProfilesT074(ctx.storage, SALT);
    expect(report.handles_set).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);

    const refreshed = await ctx.storage.users!.getByAuthUserId(id);
    expect(refreshed?.handle).toBe("kate");
  });

  it("is idempotent — re-running produces no further work", async () => {
    // First run does the work; second run finds nothing.
    const before = await grandfatherProfilesT074(ctx.storage, SALT);
    void before;
    const second = await grandfatherProfilesT074(ctx.storage, SALT);
    expect(second.users_created).toBe(0);
    expect(second.handles_set).toBe(0);
    expect(second.failed).toBe(0);
  });
});
