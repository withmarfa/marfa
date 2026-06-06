/**
 * Grandfather profile rows for existing users.
 *
 * The migration `0044_users_profile_columns.sql` (PG) /
 * `0037_users_profile_columns.sql` (SQLite) does the schema-mechanical
 * part: add `first_name` / `last_name` / `bio` / `avatar_blob_hash` /
 * `auth_user_id`, backfill `auth_user_id` from `users.email` where a
 * matching `auth_user` exists, then drop `email` + `avatar_url`.
 *
 * This script handles the residue:
 *
 *   1. Every `auth_user` without a corresponding `users` row gets one
 *      provisioned (tenant + users + admin api key — same shape as a
 *      sign-up). Username is generated from `auth_user.email`'s local
 *      part, sanitised + collision-suffixed.
 *
 *   2. Every existing `users` row with `handle IS NULL` (and an
 *      `auth_user_id` from the migration's backfill) gets a username
 *      synthesised the same way.
 *
 * Idempotent — re-runs find zero rows needing work. Safe to run before
 * or after the column-drop migration: the script writes only to
 * `handle` / `auth_user_id` and creates rows that match the post-
 * migration shape.
 *
 * Usage:
 *   pnpm --filter @withmarfa/server tsx src/scripts/deprecated/grandfather-profiles-t074.ts --dialect=sqlite
 *   pnpm --filter @withmarfa/server tsx src/scripts/deprecated/grandfather-profiles-t074.ts --dialect=pg
 *
 * Environment:
 *   - SQLITE_PATH (sqlite default ./data/marfa.db)
 *   - DATABASE_URL (pg required)
 *   - API_KEY_SALT (required for the admin api key created per orphan
 *     auth_user — same value the server runs with, so the minted keys
 *     authenticate against the running instance).
 */
import { randomBytes } from "node:crypto";
import { isReservedHandle, isValidHandle } from "@withmarfa/shared";
import type { Storage } from "../../storage/interface.js";
import { hashApiKey } from "../../middleware/auth.js";

interface AuthUserRow {
  id: string;
  email: string;
  name: string | null;
}

interface Report {
  auth_users_scanned: number;
  users_created: number;
  handles_set: number;
  already_done: number;
  failed: number;
  failures: { id: string; reason: string }[];
}

/**
 * Sanitise an email local-part into a candidate handle. Lowercases,
 * replaces non-alphanumerics with hyphens, collapses runs of hyphens,
 * trims leading/trailing hyphens, truncates to 32 chars, and pads short
 * results with random hex so they meet the 3-char floor.
 */
function candidateFromEmail(email: string): string {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  let cleaned = local
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length < 3) {
    // Pad with random hex; bounded to keep the handle a stable shape.
    cleaned = (cleaned + randomBytes(2).toString("hex")).slice(0, 6);
  }
  if (cleaned.length > 32) cleaned = cleaned.slice(0, 32);
  // Truncation can leave a trailing hyphen — strip again.
  cleaned = cleaned.replace(/-+$/, "");
  if (cleaned.length < 3) cleaned = `user-${cleaned}`.slice(0, 32);
  return cleaned;
}

/**
 * Walk the candidate through reserved + collision checks, appending a
 * numeric suffix until clean. Bounded to a few hundred attempts so
 * pathological collision spaces don't infinite-loop.
 */
