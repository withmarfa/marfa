import { PERMISSIONS } from "@withmarfa/shared";
import type { CreateKeyInput } from "@withmarfa/shared";
import { createApp } from "./app.js";
import { ensureInstanceId } from "./storage/instance-id.js";
import { consentLockDepth } from "./auth/consent-lock.js";
import type { AppConfig } from "./config.js";
import type { MarfaAuth } from "./auth/instance.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createBlobLayer } from "./storage/blob-layer.js";
import type { BlobLayer } from "./storage/blob-layer.js";
import { DiskBlobStore, type BlobStore } from "./storage/blob-store.js";
import type { Stores } from "./housekeeping/blob-delete.js";
import { Housekeeping } from "./housekeeping/scheduler.js";
import { hashApiKey } from "./middleware/auth.js";
import type { PersistedEvent, Storage } from "./storage/interface.js";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import type { ApiKey } from "@withmarfa/shared";
import { eventRoutes } from "./routes/events.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subscribe, subscribeEdges } from "./pubsub.js";
import type { EdgeEventWithId, ItemEventWithId } from "./pubsub.js";
import { BulkActionWorker } from "./bulk-actions/index.js";
import type { BulkActionJob, BulkActionResult } from "./bulk-actions/types.js";

/**
 * Replace every `$ref` in a slice of the OpenAPI document with the schema it
 * names, so a check that reads what an operation declares reads the whole of
 * it.
 *
 * A shape the document registers as a component reaches an operation as a
 * reference, so a check that walks the operation alone sees `$ref` and
 * nothing of what it names.
 *
 * A cycle is left as the reference it is: the reference has already been
 * followed once on this path, so the caller has seen the shape. A reference
 * the document does not define throws instead, because a check reading an
 * unresolved one sees an operation that declares nothing — which is how a
 * door escapes a census rather than failing it.
 *
 * Keys beside a `$ref` are dropped, as a 3.1 reader that does not merge
 * them would drop them. Nothing in this document writes any.
 */
export function inlineOpenApiRefs(
  node: unknown,
  document: Record<string, unknown>,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => inlineOpenApiRefs(child, document, seen));
  }
  if (node === null || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string") {
    if (seen.has(ref)) return node;
    const target = ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>(
        (carry, segment) =>
          carry === null || typeof carry !== "object"
            ? undefined
            : (carry as Record<string, unknown>)[
                segment.replace(/~1/g, "/").replace(/~0/g, "~")
              ],
        document,
      );
    if (target === undefined) {
      throw new Error(`The document has no ${ref} to resolve.`);
    }
    return inlineOpenApiRefs(target, document, new Set([...seen, ref]));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = inlineOpenApiRefs(value, document, seen);
  }
  return out;
}

/** Salt used by `createTestContext` for `hashApiKey`. Exposed so tests
 *  that mint additional api keys (e.g. for administrative coverage)
 *  hash with the same value the route auth resolver expects. */
export const TEST_API_KEY_SALT = "test-salt";
const SALT = TEST_API_KEY_SALT;

/**
 * Resolve the raw-SQL test escape hatch off the storage object, throwing
 * if it is absent. It is a test-only internal (`__sqliteRun`) the storage
 * layer exposes for direct setup writes. Loud rather than a no-op, so a
 * change to the storage shape cannot quietly skip the setup and surface
 * as a confusing downstream failure.
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

/**
 * What `createApp` really returns. Declared rather than narrowed to `Hono`
 * so a test can ask the app for its OpenAPI document — the route
 * declarations are what decides which doors take a credential, and a test
 * that reads them needs the reflection the narrower type hides.
 */
export type TestApp = ReturnType<typeof createApp>;

