import { createApp } from "./app.js";
import { OidcSigner } from "./auth/oidc-signing.js";
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
 * T-131: seed an OAuth-bearer token end-to-end for tests that need
 * the bearer middleware to resolve an OAuth-issued token. Mirrors what
 * the old `storage.oauth.createClient` + `items.create` + `createToken`
 * three-step setup produced, but writes into the @better-auth/oauth-provider
 * plugin's tables (`auth_oauth_client`, `auth_oauth_access_token`).
 *
 * Returns the raw access token (with `myme_at_` prefix) and the
 * system.connection item id. The bearer middleware looks the token up
 * by `hashApiKey(token, TEST_API_KEY_SALT)` and resolves to the right
 * scope projection.
 *
 * @param scopes literal scope strings (e.g. `["core.note:read"]`)
 * @param opts.clientName    visible client name (defaults to "Test App")
 * @param opts.tenantId      tenant for the system.connection item
 *                           (defaults to undefined — keys-mode self-host)
 * @param opts.authUserId    Better Auth user id; if absent a synthetic
 *                           one is seeded into `auth_user`.
 */
export async function seedOauthBearer(
  storage: Storage,
  scopes: string[],
  opts: {
    clientName?: string;
    tenantId?: string;
    authUserId?: string;
  } = {},
): Promise<{ token: string; grantId: string; clientId: string }> {
  if (
    typeof storage.oauthProvider?.mintTokenPair !== "function" ||
    !storage.betterAuthDb
  ) {
    throw new Error(
      "seedOauthBearer requires storage.oauthProvider + betterAuthDb",
    );
  }

  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const clientPk = `client_pk_${Math.random().toString(36).slice(2, 10)}`;
  const clientName = opts.clientName ?? "Test App";
  const now = new Date();

  // Seed the OAuth client row directly (the plugin's own DCR endpoint
  // would create the same row — we shortcut for test setup speed).
  const dialect = storage.betterAuthDialect;
  const db = storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => { run?: () => Promise<unknown>; execute?: () => Promise<unknown> };
    };
  };

  // Seed a synthetic auth_user if the caller didn't provide one. The
  // bearer middleware doesn't actually need this row to exist (it reads
  // from `auth_oauth_access_token`), but the FK on user_id requires
  // it. Use a fixed-id row so re-seeds in the same test stay idempotent.
  const authUserId = opts.authUserId ?? `auth_user_${Math.random().toString(36).slice(2, 10)}`;
  if (!opts.authUserId) {
    // Use raw SQL via the storage escape hatches — auth_user.id is text
    // and we want a deterministic synthetic id. Skip if a row already
    // exists (unique email index would trip on a second test re-run
    // otherwise).
    if (dialect === "sqlite") {
      const sqlite = storage as unknown as {
        __sqliteRun?: (sql: string, params: unknown[]) => Promise<unknown>;
      };
      await sqlite.__sqliteRun?.(
        "INSERT OR IGNORE INTO auth_user (id, name, email, email_verified, created_at, updated_at, deletion_state) VALUES (?, ?, ?, 1, ?, ?, 'active')",
        [
          authUserId,
          "Test User",
          `${authUserId}@test.local`,
          Math.floor(now.getTime() / 1000),
          Math.floor(now.getTime() / 1000),
        ],
      );
    } else {
      const pg = storage as unknown as {
        __pgClient?: (sql: string, params?: unknown[]) => Promise<unknown>;
      };
      // postgres-js's parameterized API expects primitives; convert Date
      // → ISO string explicitly. The column is a TIMESTAMP and PG will
      // coerce the string transparently.
      await pg.__pgClient?.(
        "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at, deletion_state) VALUES ($1, $2, $3, true, $4, $4, 'active') ON CONFLICT (id) DO NOTHING",
        [authUserId, "Test User", `${authUserId}@test.local`, now.toISOString()],
      );
    }
  }

  // Seed the client row. We rely on the schema export for typing.
  // Both dialect tables have identical column names (mapped via the
  // Drizzle adapter); the runtime values differ (boolean vs integer
  // for `disabled` etc.). For simplicity we just write the minimum
  // required fields.
  const schemaModule = dialect === "pg"
    ? await import("./storage/pg/schema.js")
    : await import("./storage/sqlite/schema.js");
  const insertOp = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    name: clientName,
    redirectUris: JSON.stringify(["http://localhost:5173/callback"]),
    disabled: false,
    createdAt: now,
    updatedAt: now,
  } as Record<string, unknown>);
  await (insertOp.execute?.() ?? insertOp.run?.() ?? Promise.resolve());

  // Project the system.connection app-grant. The /security page reads
  // these directly; tests asserting on grant projection look for the
  // resulting item id.
  const grant = await storage.items.create(
    {
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "app",
        client_id: clientId,
        user_id: authUserId,
        scopes,
        status: "active",
        granted_at: now.toISOString(),
      },
      source: "test/oauth-bearer",
    },
    opts.tenantId,
  );

  // Mint the token pair via the plugin's storage helper. Uses the same
  // hash function as the bearer middleware.
  const rawToken = `myme_at_${Math.random().toString(36).slice(2)}_${String(Date.now())}`;
  const rawRefresh = `myme_rt_${Math.random().toString(36).slice(2)}_${String(Date.now())}`;
  const { hashApiKey } = await import("./middleware/auth.js");
  await storage.oauthProvider.mintTokenPair({
    accessTokenHash: hashApiKey(rawToken, TEST_API_KEY_SALT),
    refreshTokenHash: hashApiKey(rawRefresh, TEST_API_KEY_SALT),
    clientId,
    authUserId,
    referenceId: opts.tenantId ?? null,
    scopes,
    accessTtlMs: 3600_000,
  });

  return { token: rawToken, grantId: grant.id, clientId };
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

