import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import {
  createApp,
  createSqliteStorage,
  FilesystemBlobBackend,
  type AppConfig,
  type Storage,
} from "@withmarfa/server";
import { MarfaClient } from "./client.js";

/** Mirrors the server-side `hashApiKey` (middleware/auth.ts). Inlined
 *  to avoid pulling a private server module into the SDK package. The
 *  impl is a one-liner; if the server's hash ever changes, this drifts
 *  loudly — the bearer fails to resolve at auth-middleware time. */
function hashKey(raw: string, salt: string): string {
  return createHmac("sha256", salt).update(raw).digest("hex");
}

const TEST_API_KEY_SALT = "test-salt";

/**
 * Shared test fixtures for the SDK package.
 *
 * Two flavours:
 *
 * - `createKeysModeFixture()` — the simple bring-up. Bootstraps a
 *   platform-admin API key over `POST /keys` and returns a client
 *   pointed at it. Use for any SDK surface that doesn't depend on
 *   `auth_user` resolution. Mirrors the inline pattern in
 *   `client.test.ts`.
 *
 * - `createHostedModeFixture()` — the hosted-mode bring-up. Boots the
 *   server in `authMode: 'hosted'`, runs a sign-up through the wrapped
 *   form endpoint (which provisions the `tenants` + `users` bridge
 *   atomically), flips `auth_user.email_verified = TRUE` directly so
 *   sign-in is unblocked, then mints a `tenant_admin` API key bound to
 *   the new user's tenant. The returned client uses that key as bearer;
 *   the account-lifecycle routes resolve the bridge and recover the
 *   `auth_user.id` for `requestDelete` / `confirmDelete` / `cancel`.
 *
 * The two fixtures share a `baseConfig` so they don't drift on
 * non-auth knobs (rate limit, blob backend, etc.).
 */

interface AppRequest {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}

function createTestFetch(app: AppRequest): typeof globalThis.fetch {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(urlStr);
    return app.request(url.pathname + url.search, init);
  };
}

function baseConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    port: 0,
    storageDialect: "sqlite",
    sqlitePath: "",
    databaseUrl: "",
    blobPath: "",
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: TEST_API_KEY_SALT,
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
    authAllowSignup: false,
    authSecret: "test-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    oauthRedirectAllowlist: [],
    ...overrides,
  };
}

export interface KeysModeFixture {
  /** SDK client wired to call the in-process server via the bootstrap admin key. */
  client: MarfaClient;
  /** The bootstrap admin key (`marfa_k1_*`). Use to mint additional keys
   *  in tests that need them. */
  adminKey: string;
  /** The custom `fetch` the SDK is wired through. Pass into a second
   *  `MarfaClient` if a test needs another bearer against the same
   *  in-process app. */
  fetch: typeof globalThis.fetch;
  /** Underlying storage handle — surfaced for tests that need to seed
   *  rows directly (e.g. quota overrides). */
  storage: Storage;
  /** Tear down the storage handle. Call from `afterAll` / `afterEach`. */
  cleanup: () => void;
}

export async function createKeysModeFixture(
  configOverrides?: Partial<AppConfig>,
): Promise<KeysModeFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-sdk-keys-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"));
  const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
  const app = createApp(
    storage,
    blobBackend,
    baseConfig({ authMode: "keys", ...configOverrides }),
  );
  const fetch = createTestFetch(app);

  const bootstrapRes = await fetch("http://localhost/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "test-admin",
      source: "sdk-test-admin",
      default_tier: "feed",
    }),
  });
  const { key } = (await bootstrapRes.json()) as { key: string };

  const client = new MarfaClient({
    url: "http://localhost",
    apiKey: key,
    fetch,
  });

  return {
    client,
    adminKey: key,
    fetch,
    storage,
    cleanup: () => {
      void storage.close();
    },
  };
}

export interface HostedModeFixture extends Omit<KeysModeFixture, "adminKey"> {
  /** Email of the signed-up + email-verified user. */
  email: string;
  /** `auth_user.id` for the signed-up user — the `authUserId` the
   *  account-lifecycle routes resolve from the bearer's tenant binding. */
  authUserId: string;
  /** `users.tenant_id` for the bridged Marfa profile. The bearer key is
   *  scoped to this tenant. */
  tenantId: string;
  /** A `tenant_admin` API key bound to `tenantId` — the SDK client
   *  uses this as bearer. Use to mint additional clients in tests
   *  that need to compare auth surfaces. */
  bearerKey: string;
}