export interface TestContext {
  app: TestApp;
  storage: Storage;
  blobs: BlobLayer;
  /** The scheduler behind `/housekeeping`, with nothing registered and not
   *  started: a test registers what it wants to see run. */
  housekeeping: Housekeeping;
  /** What the app was built with, so a test can build a second app over
   *  the same database. */
  config: AppConfig;
  /**
   * The instance tier, and nothing else: no permissions, exactly what the
   * one unauthenticated mint hands back. It opens the instance routes and
   * reaches no content at all, so a test about anything inside the
   * permission model wants `workingKey`.
   */
  operatorKey: string;
  /**
   * A working credential holding every permission and writing every
   * content family — what the operator mints first through `POST /keys`.
   * This is the suite's working credential: content, the permissions,
   * everything but the instance routes.
   */
  workingKey: string;
  /** The per-context temporary directory holding the sqlite database and
   *  the blob root. Exposed so a test can assert on its lifetime; removed
   *  by `cleanup`. */
  tmpDir: string;
  /** Awaitable cleanup. Callers that don't `await` still trigger the
   *  cleanup (the promise is created immediately), but the hook then
   *  returns and the worker can be torn down before `storage.close()`
   *  settles, so the `finally` that removes the directory never runs and
   *  it leaks. Best practice: `await ctx.cleanup()`. */
  cleanup: () => Promise<void>;
  /** The Better Auth instance the app mounted, for tests that need a
   *  signed-in user behind the OAuth provider. `createTestAccount` is the
   *  usual way in. */
  auth: MarfaAuth;
}

/**
 * Close a file's accumulated test contexts eight at a time, so a file
 * holding many of them does not spend its whole hook budget closing them
 * one by one, and does not close them all at once either.
 */
export async function closeTestContexts(
  contexts: readonly { cleanup: () => Promise<void> }[],
): Promise<void> {
  const CONCURRENCY = 8;
  for (let i = 0; i < contexts.length; i += CONCURRENCY) {
    await Promise.all(
      contexts.slice(i, i + CONCURRENCY).map((ctx) => ctx.cleanup()),
    );
  }
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
 * @param opts.authUserId    Better Auth user id; if absent a synthetic
 *                           one is seeded into `auth_user`.
 */
export async function seedOauthBearer(
  storage: Storage,
  scopes: string[],
  opts: {
    clientName?: string;
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
    await requireSqliteRun(storage)(
      "INSERT OR IGNORE INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      [
        authUserId,
        "Test User",
        `${authUserId}@test.local`,
        Math.floor(now.getTime() / 1000),
        Math.floor(now.getTime() / 1000),
      ],
    );
  }

  const schemaModule = await import("./storage/sqlite/schema.js");
  // `redirect_uris` is plain `text` holding a JSON-serialized array, the
  // shape the Better Auth adapter writes.
  const redirectUrisValue = JSON.stringify(["http://localhost:5173/callback"]);
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

  const grant = await storage.items.create({
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
  });

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
    scopes,
    accessTtlMs: 3600_000,
  });

  return { token: rawToken, grantId: grant.id, clientId };
}

/**
 * Put a password account behind the OAuth provider's sign-in page.
 *
 * Goes around `POST /owner`, through the seam the app exposes, so a test
 * can put any number of people behind the sign-in page without the one
 * owner the door allows.
 * The account arrives verified, so a test signs in through
 * `POST /auth/sign-in/email` (or the form at `POST /auth/sign-in`) right
 * away. A refusal throws rather than returning, because a fixture with no
 * user behind it fails somewhere far from here.
 */