async function pickFreeHandle(
  storage: Storage,
  candidate: string,
): Promise<string> {
  if (!storage.users) {
    throw new Error("UserStore is required for grandfathering");
  }
  const userStore = storage.users;
  let base = candidate;
  // Reserved-handle suffix loop. We don't want to publish "admin" even
  // if no other user has claimed it.
  let i = 0;
  while (isReservedHandle(base) || !isValidHandle(base)) {
    i += 1;
    if (i > 100) {
      throw new Error(
        `Cannot derive a non-reserved handle from "${candidate}" after 100 tries`,
      );
    }
    base = `${candidate}-${String(i)}`.slice(0, 32);
  }
  // Collision-suffix loop. The unique index on `users.handle` is the
  // authoritative gate; the lookup here is best-effort.
  let suffix = 0;
  let attempt = base;
  while (await userStore.getByHandle(attempt)) {
    suffix += 1;
    if (suffix > 999) {
      throw new Error(
        `Cannot derive a non-colliding handle from "${candidate}" after 1000 tries`,
      );
    }
    const tail = `-${String(suffix)}`;
    attempt = (base + tail).slice(0, 32);
    // After truncation the suffix can land on a hyphen-only tail; strip.
    attempt = attempt.replace(/-+$/, "");
    if (!attempt.endsWith(String(suffix))) {
      // Truncation ate the suffix — back off the base by the tail length.
      attempt = (base.slice(0, 32 - tail.length) + tail).replace(/-+$/, "");
    }
  }
  return attempt;
}

/**
 * Read every auth_user row. Tiny script-only helper — uses the storage
 * facade's typed handles directly. Both dialects expose the underlying
 * drizzle handle as `betterAuthDb`; we run a parameter-free SELECT.
 */
async function listAuthUsers(storage: Storage): Promise<AuthUserRow[]> {
  const dialect = (storage as { betterAuthDialect?: string }).betterAuthDialect;
  if (dialect === "pg") {
    const db = (
      storage as unknown as {
        pgDb?: {
          execute: (q: unknown) => Promise<unknown>;
        };
      }
    ).pgDb;
    if (!db) throw new Error("pgDb missing on storage");
    const { sql } = await import("drizzle-orm");
    // postgres-js returns the rows array directly from `db.execute(...)`,
    // not wrapped in `{ rows }` like node-postgres does. Cast through
    // `unknown` so neither shape gives a false sense of safety.
    const result = (await db.execute(
      sql`SELECT id, email, name FROM auth_user`,
    )) as AuthUserRow[];
    return result.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
    }));
  }
  const all = (
    storage as unknown as {
      __sqliteAll?: (q: string) => Promise<
        {
          id: string;
          email: string;
          name: string | null;
        }[]
      >;
    }
  ).__sqliteAll;
  if (!all) throw new Error("sqlite __sqliteAll missing on storage");
  return all("SELECT id, email, name FROM auth_user");
}

/** Walk every users row that has a non-null auth_user_id but null handle. */
async function listUsersNeedingHandle(
  storage: Storage,
): Promise<{ id: string; auth_user_id: string }[]> {
  const dialect = (storage as { betterAuthDialect?: string }).betterAuthDialect;
  if (dialect === "pg") {
    const db = (
      storage as unknown as {
        pgDb?: {
          execute: (q: unknown) => Promise<unknown>;
        };
      }
    ).pgDb;
    if (!db) throw new Error("pgDb missing on storage");
    const { sql } = await import("drizzle-orm");
    // postgres-js returns the rows array directly (not `{ rows }`).
    return (await db.execute(
      sql`SELECT id, auth_user_id FROM users WHERE handle IS NULL AND auth_user_id IS NOT NULL`,
    )) as { id: string; auth_user_id: string }[];
  }
  const all = (
    storage as unknown as {
      __sqliteAll?: (q: string) => Promise<
        {
          id: string;
          auth_user_id: string;
        }[]
      >;
    }
  ).__sqliteAll;
  if (!all) throw new Error("sqlite __sqliteAll missing on storage");
  return all(
    "SELECT id, auth_user_id FROM users WHERE handle IS NULL AND auth_user_id IS NOT NULL",
  );
}

const KEY_PREFIX = "marfa_k1_";
function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

