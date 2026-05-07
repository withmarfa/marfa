import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import { hashApiKey } from "./middleware/auth.js";
import type { Storage } from "./storage/interface.js";
import type { Hono } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Salt used by `createTestContext` for `hashApiKey`. Exposed so tests
 *  that mint additional api keys (e.g. for tenant-scoped admin coverage)
 *  hash with the same value the route auth resolver expects. */
export const TEST_API_KEY_SALT = "test-salt";
const SALT = TEST_API_KEY_SALT;

export interface TestContext {
  app: Hono<AppEnv>;
  storage: Storage;
  blobBackend: BlobBackend;
  adminKey: string;
  cleanup: () => void;
}

async function truncatePg(storage: Storage): Promise<void> {
  const s = storage as unknown as Record<string, unknown>;
  if (typeof s._pgTruncate === "function") {
    await (s._pgTruncate as () => Promise<void>)();
  }
}

/**
 * Wave C PR2 helper. With `requireEmailVerification: true` the auth
 * instance blocks sign-in until `auth_user.email_verified` is `true`.
 * Tests that exercise the post-sign-in flow (consent, OAuth, etc.)
 * call this between sign-up and sign-in to grandfather the test
 * account. Equivalent to a user clicking the verification link, but
 * without the round-trip through the email transport.
 *
 * Safe to call when the user doesn't exist — the UPDATE simply
 * affects zero rows.
 */
export async function markEmailVerified(
  storage: Storage,
  email: string,
): Promise<void> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const lower = email.toLowerCase();
  if (dialect === "pg") {
    const pg = storage as unknown as {
      __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    if (pg.__pgClient) {
      await pg.__pgClient(
        `UPDATE auth_user SET email_verified = TRUE WHERE LOWER(email) = $1`,
        [lower],
      );
    }
    return;
  }
  const sqlite = storage as unknown as {
    __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
  };
  if (sqlite.__sqliteRun) {
    await sqlite.__sqliteRun(
      "UPDATE auth_user SET email_verified = 1 WHERE LOWER(email) = ?",
      [lower],
    );
  }
}

/**
 * Wave C PR3 / T-033 test helper. Reads the latest reset-password
 * verification token from `auth_verification`. Better-auth keys these
 * rows as `identifier = "reset-password:${token}"` and `value =
 * userId`. Returns the most-recently-created token across any user;
 * tests typically have one in flight at a time. Returns `null` when
 * no row matches.
 *
 * The hook in `instance.ts` builds the email URL itself, so tests
 * can't intercept the HTTP send — instead they read the token from
 * the DB and submit it through the same `POST /auth/reset-password`
 * the user would.
 */
export async function readLatestResetToken(
  storage: Storage,
): Promise<string | null> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  if (dialect === "pg") {
    const pg = storage as unknown as {
      __pgClient?: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    if (!pg.__pgClient) return null;
    const rows = (await pg.__pgClient(
      `SELECT identifier FROM auth_verification
        WHERE identifier LIKE 'reset-password:%'
        ORDER BY created_at DESC LIMIT 1`,
    )) as { identifier: string }[];
    if (rows.length === 0) return null;
    return rows[0]?.identifier.slice("reset-password:".length) ?? null;
  }
  const sqlite = storage as unknown as {
    __sqliteAll?: (q: string) => Promise<unknown[]>;
  };
  if (!sqlite.__sqliteAll) return null;
  const rows = (await sqlite.__sqliteAll(
    `SELECT identifier FROM auth_verification
      WHERE identifier LIKE 'reset-password:%'
      ORDER BY created_at DESC LIMIT 1`,
  )) as { identifier: string }[];
  if (rows.length === 0) return null;
  return rows[0]?.identifier.slice("reset-password:".length) ?? null;
}

export async function createTestContext(
  overrides?: Partial<AppConfig>,
): Promise<TestContext> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-test-"));
  const blobPath = join(tmpDir, "blobs");

  let storage: Storage;
  if (dialect === "pg") {
    const databaseUrl =
      process.env.DATABASE_URL ??
      "postgres://myme:myme_dev@localhost:5434/myme";
    storage = await createPgStorage(databaseUrl);
    await truncatePg(storage);
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = await createSqliteStorage(dbPath);
  }

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const config: AppConfig = {
    port: 0,
    storageDialect: dialect as "sqlite" | "pg",
    sqlitePath: "",
    databaseUrl: "",
    blobPath,
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: SALT,
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "keys",
    versionSnapshotIntervalMs: 600_000,
    rateLimitEnabled: false,
    enableHsts: false,
    auditRetentionDays: 90,
    auditCleanupIntervalMs: 86_400_000,
    eventLogRetentionHours: 168,
    versionThinningIntervalMs: 3_600_000,
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
    versionWeeklySnapshotDays: 365,
    versionMaxVersions: 500,
    trashRetentionDays: 60,
    trashPurgeIntervalMs: 3_600_000,
    feedRetentionDays: 0,
    feedExpiryIntervalMs: 3_600_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:0",
    authAllowSignup: true,
    authSecret: "test-auth-secret-change-in-production-not-required-here",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    oauthRedirectAllowlist: [],
    ...overrides,
  };
  const app = createApp(storage, blobBackend, config);

  // Create a bootstrap admin key (unique per test context to avoid PG conflicts)
  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = `myme_k1_test_admin_key_${suffix}`;
  const keyHash = hashApiKey(rawKey, SALT);
  await storage.keys.create(
    {
      label: "test-admin",
      source: `test-admin-${suffix}`,
      role: "admin",
      type_permissions: {},
      // TSC42 §1: items created without an explicit `tier` default to the
      // library tier ("save it"). The test admin matches that default;
      // tests that need feed items pass `tier: "feed"` on create.
      default_tier: "library",
      // The bootstrap admin in tests stands in for the platform credential —
      // tests need to register core.evaluator-* helper types and exercise
      // system.* / handle paths.
      is_platform: true,
    },
    keyHash,
  );
  // Match what POST /keys would do on a real bootstrap call — stamp the
  // workspace sentinel so subsequent POST /keys calls in this context
  // require admin auth instead of re-entering bootstrap mode.
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    blobBackend,
    adminKey: rawKey,
    cleanup: () => {
      void storage.close();
    },
  };
}

export function request(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
    key?: string;
    /**
     * Peer remote address — synthesised onto Hono's `c.env.incoming.socket`
     * so `clientIpMiddleware` (T-027) sees a deterministic value. Without
     * this, `app.request()` produces a context with no peer and tests
     * can't exercise the audit-row IP stamping path.
     */
    peer?: string;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    ...options?.headers,
  };

  if (options?.key) {
    headers.Authorization = `Bearer ${options.key}`;
  }

  const init: RequestInit = { method, headers };
  if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  // Hono's `app.request(input, init, Env)` accepts a third arg that's
  // merged into `c.env`. node-server normally provides `incoming.socket`
  // there at runtime; in-process tests don't, so synthesise it when a
  // peer is requested. This is the seam getClientIp reads.
  const env = options?.peer
    ? { incoming: { socket: { remoteAddress: options.peer } } }
    : undefined;
  return Promise.resolve(app.request(path, init, env));
}