/**
 * T-079 — retry-poll helper for fire-and-forget audit assertions.
 *
 * Most route handlers emit audit rows via `void storage.audit.log(...)`
 * — the audit insert is intentionally off the critical path so it
 * doesn't add latency to every API call. Tests that immediately query
 * audit after the action will sometimes win the race against the
 * pending insert (typically on SQLite) and sometimes lose it
 * (consistently on slower PG). Rather than make `audit.log` awaitable
 * for production, tests poll briefly until the row appears.
 *
 * Pass either:
 *   - `{ filter }` — runs `storage.audit.list(filter)` until at least
 *     `min` rows match, OR
 *   - `{ probe }` — calls the user-supplied async probe (e.g. a
 *     `GET /audit?...` HTTP request) and asserts the predicate.
 *
 * Returns the final result so the caller can chain assertions.
 *
 * Bounded to ~2s with 25ms polls — long enough to cover any audit
 * insert latency on a loaded Docker Postgres, short enough that a real
 * regression (the row genuinely never lands) still surfaces fast.
 */
export async function waitForAudit<T>(
  probe: () => Promise<T>,
  predicate: (result: T) => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const intervalMs = options?.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let result = await probe();
  while (!predicate(result) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    result = await probe();
  }
  return result;
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
    authSessionCleanupIntervalMs: 3_600_000,
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
  // T-090: every test gets a real OIDC signer so id_token issuance and
  // JWKS endpoints behave the same as production.
  const oidcSigner = await OidcSigner.init(storage);
  const app = createApp(storage, blobBackend, config, undefined, oidcSigner);

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
    /**
     * Form-encoded body (mutually exclusive with `body`). Used by
     * OAuth 2.0 surfaces that must accept `application/x-www-form-urlencoded`
     * — `/auth/token`, `/auth/authorize` POST, `/auth/device/token`.
     */
    form?: Record<string, string | string[]>;
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
  if (options?.form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.form)) {
      if (Array.isArray(v)) for (const item of v) params.append(k, item);
      else params.append(k, v);
    }
    init.body = params.toString();
  } else if (options?.body !== undefined) {
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
