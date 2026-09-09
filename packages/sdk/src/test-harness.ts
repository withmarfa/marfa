import { SPACE_PERMISSIONS } from "@withmarfa/shared";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import {
  createApp,
  ensureBootstrapSecret,
  createSqliteStorage,
  FilesystemBlobBackend,
  initEventLog,
  __resetCycleDetectionForTests,
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
 * Two flavors:
 *
 * - `createKeysModeFixture()` — the simple bring-up. One unauthenticated
 *   `POST /keys`, which mints the operator key, provisions the instance's
 *   one space and mints a working key into it; the client bears that
 *   working key. Use for any SDK surface that doesn't depend on
 *   `auth_user` resolution. Mirrors the inline pattern in
 *   `client.test.ts`.
 *
 * - `createHostedModeFixture()` — the hosted-mode bring-up. Boots the
 *   server in `authMode: 'hosted'`, runs a sign-up through the wrapped
 *   form endpoint (which provisions the `spaces` + `users` bridge
 *   atomically), flips `auth_user.email_verified = TRUE` directly so
 *   sign-in is unblocked, then mints an API key holding every space
 *   permission, bound to the new user's space. The returned client uses
 *   that key as bearer.
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
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: TEST_API_KEY_SALT,
    corsOrigins: [],
    seedStarterContent: false,
    cdnBaseUrl: "",
    authMode: "keys",
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
    mcpEnabled: false,
    ...overrides,
  };
}

export interface KeysModeFixture {
  /** SDK client wired to call the in-process server via the space-bound
   *  working key. */
  client: MarfaClient;
  /** The space-bound working key (`marfa_k1_*`) the client bears. Holds every
   *  space permission and the whole content set. Use to mint additional keys
   *  in tests that need them. */
  adminKey: string;
  /** The operator key minted by the first, unauthenticated request. Holds no
   *  space and no permission: it reaches the instance routes and nothing else.
   *  Use where a test is about the instance tier rather than about work. */
  operatorKey: string;
  /** The space the operator key created, which the working key is bound to. */
  spaceId: string;
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

/**
 * Behavior a fixture turns on beyond the app itself.
 *
 * Separate from `AppConfig` because none of it is configuration the
 * server reads: it is wiring the server's own bootstrap performs and
 * `createApp` does not.
 */
export interface FixtureOptions {
  /**
   * Wire the event log.
   *
   * **Without this, a subscription's event ids are `undefined` and replay
   * is inert.** `createApp` does not call `initEventLog`, so nothing is
   * appended to `event_log`: live frames still arrive, and every one of
   * them carries no id, `subscription.lastEventId` never moves off the
   * announced value, a `Last-Event-ID` replays nothing, and a cursor
   * older than the log can never be refused as too old — because the
   * check is skipped entirely when the log is empty. All of that is
   * silent. A suite testing cursors against a fixture without this flag
   * passes while proving nothing, which is why it is written down here
   * rather than left to be rediscovered.
   *
   * Off by default, and that is the point. `initEventLog` sets
   * module-global state in the server's pubsub module, so turning it on
   * for every fixture would turn event persistence on for every suite in
   * this package at once — the change most likely to produce a flake
   * nobody attributes correctly. `cleanup` unwires it again, so a file
   * that asks for it does not leave it on for whatever runs next.
   */
  eventLog?: boolean;
}

export async function createKeysModeFixture(
  configOverrides?: Partial<AppConfig>,
  options?: FixtureOptions,
): Promise<KeysModeFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-sdk-keys-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"));
  // Before the app, so nothing this fixture serves can be written without
  // reaching the log.
  if (options?.eventLog) initEventLog(storage.eventLog);
  const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
  const app = createApp(
    storage,
    blobBackend,
    baseConfig({ authMode: "keys", ...configOverrides }),
  );
  const fetch = createTestFetch(app);

