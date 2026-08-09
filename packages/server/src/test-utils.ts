import { createApp } from "./app.js";
import { consentLockDepth } from "./auth/consent-lock.js";
import { OidcSigner } from "./auth/oidc-signing.js";
import type { AppConfig } from "./config.js";
import type { EmailTransport } from "./email/transport.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { cloneTemplate } from "./storage/pg/test-template.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import { hashApiKey } from "./middleware/auth.js";
import type { Storage } from "./storage/interface.js";
import type { Hono } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BulkActionWorker } from "./bulk-actions/index.js";
import type { BulkActionJob, BulkActionResult } from "./bulk-actions/types.js";

/** Salt used by `createTestContext` for `hashApiKey`. Exposed so tests
 *  that mint additional api keys (e.g. for space-scoped admin coverage)
 *  hash with the same value the route auth resolver expects. */
export const TEST_API_KEY_SALT = "test-salt";
const SALT = TEST_API_KEY_SALT;

/**
 * Resolve the raw-SQL test escape hatches off the storage object, throwing
 * if they're absent. These are test-only internals (`__sqliteRun` /
 * `__pgClient`) the storage layer exposes for direct setup writes. An
 * earlier version silently no-op'd when they were missing — so a change to
 * the storage shape would quietly skip the setup and surface as a confusing
 * downstream failure. Fail loudly instead.
 */
function requireSqliteRun(
  storage: Storage,
): (sql: string, params: unknown[]) => Promise<unknown> {
  const s = storage as unknown as {
    __sqliteRun?: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  if (!s.__sqliteRun) {
    throw new Error(
      "test-utils: storage.__sqliteRun escape hatch missing — SQLite test storage internals changed",
    );
  }
  return s.__sqliteRun;
}

function requirePgClient(
  storage: Storage,
): (sql: string, params?: unknown[]) => Promise<unknown> {
  const s = storage as unknown as {
    __pgClient?: (sql: string, params?: unknown[]) => Promise<unknown>;
  };
  if (!s.__pgClient) {
    throw new Error(
      "test-utils: storage.__pgClient escape hatch missing — PG test storage internals changed",
    );
  }
  return s.__pgClient;
}

export interface TestContext {
  app: Hono<AppEnv>;
  storage: Storage;
  blobBackend: BlobBackend;
  adminKey: string;
  /** Awaitable cleanup. Callers that don't `await` still trigger the
   *  cleanup (the promise is created immediately), but unawaited
   *  cleanups queue against admin-URL DROPs from other test files and
   *  can starve afterAll hooks. Best practice: `await ctx.cleanup()`. */
  cleanup: () => Promise<void>;
}

/**
 * Clone the PG template database and build a Storage against it. Returns
 * the storage plus an awaitable cleanup callback that closes the pool
 * and drops the clone with `WITH (FORCE)` so any lingering connections
 * are terminated.
 *
 * Used by `createTestContext` for the standard path and by the few test
 * files that roll their own storage (custom `authMode`, etc.) instead
 * of going through `createTestContext`.
 *
 * Cleanup is async + awaitable. With parallel test files all doing
 * per-test clone/drop traffic against the same admin URL, an unawaited
 * fire-and-forget drop queues against everyone else's drops; the
 * afterAll hooks of long-running files can sit behind a multi-second
 * queue. Awaiting cleanup bounds per-file work.
 */
export async function createPgTestStorage(options?: {
  versionSnapshotIntervalMs?: number;
  authMode?: "hosted" | "keys";
  /** Override the default pool-size cap. Default is 3 — see comment
   *  inside this function for the rationale. */
  maxPoolSize?: number;
}): Promise<{ storage: Storage; cleanup: () => Promise<void> }> {
  const clone = await cloneTemplate();
  // Cap at 3 connections per test file. With ~CPU-count parallel workers,
  // the default max=10 quickly exhausts Postgres's default max_connections=100.
  // Skip bootstrap — the cloned DB already has the schema baked in from the
  // template, saving hundreds of ms per storage creation under parallel load.
  const storage = await createPgStorage(clone.url, {
    ...options,
    maxPoolSize: options?.maxPoolSize ?? 3,
    skipBootstrap: true,
  });
  return {
    storage,
    cleanup: async () => {
      // Run close + drop in parallel, bounded by 5s. DROP uses WITH (FORCE)
      // which terminates lingering pool connections — so it doesn't depend on
      // storage.close() succeeding. Pool-close can hang when in-flight SSE /
      // export streams delay postgres-js teardown; the timeout keeps afterAll
      // hooks from blocking indefinitely.
      const closePromise = storage.close().catch(() => undefined);
      const dropPromise = clone.drop().catch(() => undefined);
      const bound = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 5_000);
      });
      await Promise.race([
        Promise.all([closePromise, dropPromise]).then(() => undefined),
        bound,
      ]);
    },
  };
}