export async function grandfatherProfilesT074(
  storage: Storage,
  apiKeySalt: string,
): Promise<Report> {
  const report: Report = {
    auth_users_scanned: 0,
    users_created: 0,
    handles_set: 0,
    already_done: 0,
    failed: 0,
    failures: [],
  };
  if (!storage.users || !storage.tenants) {
    throw new Error(
      "UserStore + TenantStore are required (run against a hosted-mode storage)",
    );
  }
  const userStore = storage.users;
  const tenantStore = storage.tenants;

  // Pass 1: orphan auth_user rows that have no users row yet.
  const authUsers = await listAuthUsers(storage);
  for (const au of authUsers) {
    report.auth_users_scanned += 1;
    try {
      const existing = await userStore.getByAuthUserId(au.id);
      if (existing) {
        if (existing.handle) {
          report.already_done += 1;
        }
        // Pass 2 below picks up handle-NULL existing rows; nothing to do
        // here for those.
        continue;
      }
      const candidate = candidateFromEmail(au.email);
      const handle = await pickFreeHandle(storage, candidate);
      const tenant = await tenantStore.create(au.name ?? au.email);
      await userStore.create({
        name: au.name ?? undefined,
        provider: "better-auth",
        provider_id: au.id,
        tenant_id: tenant.id,
        handle,
        auth_user_id: au.id,
      });
      const rawKey = generateRawKey();
      await storage.keys.create(
        {
          label: "admin",
          source: "admin",
          role: "admin",
          type_permissions: { "*": "write" },
        },
        hashApiKey(rawKey, apiKeySalt),
        tenant.id,
      );
      report.users_created += 1;
      console.log(
        `[t074-grandfather] provisioned auth_user ${au.id} -> tenant ${tenant.id}, handle ${handle}`,
      );
    } catch (err) {
      report.failed += 1;
      report.failures.push({
        id: au.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      console.error(`[t074-grandfather] auth_user ${au.id} failed:`, err);
    }
  }

  // Pass 2: existing users rows that have auth_user_id but null handle.
  const needsHandle = await listUsersNeedingHandle(storage);
  for (const row of needsHandle) {
    try {
      const authEmail = await userStore.getAuthUserEmail(row.auth_user_id);
      if (!authEmail) {
        // FK was set but no auth_user row matches — odd state. Skip
        // loudly so an operator can investigate.
        report.failed += 1;
        report.failures.push({
          id: row.id,
          reason: `users.auth_user_id references missing auth_user ${row.auth_user_id}`,
        });
        continue;
      }
      const candidate = candidateFromEmail(authEmail.email);
      const handle = await pickFreeHandle(storage, candidate);
      await userStore.setHandle(row.id, handle);
      report.handles_set += 1;
      console.log(`[t074-grandfather] set handle ${handle} on users ${row.id}`);
    } catch (err) {
      report.failed += 1;
      report.failures.push({
        id: row.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      console.error(`[t074-grandfather] users ${row.id} failed:`, err);
    }
  }

  return report;
}

async function main(): Promise<void> {
  const dialect = process.argv.includes("--dialect=pg") ? "pg" : "sqlite";
  const apiKeySalt = process.env.API_KEY_SALT;
  if (!apiKeySalt) {
    throw new Error(
      "API_KEY_SALT is required so minted admin keys hash to the value the running server expects",
    );
  }
  let storage: Storage;
  if (dialect === "pg") {
    const { createPgStorage } = await import("../../storage/pg/index.js");
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for --dialect=pg");
    }
    storage = await createPgStorage(databaseUrl, { authMode: "hosted" });
  } else {
    const { createSqliteStorage } =
      await import("../../storage/sqlite/index.js");
    const sqlitePath = process.env.SQLITE_PATH ?? "./data/marfa.db";
    storage = await createSqliteStorage(sqlitePath, { authMode: "hosted" });
  }

  console.log(
    `[t074-grandfather] Scanning auth_user + users on ${dialect} storage...`,
  );
  const report = await grandfatherProfilesT074(storage, apiKeySalt);
  console.log("[t074-grandfather] Report:", JSON.stringify(report, null, 2));
  await storage.close();
  if (report.failed > 0) process.exitCode = 1;
}

if (
  import.meta.url ===
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  `file://${process.argv[1]!}`
) {
  void main();
}