/**
 * Boot the server in hosted mode, sign up a fresh user, mint a
 * tenant-scoped `tenant_admin` bearer that resolves to
 * `auth_user.id` via the `users` bridge.
 *
 * Sign-up uses the wrapped `POST /auth/sign-up` form endpoint (not
 * better-auth's bare `/auth/sign-up/email`) — that's the path that
 * atomically provisions `tenants` + `users` rows. Email verification
 * is then short-circuited by direct UPDATE on `auth_user`, mirroring
 * the server-side `markEmailVerified` test helper.
 *
 * Each call mints a unique email + handle so tests can run in parallel
 * against the same in-memory server (none do today, but the harness is
 * safe by construction).
 */
export async function createHostedModeFixture(
  configOverrides?: Partial<AppConfig>,
): Promise<HostedModeFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-sdk-hosted-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"), {
    authMode: "hosted",
  });
  const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
  const app = createApp(
    storage,
    blobBackend,
    baseConfig({
      authMode: "hosted",
      authAllowSignup: true,
      ...configOverrides,
    }),
  );
  const fetch = createTestFetch(app);
  const ORIGIN = "http://localhost:0";

  const suffix = Math.random().toString(36).slice(2, 12);
  const email = `sdk-hosted-${suffix}@test.invalid`;
  const handle = `sdk${suffix}`;
  const password = "correct horse battery staple";

  const signUpForm = new URLSearchParams({
    email,
    name: handle,
    username: handle,
    password,
    password_confirm: password,
    return_to: "/",
  });
  const signUpRes = await app.request("/auth/sign-up", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: signUpForm.toString(),
  });
  if (signUpRes.status >= 400) {
    throw new Error(
      `hosted-mode fixture sign-up failed (${String(signUpRes.status)}): ${await signUpRes.text()}`,
    );
  }

  // Short-circuit email verification — sign-in isn't needed for the bearer path.
  const sqlite = storage as unknown as {
    __sqliteAll: (query: string) => Promise<unknown[]>;
    __sqliteRun: (
      query: string,
      params: unknown[],
    ) => Promise<{ changes: number }>;
  };
  await sqlite.__sqliteRun(
    `UPDATE auth_user SET email_verified = 1 WHERE LOWER(email) = ?`,
    [email.toLowerCase()],
  );

  // __sqliteAll doesn't accept bind params, so interpolate.
  // Safe here: `email` is the locally-minted suffix-only string above.
  const lowered = email.toLowerCase().replace(/'/g, "''");
  const authUserRows = (await sqlite.__sqliteAll(
    `SELECT id FROM auth_user WHERE LOWER(email) = '${lowered}'`,
  )) as { id: string }[];
  const authUserId = authUserRows[0]?.id;
  if (!authUserId) {
    throw new Error(
      `hosted-mode fixture: auth_user row missing for ${email} after sign-up`,
    );
  }
  if (!storage.users) {
    throw new Error(
      "hosted-mode fixture: storage.users is undefined; authMode wiring is broken",
    );
  }
  const user = await storage.users.getByAuthUserId(authUserId);
  if (!user) {
    throw new Error(
      `hosted-mode fixture: users bridge missing for auth_user ${authUserId}`,
    );
  }
  const tenantId = user.tenant_id;

  const rawKey = `marfa_k1_sdk_hosted_${suffix}`;
  await storage.keys.create(
    {
      label: `sdk-hosted-${suffix}`,
      source: `sdk-hosted-${suffix}`,
      role: "tenant_admin",
      type_permissions: { "*": "write" },
      default_tier: "library",
      is_platform: false,
    },
    hashKey(rawKey, TEST_API_KEY_SALT),
    tenantId,
  );

  const client = new MarfaClient({
    url: "http://localhost",
    apiKey: rawKey,
    fetch,
  });

  return {
    client,
    fetch,
    storage,
    email,
    authUserId,
    tenantId,
    bearerKey: rawKey,
    cleanup: () => {
      void storage.close();
    },
  };
}

/**
 * Read the most recent `account-delete:` or `account-cancel:`
 * verification token directly from the storage layer. Mirrors the
 * server-side `readLatestVerification` helper used in
 * `auth-account.test.ts`. Used by SDK round-trip tests in lieu of
 * intercepting the email transport.
 */
export async function readLatestAccountVerification(
  storage: Storage,
  prefix: "account-delete:" | "account-cancel:",
): Promise<string | null> {
  const sqlite = storage as unknown as {
    __sqliteAll?: (query: string) => Promise<unknown[]>;
  };
  if (!sqlite.__sqliteAll) return null;
  const rows = (await sqlite.__sqliteAll(
    `SELECT identifier FROM auth_verification
      WHERE identifier LIKE '${prefix}%'
      ORDER BY created_at DESC LIMIT 1`,
  )) as { identifier: string }[];
  if (rows.length === 0) return null;
  return rows[0]?.identifier.slice(prefix.length) ?? null;
}