/**
 * Seed an OAuth-bearer token end-to-end for tests that need the bearer
 * middleware to resolve an OAuth-issued token. Writes into the
 * @better-auth/oauth-provider plugin's tables (`auth_oauth_client`,
 * `auth_oauth_access_token`).
 *
 * Returns the raw access token (with `marfa_at_` prefix) and the
 * system.connection item id. The bearer middleware looks the token up
 * by `hashApiKey(token, TEST_API_KEY_SALT)` and resolves to the right
 * scope projection.
 *
 * @param scopes literal scope strings (e.g. `["core.note:read"]`)
 * @param opts.clientName    visible client name (defaults to "Test App")
 * @param opts.spaceId      space for the system.connection item
 *                           (defaults to undefined — keys-mode self-host)
 * @param opts.authUserId    Better Auth user id; if absent a synthetic
 *                           one is seeded into `auth_user`.
 * @param opts.userRole      Optionally seed a `users` row bound to the
 *                           `auth_user` with this role. Without it, no
 *                           `users` row is created and the bearer
 *                           middleware falls back to `member` projection.
 *                           Hosted-mode storage only (no-op when the
 *                           storage doesn't expose `users`).
 */
export async function seedOauthBearer(
  storage: Storage,
  scopes: string[],
  opts: {
    clientName?: string;
    spaceId?: string;
    authUserId?: string;
    userRole?: "admin" | "space_admin" | "member";
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
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };

  // Bearer middleware reads from auth_oauth_access_token, not auth_user,
  // but the FK on user_id requires the row to exist.
  const authUserId =
    opts.authUserId ?? `auth_user_${Math.random().toString(36).slice(2, 10)}`;
  if (!opts.authUserId) {
    if (dialect === "sqlite") {
      await requireSqliteRun(storage)(
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
      await requirePgClient(storage)(
        "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at, deletion_state) VALUES ($1, $2, $3, true, $4, $4, 'active') ON CONFLICT (id) DO NOTHING",
        [
          authUserId,
          "Test User",
          `${authUserId}@test.local`,
          now.toISOString(),
        ],
      );
    }
  }

  const schemaModule =
    dialect === "pg"
      ? await import("./storage/pg/schema.js")
      : await import("./storage/sqlite/schema.js");
  // PG: `redirect_uris` is native `text[]` (migration 0059); SQLite:
  // plain `text` with JSON-serialized array via the Better Auth adapter.
  const redirectUrisValue: unknown =
    dialect === "pg"
      ? ["http://localhost:5173/callback"]
      : JSON.stringify(["http://localhost:5173/callback"]);
  const insertOp = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    name: clientName,
    redirectUris: redirectUrisValue,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  });
  await (insertOp.execute?.() ?? insertOp.run?.() ?? Promise.resolve());

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
    opts.spaceId,
  );

  // Mint the token pair via the plugin's storage helper. Hash the BARE
  // (prefix-stripped) token to match what the plugin's `storeTokens.hash`
  // does — see middleware/auth.ts bearer path + the device-flow terminal
  // in routes/auth-pages.ts for the canonical convention.
  const rawToken = `marfa_at_${Math.random().toString(36).slice(2)}_${String(Date.now())}`;
  const rawRefresh = `marfa_rt_${Math.random().toString(36).slice(2)}_${String(Date.now())}`;
  const { hashApiKey } = await import("./middleware/auth.js");
  await storage.oauthProvider.mintTokenPair({
    accessTokenHash: hashApiKey(
      rawToken.slice("marfa_at_".length),
      TEST_API_KEY_SALT,
    ),
    refreshTokenHash: hashApiKey(
      rawRefresh.slice("marfa_rt_".length),
      TEST_API_KEY_SALT,
    ),
    clientId,
    authUserId,
    referenceId: opts.spaceId ?? null,
    scopes,
    accessTtlMs: 3600_000,
  });

  if (opts.userRole) {
    if (!storage.users) {
      throw new Error(
        "seedOauthBearer({ userRole }) requires hosted-mode storage with a UserStore",
      );
    }
    if (!opts.spaceId) {
      throw new Error(
        "seedOauthBearer({ userRole }) requires opts.spaceId (users.space_id is FK-bound)",
      );
    }
    await storage.users.create({
      provider: "test",
      provider_id: authUserId,
      space_id: opts.spaceId,
      auth_user_id: authUserId,
      role: opts.userRole,
    });
  }

  return { token: rawToken, grantId: grant.id, clientId };
}