  // **One call, because that is now the whole of keys-mode setup.** The first
  // unauthenticated mint produces the operator key — which is not a working
  // key: running the instance sits outside the permission model, so the row
  // carries no space and no permission of any kind — and provisions the
  // instance's one space with a credential that holds it.
  //
  // This fixture used to do those last two steps by hand, through
  // `POST /admin/spaces` and `POST /admin/spaces/{id}/keys`. That was the
  // right flow and the wrong test: a suite doing by hand what the product does
  // for itself exercises a path nobody takes and leaves the shipped one
  // uncovered.
  //
  // The mint presents the one-time secret the server prints to its boot log,
  // because that call is the product's one unauthenticated write and is bound
  // to whoever is running the instance. This fixture boots the app in-process
  // and never reads a log, so it obtains the secret the way boot does.
  const bootstrapSecret = await ensureBootstrapSecret(storage);
  const bootstrapRes = await fetch("http://localhost/keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bootstrapSecret}`,
    },
    body: JSON.stringify({
      label: "test-operator",
      source: "sdk-test-operator",
      default_tier: "feed",
    }),
  });
  const bootstrap = (await bootstrapRes.json()) as {
    key: string;
    space?: { id: string };
    space_key?: { key: string };
  };
  const operatorKey = bootstrap.key;
  const spaceId = bootstrap.space?.id;
  const key = bootstrap.space_key?.key;
  if (spaceId === undefined || key === undefined) {
    throw new Error(
      "keys-mode bootstrap returned no space: the fixture needs a working credential, and the operator key is not one",
    );
  }

  const client = new MarfaClient({
    url: "http://localhost",
    apiKey: key,
    fetch,
  });

  return {
    client,
    adminKey: key,
    operatorKey,
    spaceId,
    fetch,
    storage,
    cleanup: () => {
      // Unwired here rather than left for the next fixture to overwrite:
      // the binding is module-global and outlives the storage handle it
      // points at, so a suite that ran after this one would be appending
      // to a database that has been closed.
      if (options?.eventLog) __resetCycleDetectionForTests();
      void storage.close();
    },
  };
}

export interface HostedModeFixture extends Omit<
  KeysModeFixture,
  "adminKey" | "operatorKey" | "spaceId"
> {
  /** Email of the signed-up + email-verified user. */
  email: string;
  /** `auth_user.id` for the signed-up user, reachable through the `users`
   *  bridge from `spaceId`. */
  authUserId: string;
  /** `users.space_id` for the bridged Marfa profile. The bearer key is
   *  scoped to this space. */
  spaceId: string;
  /** An API key bound to `spaceId`, holding every space permission and
   *  writing every content family — the SDK client uses this as bearer.
   *  Use to mint additional clients in tests that need to compare auth
   *  surfaces. */
  bearerKey: string;
}

/**
 * Boot the server in hosted mode, sign up a fresh user, and mint a
 * space-scoped bearer holding the whole permission set, which resolves to
 * `auth_user.id` via the `users` bridge.
 *
 * Sign-up uses the wrapped `POST /auth/sign-up` form endpoint (not
 * better-auth's bare `/auth/sign-up/email`) — that's the path that
 * atomically provisions `spaces` + `users` rows. Email verification
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
  const spaceId = user.space_id;

  const rawKey = `marfa_k1_sdk_hosted_${suffix}`;
  await storage.keys.create(
    {
      label: `sdk-hosted-${suffix}`,
      source: `sdk-hosted-${suffix}`,
      // The whole administrative surface of the fixture's own space, named
      // rather than implied: the maps and the permission list are the entire
      // reach of a credential now, and nothing bypasses either.
      space_permissions: [...SPACE_PERMISSIONS],
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
      default_tier: "library",
      is_operator: false,
    },
    hashKey(rawKey, TEST_API_KEY_SALT),
    spaceId,
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
    spaceId,
    bearerKey: rawKey,
    cleanup: () => {
      void storage.close();
    },
  };
}
