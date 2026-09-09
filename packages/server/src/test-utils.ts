import { SPACE_PERMISSIONS } from "@withmarfa/shared";
import type { CreateKeyInput } from "@withmarfa/shared";
import { createApp } from "./app.js";
import { consentLockDepth } from "./auth/consent-lock.js";
import { OidcSigner } from "./auth/oidc-signing.js";
import type { AppConfig } from "./config.js";
import type { EmailTransport } from "./email/transport.js";
import type { DeadLetterOps } from "./integrations/local-runtime/dead-letters.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createPgStorage } from "./storage/pg/index.js";
import { pgApplicationName } from "./storage/pg/connection.js";
import { cloneTemplate } from "./storage/pg/test-template.js";
import { FilesystemBlobBackend } from "./storage/blob-backend.js";
import type { BlobBackend } from "./storage/blob-backend.js";
import { hashApiKey } from "./middleware/auth.js";
import type { Storage } from "./storage/interface.js";
import type { Hono } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subscribe, subscribeEdges } from "./pubsub.js";
import type { EdgeEventWithId, ItemEventWithId } from "./pubsub.js";
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
  /**
   * The instance tier, and nothing else: no space, no permissions, exactly
   * what the one unauthenticated mint hands back. It opens the instance
   * routes and reaches no content at all, so a test about anything inside a
   * space wants `spaceKey`.
   */
  operatorKey: string;
  /**
   * The instance's one space. Keys mode provisions one at bootstrap, so a
   * fixture that stamps the sentinel instead has to provision it here or it
   * tests a shape the product stopped producing.
   */
  spaceId: string;
  /**
   * A credential bound to `spaceId`, holding every space permission and
   * writing every content family — an ordinary working key, and what a
   * self-hoster is handed alongside the operator key. This is the suite's
   * working credential: content, the space permissions, everything but the
   * instance routes.
   */
  spaceKey: string;
  /** The per-context temporary directory holding the sqlite database and
   *  the blob root. Exposed so a test can assert on its lifetime; removed
   *  by `cleanup`. */
  tmpDir: string;
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
/**
 * Connections a test file's pool may open. Named because the config a test
 * app is built with has to state the same number: `/health` reports the pool
 * against `dbPoolSize`, so a config that omits it describes a pool ten wide
 * that is actually three, and the figure reads as permanently roomy.
 */
export const TEST_POOL_SIZE = 3;

export async function createPgTestStorage(options?: {
  authMode?: "hosted" | "keys";
  /** Override the default pool-size cap. Default is `TEST_POOL_SIZE` — see
   *  the comment inside this function for the rationale. */
  maxPoolSize?: number;
}): Promise<{ storage: Storage; cleanup: () => Promise<void> }> {
  const clone = await cloneTemplate();
  // Cap at 3 connections per test file. With ~CPU-count parallel workers,
  // the default max=10 quickly exhausts Postgres's default max_connections=100.
  // Skip bootstrap — the cloned DB already has the schema baked in from the
  // template, saving hundreds of ms per storage creation under parallel load.
  const storage = await createPgStorage(clone.url, {
    ...options,
    maxPoolSize: options?.maxPoolSize ?? TEST_POOL_SIZE,
    // Named rather than left to default, because this pool stands in for a
    // server's own and `/health` finds that pool by its label. Unnamed it
    // would carry `PG_UNNAMED_APPLICATION_NAME`, which is deliberately not a
    // label any role produces, and the endpoint would report a pool it never
    // found as an idle one. `buildTestContext` builds its `AppConfig` with no
    // `processRole`, so this is the same expression the endpoint evaluates.
    applicationName: pgApplicationName(undefined),
    skipBootstrap: true,
  });
  return {
    storage,
    cleanup: async () => {
      // Close first, bounded — then drop. These used to run in parallel,
      // which raced the DROP's `WITH (FORCE)` against the drain inside
      // `storage.close()`: FORCE terminates backends server-side, so a
      // tracked fire-and-forget write (audit row, oauth last-used stamp)
      // still on the wire died mid-socket-write. The tracker catches the
      // write's own rejection, but postgres-js leaks a second, unowned
      // rejection when a socket is killed mid-write, and that one fails
      // whichever test is running as an unhandled rejection — rarely on a
      // quiet machine, reliably under load. Sequencing lets the drain
      // finish before anything is terminated. The bound stays because
      // pool-close can hang on in-flight SSE / export streams; a close
      // that overruns it is then cleaned up by the FORCE drop, accepting
      // the rare leaked rejection in exchange for never wedging afterAll.
      await Promise.race([
        storage.close().catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve();
          }, 5_000);
        }),
      ]);
      await clone.drop().catch(() => undefined);
    },
  };
}