/**
 * Mark a user's email verified. With `requireEmailVerification: true`
 * the auth instance blocks sign-in until `auth_user.email_verified` is
 * `true`. Tests that exercise the post-sign-in flow (consent, OAuth,
 * etc.) call this between sign-up and sign-in to skip the email
 * round-trip.
 *
 * Safe to call when the user doesn't exist — the UPDATE simply
 * affects zero rows.
 */
export async function markEmailVerified(
  storage: Storage,
  email: string,
): Promise<void> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  const lower = email.toLowerCase();
  if (dialect === "pg") {
    await requirePgClient(storage)(
      `UPDATE auth_user SET email_verified = TRUE WHERE LOWER(email) = $1`,
      [lower],
    );
    return;
  }
  await requireSqliteRun(storage)(
    "UPDATE auth_user SET email_verified = 1 WHERE LOWER(email) = ?",
    [lower],
  );
}

/**
 * Read the latest reset-password verification token from
 * `auth_verification`. Better-auth keys these rows as
 * `identifier = "reset-password:${token}"` and `value = userId`.
 * Returns the most-recently-created token across any user; tests
 * typically have one in flight at a time. Returns `null` when no row
 * matches.
 *
 * The hook in `instance.ts` builds the email URL itself, so tests
 * read the token from the DB and submit it directly to
 * `POST /auth/reset-password`.
 */
export async function readLatestResetToken(
  storage: Storage,
): Promise<string | null> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
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
 * Retry-poll helper for fire-and-forget audit assertions.
 *
 * Most route handlers emit audit rows via `void storage.audit.log(...)`
 * — the audit insert is off the critical path. Tests that immediately
 * query audit after an action may lose the race against the pending
 * insert. Rather than make `audit.log` awaitable for production, tests
 * poll briefly until the row appears.
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

/**
 * Longest a competing request may take to reach the consent lock before
 * the caller treats it as a failure. Generous on purpose: it only has to
 * outlast the slowest legitimate arrival on a loaded machine, and
 * exhausting it means the request never got there at all, which is a real
 * problem and is reported as one rather than passed over.
 */
const LOCK_ARRIVAL_BUDGET_MS = 10_000;

/**
 * Block until `expected` callers are holding or queued on the
 * (client, user) consent lock.
 *
 * Tests that pin an interleaving need the competing request to be waiting
 * on the lock before they release the request holding it. Observing the
 * arrival is what makes that a fact. Pausing for a fixed span instead
 * proves nothing either way: a request that arrives after the holder has
 * already finished leaves the same end state as one that arrived in time,
 * so the assertions still pass while the race goes untested — and on a
 * loaded machine, late is the ordering a fixed pause actually produces.
 */