export async function createTestAccount(
  ctx: { auth: MarfaAuth },
  email: string,
  password: string,
  name?: string,
): Promise<{ authUserId: string; email: string }> {
  const result = await ctx.auth.createEmailAccount({ email, password, name });
  if (!result.ok) {
    throw new Error(`createTestAccount(${email}) refused: ${result.reason}`);
  }
  return { authUserId: result.authUserId, email: result.email };
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
 * insert latency on a loaded machine, short enough that a real
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

/**
 * A working credential, shaped the way the operator's `POST /keys` shapes
 * one for a body that names no narrowing: everything unless the caller
 * narrows it, and never the operator tier.
 *
 * For a test that needs a second working credential beside the one
 * `createTestContext` provisions, or a narrower one. Minting through the
 * store rather than the route keeps a fixture out of the operator key's way,
 * and the shape is the route's — `test-context-credentials.test.ts` is what
 * holds the two together.
 */
export async function mintWorkingKey(
  ctx: Pick<TestContext, "storage">,
  options?: Partial<CreateKeyInput> & { rawKey?: string },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = options?.rawKey ?? `marfa_k1_test_working_${suffix}`;
  const input: Partial<CreateKeyInput> = { ...options };
  delete (input as { rawKey?: string }).rawKey;
  await ctx.storage.keys.create(
    {
      label: `test-working-key-${suffix}`,
      source: `test-working-key-${suffix}`,
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      profile_permissions: { "*": "write" },
      permissions: [...PERMISSIONS],
      default_tier: "library",
      ...input,
      is_operator: false,
    },
    hashApiKey(rawKey, SALT),
  );
  return rawKey;
}

export async function createTestContext(
  overrides?: Partial<AppConfig>,
): Promise<TestContext> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-test-"));
  try {
    return await buildTestContext(tmpDir, overrides);
  } catch (error) {
    // The only thing that removes this directory on the happy path is the
    // `cleanup` closure, and that closure does not exist until the build
    // returns one. A throw anywhere below therefore strands the directory
    // with nothing left holding a reference to it, so it is removed here
    // before the failure propagates.
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * An app and its storage with nothing seeded: no key and no
 * `bootstrapped` sentinel. The shape a brand-new installation starts from, so
 * a test can drive the product's own first-mint doors rather than describing
 * what they produce.
 */
export interface UnbootstrappedTestApp {
  app: TestApp;
  storage: Storage;
  blobs: BlobLayer;
  housekeeping: Housekeeping;
  config: AppConfig;
  tmpDir: string;
  cleanup: () => Promise<void>;
  auth: MarfaAuth;
}

async function buildUnbootstrappedApp(
  tmpDir: string,
  overrides?: Partial<AppConfig>,
): Promise<UnbootstrappedTestApp> {
  const blobPath = join(tmpDir, "blobs");

  const dbPath = join(tmpDir, "test.db");
  const storage = await createSqliteStorage(dbPath);

  const config: AppConfig = {
    port: 0,
    sqlitePath: "",
    blobPath,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: true,
    apiKeySalt: SALT,
    corsOrigins: [],
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
    trustedProxyCidrs: [],
    trustedProxyHeader: null,
    authBaseUrl: "http://localhost:0",
    authSecret: "test-auth-secret-change-in-production-not-required-here",
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    ...overrides,
  };
  const blobs = await createBlobLayer(storage, config);
  const housekeeping = new Housekeeping(storage.housekeeping, {
    pollIntervalMs: 1_000,
  });
  const app = createApp(
    storage,
    blobs,
    housekeeping,
    config,
    await ensureInstanceId(storage.settings),
  );
  if (!app.auth) {
    throw new Error("test-utils: createApp mounted no auth instance");
  }

  return {
    app,
    storage,
    blobs,
    housekeeping,
    config,
    tmpDir,
    auth: app.auth,
    cleanup: async () => {
      try {
        try {
          await storage.close();
        } catch {
          // Best-effort.
        }
      } finally {
        // In `finally` because a failed close must not strand the
        // directory: the database file inside it is unreachable either
        // way, and one leaked directory per context fills a disk.
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Build an app with nothing seeded, in its own temporary directory. The
 * caller owns `cleanup`.
 */
export async function createUnbootstrappedTestApp(
  overrides?: Partial<AppConfig>,
): Promise<UnbootstrappedTestApp> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-unbootstrapped-"));
  try {
    return await buildUnbootstrappedApp(tmpDir, overrides);
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

async function buildTestContext(
  tmpDir: string,
  overrides?: Partial<AppConfig>,
): Promise<TestContext> {
  const { app, storage, blobs, housekeeping, config, cleanup, auth } =
    await buildUnbootstrappedApp(tmpDir, overrides);

  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = `marfa_k1_test_operator_key_${suffix}`;
  const keyHash = hashApiKey(rawKey, SALT);
  await storage.keys.create(
    {
      label: "test-operator",
      source: `test-operator-${suffix}`,
      // **The shape bootstrap forces, stated in full.** The one
      // unauthenticated mint takes nothing on any axis — five empty maps and
      // an empty permission list — because running the instance sits outside
      // the permission model rather than being a large set inside it.
      //
      // Named rather than left to the store's defaults so the fixture says
      // what it is, and so a default that drifted would show up here.
      // `test-context-credentials.test.ts` compares this row against one
      // driven out of the real door.
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      permissions: [],
      default_tier: "library",
      is_operator: true,
    },
    keyHash,
  );
  await storage.settings.set("bootstrapped", "true");

  // **The working key, minted here because the operator mints it there.**
  // This fixture stamps the sentinel directly rather than driving the
  // unauthenticated mint, so nothing else would create it.
  //
  // The wildcard maps and the whole permission list are what the operator's
  // `POST /keys` hands back for a body that names no narrowing: a seed with
  // no creator above it takes everything.
  const workingRawKey = `marfa_k1_test_working_key_${suffix}`;
  await storage.keys.create(
    {
      label: "test-working-key",
      source: `test-working-${suffix}`,
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      profile_permissions: { "*": "write" },
      permissions: [...PERMISSIONS],
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(workingRawKey, SALT),
  );

  return {
    app,
    storage,
    blobs,
    housekeeping,
    config,
    operatorKey: rawKey,
    workingKey: workingRawKey,
    tmpDir,
    cleanup,
    auth,
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
     * — `/auth/oauth2/token`, `/auth/authorize` POST, `/auth/device/consent`.
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
 *     when the job ended in `canceled` / `failed`.
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

// ---------------------------------------------------------------------------
// Reading a server-sent-events stream in a test
// ---------------------------------------------------------------------------

/**
 * Ceiling for a read that waits on a condition.
 *
 * Deliberately below the server package's `testTimeout` of 60s: were the
 * two equal, vitest's timer would win the race and the diagnostic below
 * could never print, every failure surfacing as a bare `Test timed out in
 * 60000ms` naming neither the condition nor what had been read. A ceiling is
 * only useful if it is reached first.
 *
 * With `until` this is a ceiling rather than a cost. The read returns the
 * moment its condition holds, so a healthy run never spends it, and reaching
 * it means either a real defect or a machine too loaded to schedule the
 * stream. Neither is a reason to make the budget the assertion.
 */
export const SSE_READ_CEILING_MS = 20_000;

/** Window for a read that is proving something did NOT arrive. */
const SSE_ABSENCE_WINDOW_MS = 500;

const DEADLINE = Symbol("sse-read-deadline");

/** What `ReadableStreamDefaultReader.read()` resolves to. Named locally
 *  because the DOM lib that declares it is not in this package's tsconfig. */
interface StreamChunk {
  done: boolean;
  value?: Uint8Array;
}

export interface SseReadOptions {
  /**
   * Stop as soon as this holds. An unmet condition throws rather than
   * returning partial text, because the caller's next assertion is usually
   * that something is absent, and absence is trivially true of a stream that
   * delivered nothing.
   */
  until?: (text: string) => boolean;
  /**
   * Wait for the server to close the stream, and throw if it does not.
   * Supersedes `until`, which stops at a frame — and a terminal frame is
   * only terminal if the close actually follows it, which a read that stops
   * at the frame never observes.
   */
  untilClosed?: boolean;
  /**
   * Called with everything read so far after each chunk, whatever stops
   * the read. For a test that writes once it has seen a frame: the write
   * is then placed by an observation of the stream rather than by a
   * pause, which is what makes "sent live" a fact rather than a likely
   * outcome.
   */
  onChunk?: (text: string) => void;
  /**
   * Read the whole window, then require this of what arrived. Absence
   * assertions use it to prove they were reading a live stream: "no
   * `catchup_too_old` arrived" says nothing if nothing arrived at all.
   */
  requireSeen?: (text: string) => boolean;
  /** Override the budget. Defaults to the ceiling with `until`, and to the
   *  short absence window without it. */
  timeoutMs?: number;
}

/**
 * Read an SSE response body until a condition holds or the budget runs out.
 *
 * Shared rather than per-suite, so no two copies drift into different
 * signatures, return shapes and failure semantics.
 */
export async function readSse(
  res: Response,
  opts: SseReadOptions = {},
): Promise<{ text: string; closed: boolean }> {
  const { until, requireSeen, onChunk } = opts;
  const untilClosed = opts.untilClosed === true;
  const timeoutMs =
    opts.timeoutMs ??
    ((until ?? untilClosed) ? SSE_READ_CEILING_MS : SSE_ABSENCE_WINDOW_MS);
  if (res.body === null) throw new Error("SSE response carried no body");

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let closed = false;
  let satisfied = false;
  const deadline = Date.now() + timeoutMs;

  // One read outstanding at a time, and the same promise is awaited again
  // rather than replaced. A second `read()` issued while the first is still
  // pending loses chunks: a reader fulfills queued reads in arrival order,
  // so the next chunk goes to the abandoned read, whose resolve lands on a
  // promise the loop has already settled and walked away from. On an idle
  // machine the first read wins every race, so the loss shows only under
  // load.
  let pending: Promise<StreamChunk> | undefined;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    pending ??= reader
      .read()
      .catch((): StreamChunk => ({ done: true, value: undefined }));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => {
          resolve(DEADLINE);
        }, remaining);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === DEADLINE) break;

    pending = undefined;
    if (result.done) {
      closed = true;
      break;
    }
    if (result.value) {
      text += decoder.decode(result.value, { stream: true });
      onChunk?.(text);
      if (!untilClosed && until?.(text) === true) {
        satisfied = true;
        break;
      }
    }
  }

  try {
    await reader.cancel();
  } catch {
    // Already closed; nothing to release.
  }

  if (untilClosed && !closed) {
    throw new Error(
      `SSE stream stayed open for ${String(timeoutMs)}ms; read so far: ${JSON.stringify(text)}`,
    );
  }
  if (!untilClosed && until !== undefined && !satisfied) {
    throw new Error(
      `SSE read did not reach its condition within ${String(timeoutMs)}ms; read so far: ${JSON.stringify(text)}`,
    );
  }
  if (requireSeen !== undefined && !requireSeen(text)) {
    throw new Error(
      `SSE read cannot prove it was reading a live stream within ${String(timeoutMs)}ms; read: ${JSON.stringify(text)}`,
    );
  }
  return { text, closed };
}

// ---------------------------------------------------------------------------
// Edge-event subscription helpers
// ---------------------------------------------------------------------------

/**
 * Wait for the first edge event matching `predicate`.
 *
 * **Call this before the write, and await it after.** The listener has to
 * be attached before the publish or it hears nothing, and a test built the
 * other way round passes or fails on scheduling rather than on behavior.
 * Attachment happens synchronously inside this call — the generator body
 * runs as far as its `on()` registration on the first `next()`, and that
 * `next()` is issued here — so by the time this returns its promise the
 * subscription is live.
 *
 * **No deadline of its own, deliberately.** A hand-rolled budget in a test
 * body re-emits a timeout as a logic failure, which reads like an
 * assertion about the code and is really a statement about how loaded the
 * machine was. An event that never arrives starves rather than being
 * merely delayed, so vitest's own per-test budget is the right owner and
 * the failure then names itself as a timeout.
 */
export function nextEdgeEvent(
  predicate: (event: EdgeEventWithId) => boolean,
): Promise<EdgeEventWithId> {
  const iter = subscribeEdges()[Symbol.asyncIterator]();
  return (async () => {
    for (;;) {
      const result = await iter.next();
      if (result.done) {
        throw new Error("edge pubsub stream closed before the event arrived");
      }
      if (predicate(result.value)) return result.value;
    }
  })();
}

/**
 * Collect every edge event until `signal` aborts.
 *
 * For the negative assertion — proving nothing was published — where
 * there is no event to await and the only honest measure is to listen for
 * a bounded moment and find the collection empty. Prefer `nextEdgeEvent`
 * whenever something is expected to arrive.
 */
export function collectEdgeEvents(signal: AbortSignal): {
  events: EdgeEventWithId[];
  done: Promise<void>;
} {
  const events: EdgeEventWithId[] = [];
  const done = (async () => {
    try {
      for await (const event of subscribeEdges({ signal })) {
        events.push(event);
      }
    } catch {
      // The abort ends the generator; nothing to report.
    }
  })();
  return { events, done };
}

/**
 * A storage whose first replay read blocks until the returned `open` is
 * called, so the stream's prologue is held by the test rather than by a
 * clock: everything published while it is held goes into the hold and is
 * released, in order, when the test lets go. `reached` settles when the
 * prologue asks for that read, which is the observation that the
 * subscription is attached and a write made now will be held rather than
 * missed; the read answers no rows, so nothing is replayed.
 */
export function gatedEventLog(base: Storage): {
  storage: Storage;
  open: () => void;
  reached: Promise<void>;
} {
  let open = (): void => undefined;
  const gate = new Promise<PersistedEvent[]>((resolve) => {
    open = () => {
      resolve([]);
    };
  });
  let arrive = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let firstRead = true;
  const storage: Storage = {
    ...base,
    eventLog: {
      ...base.eventLog,
      append: (entry) => base.eventLog.append(entry),
      getMinRetainedId: () => base.eventLog.getMinRetainedId(),
      getMaxId: () => base.eventLog.getMaxId(),
      cleanup: (hours) => base.eventLog.cleanup(hours),
      getAfter: (afterId, limit) => {
        if (firstRead) {
          firstRead = false;
          arrive();
          return gate;
        }
        return base.eventLog.getAfter(afterId, limit);
      },
    },
  };
  return { storage, open, reached };
}

/**
 * A middleware presenting a key the store holds, minted on the first
 * request: the event stream reads its credential again as it delivers, so
 * a principal the store does not hold would end every stream at once.
 * Reads every type and no edge type unless `maps` says otherwise.
 */
export function storedViewerKey(
  storage: Storage,
  maps: Partial<CreateKeyInput> = {},
): MiddlewareHandler<AppEnv> {
  let minted: Promise<ApiKey> | undefined;
  return async (c, next) => {
    minted ??= (async () => {
      const suffix = Math.random().toString(36).slice(2, 14);
      return storage.keys.create(
        {
          label: `events-viewer-${suffix}`,
          source: `events-viewer-${suffix}`,
          type_permissions: { "*": "read" },
          extension_permissions: {},
          edge_permissions: {},
          metadata_permissions: {},
          permissions: [],
          ...maps,
          is_operator: false,
        },
        hashApiKey(`marfa_k1_events_viewer_${suffix}`, SALT),
      );
    })();
    c.set("apiKey", await minted);
    await next();
  };
}

/**
 * The events route alone, on the given storage, answering to a stored
 * credential the test shapes (`storedViewerKey`), so nothing is filtered
 * on the item side and edge frames reach a stream only when the test
 * grants them.
 */
export function eventsAppWithKey(
  storage: Storage,
  maps: Partial<CreateKeyInput> = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", storedViewerKey(storage, maps));
  app.route("/events", eventRoutes(storage));
  return app;
}

/**
 * A read whose writes are placed on an observed frame: once `probe`'s
 * frame has arrived, `write` runs, and the read goes on until `until`
 * holds, or until the server closes the stream when `untilClosed` is set.
 * A failure inside `write` ends the read with its own message rather than
 * as a read that timed out waiting for what was never sent.
 */
export async function readSseWriting(
  res: Response,
  probe: string,
  write: () => Promise<void>,
  until: SseReadOptions["until"] | { untilClosed: true },
): Promise<{ text: string; closed: boolean }> {
  let failed: (err: unknown) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    failed = reject;
  });
  let writes: Promise<void> | undefined;
  const read = readSse(res, {
    onChunk: (seen) => {
      if (writes === undefined && seen.includes(probe)) {
        writes = write();
        // Handled here so a failure while the read is still going ends
        // the race, and the promise itself is awaited below so one that
        // lands after the read has finished is not lost.
        writes.catch(failed);
      }
    },
    ...(typeof until === "function" ? { until } : until),
  });
  const result = await Promise.race([read, failure]);
  await writes;
  return result;
}

/**
 * A short bounded pause, for negative assertions only.
 *
 * Paired with `collectEdgeEvents`: "nothing was published" cannot be
 * awaited, so it is measured by listening briefly and finding nothing.
 * Never use it to wait for something that is expected — that is what
 * `nextEdgeEvent` is for.
 */
export async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect every item event until `signal` aborts.
 *
 * The item-event twin of `collectEdgeEvents`, and here for the same
 * reason: the negative assertion — proving nothing was published — has no
 * event to await, so it listens for a bounded moment and finds the
 * collection empty.
 */
export function collectItemEvents(signal: AbortSignal): {
  events: ItemEventWithId[];
  done: Promise<void>;
} {
  const events: ItemEventWithId[] = [];
  const done = (async () => {
    try {
      for await (const event of subscribe({ signal })) {
        events.push(event);
      }
    } catch {
      // The abort ends the generator; nothing to report.
    }
  })();
  return { events, done };
}

/**
 * A second disk store beside the context's, standing in for the bucket:
 * the copy rules do not care which kind holds a copy, and a second folder
 * is a second store to the log. Attached the way the layer attaches one,
 * so it has an id and a row, and added to the context's layer so the doors
 * and the housekeeping see it too.
 */
export async function withSecondStore(
  ctx: TestContext,
): Promise<{ stores: Stores; second: DiskBlobStore }> {
  const second = new DiskBlobStore(
    mkdtempSync(join(ctx.tmpDir, "second-store-")),
  );
  await second.attach();
  await ctx.storage.blobs.attachStore({
    id: second.id,
    kind: second.kind,
    locator: second.locator,
  });
  const all = ctx.blobs.stores as BlobStore[];
  all.push(second);
  ctx.blobs.byId = (id) => all.find((store) => store.id === id);
  return { second, stores: ctx.blobs };
}