/**
 * Close a file's accumulated test contexts without the teardown cost growing
 * linearly with the number of tests.
 *
 * **Why this exists rather than a `for` loop.** Each `cleanup()` races
 * `storage.close()` against a five-second bound before dropping the clone, and
 * that bound is reached whenever the machine is busy — a pool close waits on
 * in-flight work. Closed serially, a file holding N contexts therefore spends
 * up to `N * 5s` in its `afterAll`, against Vitest's 120-second default. At 38
 * contexts that is 190 seconds of budget for a hook allowed 120, and the file
 * failed twice in one evening on a loaded machine while every assertion in the
 * run passed.
 *
 * **Bounded rather than unbounded, and the bound is not arbitrary.** Closing
 * all of them at once would put N pool closes and N `DROP DATABASE ... WITH
 * (FORCE)` statements against one Postgres simultaneously, which trades a slow
 * teardown for a contended one. Eight at a time is what `conformance`'s own
 * cleanup settled on for the same question.
 *
 * **Concurrency is across contexts, never inside one.** `cleanup()` sequences
 * its own close before its own drop deliberately: running those two in
 * parallel raced the FORCE against the drain and killed a tracked write
 * mid-socket, which surfaces as an unhandled rejection in whichever test is
 * running. That ordering is untouched here — each context still closes then
 * drops, and only different contexts overlap.
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
 * @param opts.spaceId      space for the system.connection item
 *                           (defaults to undefined — keys-mode self-host)
 * @param opts.authUserId    Better Auth user id; if absent a synthetic
 *                           one is seeded into `auth_user`.
 * @param opts.seedUserRow   Seed a `users` row bound to the `auth_user`, so
 *                           the bearer middleware can resolve the caller's
 *                           space. It used to be `userRole` and to take one
 *                           of three role strings, none of which was ever
 *                           stored — a user row carries no role and nothing
 *                           projects one. Hosted-mode storage only.
 */