export async function waitForConsentLockDepth(
  clientId: string,
  authUserId: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + LOCK_ARRIVAL_BUDGET_MS;
  while (consentLockDepth(clientId, authUserId) < expected) {
    if (Date.now() >= deadline) {
      throw new Error(
        `competing request never reached the consent lock: depth ` +
          `${String(consentLockDepth(clientId, authUserId))}, expected ` +
          `${String(expected)}, after ${String(LOCK_ARRIVAL_BUDGET_MS)}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function createTestContext(
  overrides?: Partial<AppConfig>,
  /**
   * Optional email transport. Wired into `createApp` as the 4th arg.
   * Production boots a real transport via `createEmailTransport`; tests
   * pass a spy to assert on send calls (e.g. the deletion-guard cancel
   * email). Left undefined, email-dependent flows behave as if no
   * transport is configured — the existing default for most tests.
   */
  emailTransport?: EmailTransport,
): Promise<TestContext> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-test-"));
  const blobPath = join(tmpDir, "blobs");

  const storageAuthMode: "keys" | "hosted" = overrides?.authMode ?? "keys";
  let storage: Storage;
  let pgCleanup: (() => Promise<void>) | undefined;
  if (dialect === "pg") {
    const clone = await createPgTestStorage({ authMode: storageAuthMode });
    storage = clone.storage;
    pgCleanup = clone.cleanup;
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = await createSqliteStorage(dbPath, { authMode: storageAuthMode });
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
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: SALT,
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "keys",
    mcpEnabled: true,
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
    errorWebhookTimeoutMs: 5000,
    reactiveRunSendTimeoutMs: 5000,
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:0",
    authAllowSignup: true,
    seedStarterContent: false,
    authSecret: "test-auth-secret-change-in-production-not-required-here",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    ...overrides,
  };
  const oidcSigner = await OidcSigner.init(storage);
  const app = createApp(
    storage,
    blobBackend,
    config,
    emailTransport,
    oidcSigner,
  );

  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = `marfa_k1_test_admin_key_${suffix}`;
  const keyHash = hashApiKey(rawKey, SALT);
  await storage.keys.create(
    {
      label: "test-admin",
      source: `test-admin-${suffix}`,
      role: "admin",
      type_permissions: {},
      default_tier: "library",
      // Tests need to register helper types and exercise system.* paths.
      is_platform: true,
    },
    keyHash,
  );
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    blobBackend,
    adminKey: rawKey,
    cleanup: async () => {
      if (pgCleanup) {
        await pgCleanup();
      } else {
        try {
          await storage.close();
        } catch {
          // Best-effort.
        }
      }
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
     * — `/auth/oauth2/token`, `/auth/authorize` POST, `/auth/device/token`.
     */
    form?: Record<string, string | string[]>;
    headers?: Record<string, string>;
    key?: string;
    /**
     * Peer remote address — synthesized onto Hono's `c.env.incoming.socket`
     * so `clientIpMiddleware` sees a deterministic value. Without this,
     * `app.request()` produces a context with no peer and tests can't
     * exercise the audit-row IP stamping path.
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

  // `c.env.incoming.socket` is normally provided by node-server at runtime;
  // synthesize it here so getClientIp has a peer to read.
  const env = options?.peer
    ? { incoming: { socket: { remoteAddress: options.peer } } }
    : undefined;
  return Promise.resolve(app.request(path, init, env));
}

/**
 * Drive `POST /items/bulk-actions` through to a terminal state
 * synchronously for tests. The async endpoint returns 202 + a job
 * envelope; this helper drains the in-process worker by calling
 * `runOnce()` until the queue is empty, then GETs the final job state,
 * and returns the unwrapped `BulkActionResult` so test assertions on
 * `succeeded` / `matched` / `ids` / `errors` / `blob_hashes_referenced`
 * work without restructuring.
 *
 * For dry_run requests the server stays synchronous; the helper just
 * passes through the 200 response.
 *
 * Error paths (400 / 401 / 403) are returned as-is via `errorResponse`.
 *
 * Returns:
 *   - `initialStatus`: status of the initial POST (200 for dry_run /
 *     error, 202 for queued).
 *   - `result`: the BulkActionResult once terminal-completed. Absent
 *     when the job ended in `cancelled` / `failed`.
 *   - `job`: the final BulkActionJob envelope (terminal state); absent
 *     for dry_run and error paths.
 *   - `errorResponse`: the error body when the POST was non-2xx.
 */
export async function runBulkActionAsync(
  ctx: TestContext,
  body: Record<string, unknown>,
  key: string,
): Promise<{
  initialStatus: number;
  result?: BulkActionResult;
  job?: BulkActionJob;
  errorResponse?: { error: { code: string; message: string } };
}> {
  const res = await request(ctx.app, "POST", "/items/bulk-actions", {
    body,
    key,
  });
  if (res.status === 200) {
    return {
      initialStatus: 200,
      result: (await res.json()) as BulkActionResult,
    };
  }
  if (res.status !== 202) {
    return {
      initialStatus: res.status,
      errorResponse: (await res.json()) as {
        error: { code: string; message: string };
      },
    };
  }
  const queued = (await res.json()) as BulkActionJob;

  const worker = new BulkActionWorker({
    storage: ctx.storage,
    chunkSize: 100,
    pollIntervalMs: 1, // unused — we never call start()
  });
  while (await worker.runOnce()) {
    /* keep draining */
  }

  const finalRes = await request(
    ctx.app,
    "GET",
    `/items/bulk-actions/jobs/${queued.id}`,
    { key },
  );
  if (finalRes.status !== 200) {
    return {
      initialStatus: 202,
      errorResponse: (await finalRes.json()) as {
        error: { code: string; message: string };
      },
    };
  }
  const finalJob = (await finalRes.json()) as BulkActionJob;
  return {
    initialStatus: 202,
    job: finalJob,
    ...(finalJob.result ? { result: finalJob.result } : {}),
  };
}