export async function seedOauthBearer(
  storage: Storage,
  scopes: string[],
  opts: {
    clientName?: string;
    spaceId?: string;
    authUserId?: string;
    seedUserRow?: boolean;
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

  if (opts.seedUserRow) {
    if (!storage.users) {
      throw new Error(
        "seedOauthBearer({ seedUserRow }) requires hosted-mode storage with a UserStore",
      );
    }
    if (!opts.spaceId) {
      throw new Error(
        "seedOauthBearer({ seedUserRow }) requires opts.spaceId (users.space_id is FK-bound)",
      );
    }
    await storage.users.create({
      provider: "test",
      provider_id: authUserId,
      space_id: opts.spaceId,
      auth_user_id: authUserId,
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
 * True when an `auth_user` row exists for `email`.
 *
 * Every account-creating path converges on the one `databaseHooks`
 * entry that also provisions a space, so the absence of an `auth_user`
 * is what proves nothing was provisioned. Asserting on spaces alone
 * would still pass if an account were created without one.
 *
 * Reads every email and compares in JS rather than parameterizing:
 * `__sqliteAll` takes no parameters, and a test database holds a
 * handful of rows.
 */
export async function authUserExists(
  storage: Storage,
  email: string,
): Promise<boolean> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  const lower = email.toLowerCase();
  const query = `SELECT email FROM auth_user`;
  if (dialect === "pg") {
    const rows = (await requirePgClient(storage)(query)) as {
      email: string;
    }[];
    return rows.some((r) => r.email.toLowerCase() === lower);
  }
  const sqlite = storage as unknown as {
    __sqliteAll?: (q: string) => Promise<unknown[]>;
  };
  if (!sqlite.__sqliteAll) return false;
  const rows = (await sqlite.__sqliteAll(query)) as { email: string }[];
  return rows.some((r) => r.email.toLowerCase() === lower);
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

/**
 * A working credential bound to `spaceId`, shaped the way
 * `POST /admin/spaces/{id}/keys` shapes one: everything in that space unless
 * the caller narrows it, and never the operator tier.
 *
 * For a test that needs a second space beside the one `createTestContext`
 * provisions, or a narrower credential in that space. Minting through the
 * store rather than the route keeps a fixture out of the operator key's way,
 * and the shape is the route's — `test-context-credentials.test.ts` is what
 * holds the two together.
 */
export async function mintSpaceKey(
  ctx: Pick<TestContext, "storage">,
  spaceId: string,
  options?: Partial<CreateKeyInput> & { rawKey?: string },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = options?.rawKey ?? `marfa_k1_test_space_${suffix}`;
  const input: Partial<CreateKeyInput> = { ...options };
  delete (input as { rawKey?: string }).rawKey;
  await ctx.storage.keys.create(
    {
      label: `test-space-key-${suffix}`,
      source: `test-space-key-${suffix}`,
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      profile_permissions: { "*": "write" },
      space_permissions: [...SPACE_PERMISSIONS],
      default_tier: "library",
      ...input,
      is_operator: false,
    },
    hashApiKey(rawKey, SALT),
    spaceId,
  );
  return rawKey;
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
  /**
   * Optional dead-letter ops for the admin runtime-jobs routes. Wired
   * into `createApp` as the 7th arg. Left undefined, the routes answer
   * 503 `local_runtime_not_available`, matching a deployment without
   * the local substrate.
   */
  deadLetterOps?: DeadLetterOps,
): Promise<TestContext> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-test-"));
  try {
    return await buildTestContext(
      tmpDir,
      overrides,
      emailTransport,
      deadLetterOps,
    );
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
 * An app and its storage with nothing seeded: no key, no space, and no
 * `bootstrapped` sentinel. The shape a brand-new installation starts from, so
 * a test can drive the product's own first-mint doors rather than describing
 * what they produce.
 */
export interface UnbootstrappedTestApp {
  app: Hono<AppEnv>;
  storage: Storage;
  blobBackend: BlobBackend;
  config: AppConfig;
  tmpDir: string;
  cleanup: () => Promise<void>;
}

async function buildUnbootstrappedApp(
  tmpDir: string,
  overrides?: Partial<AppConfig>,
  emailTransport?: EmailTransport,
  deadLetterOps?: DeadLetterOps,
): Promise<UnbootstrappedTestApp> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  const blobPath = join(tmpDir, "blobs");

  const storageAuthMode: "keys" | "hosted" = overrides?.authMode ?? "keys";
  let storage: Storage;
  let pgCleanup: (() => Promise<void>) | undefined;
  if (dialect === "pg") {
    // `dbPoolSize` is a real config field, so a test that sets it means
    // it: a suite about what a request does to the pool needs the pool it
    // asked for, and the default of three hides an exhaustion the code
    // would reach at one. Absent, the default stands.
    const clone = await createPgTestStorage({
      authMode: storageAuthMode,
      ...(overrides?.dbPoolSize !== undefined && {
        maxPoolSize: overrides.dbPoolSize,
      }),
    });
    storage = clone.storage;
    pgCleanup = clone.cleanup;
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = await createSqliteStorage(dbPath, { authMode: storageAuthMode });
  }

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const config: AppConfig = {
    port: 0,
    // What `createPgTestStorage` actually builds. Unset, `/health` would
    // report this pool against the production default instead.
    dbPoolSize: TEST_POOL_SIZE,
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
    undefined,
    deadLetterOps,
  );

  return {
    app,
    storage,
    blobBackend,
    config,
    tmpDir,
    cleanup: async () => {
      try {
        if (pgCleanup) {
          await pgCleanup();
        } else {
          try {
            await storage.close();
          } catch {
            // Best-effort.
          }
        }
      } finally {
        // In `finally` because a failed close must not strand the
        // directory: the database file inside it is unreachable either
        // way, and one leaked directory per context is what filled a
        // disk with six hundred thousand of them.
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
  emailTransport?: EmailTransport,
  deadLetterOps?: DeadLetterOps,
): Promise<UnbootstrappedTestApp> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-unbootstrapped-"));
  try {
    return await buildUnbootstrappedApp(
      tmpDir,
      overrides,
      emailTransport,
      deadLetterOps,
    );
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

async function buildTestContext(
  tmpDir: string,
  overrides?: Partial<AppConfig>,
  emailTransport?: EmailTransport,
  deadLetterOps?: DeadLetterOps,
): Promise<TestContext> {
  const { app, storage, blobBackend, cleanup } = await buildUnbootstrappedApp(
    tmpDir,
    overrides,
    emailTransport,
    deadLetterOps,
  );

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
      // the permission model rather than being a large set inside it. A
      // space-less row also has no space predicate applied to it, so reach
      // here would be reach over every space at once.
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
      space_permissions: [],
      default_tier: "library",
      is_operator: true,
    },
    keyHash,
  );
  await storage.settings.set("bootstrapped", "true");

  // **The instance's one space and the key that works in it, provisioned here
  // because bootstrap provisions them there.** This fixture stamps the
  // sentinel directly rather than driving the unauthenticated mint, so nothing
  // else would create either — and a keys-mode instance with no space is a
  // shape the product no longer produces. Everything a real caller owns lives
  // in the space: connections above all, because a connection with no space
  // cannot mint a runtime credential now that a space-less credential is the
  // operator key and nothing else.
  //
  // The wildcard maps and the whole permission list are what
  // `POST /admin/spaces/{id}/keys` hands back for a body that names no
  // narrowing, and what a keys-mode bootstrap provisions: a seed with no
  // creator above it takes everything in its space.
  const space = await storage.spaces?.create("test-space");
  const spaceRawKey = `marfa_k1_test_space_key_${suffix}`;
  if (space) {
    await storage.keys.create(
      {
        label: "test-space-key",
        source: `test-space-${suffix}`,
        type_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        metadata_permissions: { "*": "write" },
        profile_permissions: { "*": "write" },
        space_permissions: [...SPACE_PERMISSIONS],
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(spaceRawKey, SALT),
      space.id,
    );
  }

  return {
    app,
    storage,
    blobBackend,
    operatorKey: rawKey,
    spaceId: space?.id ?? "",
    spaceKey: spaceRawKey,
    tmpDir,
    cleanup,
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

// ---------------------------------------------------------------------------
// Reading a server-sent-events stream in a test
// ---------------------------------------------------------------------------

/**
 * Ceiling for a read that waits on a condition.
 *
 * Deliberately below the server package's `testTimeout` of 60s. The two used
 * to be equal, so vitest's timer always won the race and the diagnostic below
 * could never print: every failure surfaced as a bare `Test timed out in
 * 60000ms`, naming neither the condition nor what had been read. A ceiling is
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
 * Shared rather than per-suite because the two hand-rolled copies this
 * replaces had drifted into different signatures, different return shapes and
 * different failure semantics, and both carried the same defect.
 */
export async function readSse(
  res: Response,
  opts: SseReadOptions = {},
): Promise<{ text: string; closed: boolean }> {
  const { until, requireSeen } = opts;
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
  // rather than replaced. Issuing a second `read()` while the first is still
  // pending is what used to lose chunks: a reader fulfils queued reads in
  // arrival order, so the next chunk went to the abandoned read, whose
  // resolve landed on a promise the loop had already settled and walked away
  // from. On an idle machine the first read wins every race and nothing is
  // ever abandoned, which is why this only ever failed under CI load.
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
 * other way round passes or fails on scheduling rather than on behaviour.
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
export function collectItemEvents(
  signal: AbortSignal,
  /** The same fence `GET /events` applies for a scoped viewer, so a frame
   *  published without a space — or with the wrong one — is invisible here
   *  too. Omit it to watch everything, which is what a platform key sees. */
  spaceId?: string,
): {
  events: ItemEventWithId[];
  done: Promise<void>;
} {
  const events: ItemEventWithId[] = [];
  const done = (async () => {
    try {
      for await (const event of subscribe({ signal, spaceId })) {
        events.push(event);
      }
    } catch {
      // The abort ends the generator; nothing to report.
    }
  })();
  return { events, done };
}
