import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createApp,
  ensureBootstrapSecret,
  createSqliteStorage,
  ensureInstanceId,
  createBlobLayer,
  initEventLog,
  __resetEventLogForTests,
  type AppConfig,
  type Storage,
} from "@withmarfa/server";
import { MarfaClient } from "./client.js";

const TEST_API_KEY_SALT = "test-salt";

/**
 * Shared test fixtures for the SDK package.
 *
 * - `createBootstrappedFixture()` — the simple bring-up. One unauthenticated
 *   `POST /keys`, which mints the operator key, then one more with it, which
 *   mints the working key the client bears. Use for any SDK surface that doesn't depend on
 *   `auth_user` resolution. Mirrors the inline pattern in
 *   `client.test.ts`.
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
    sqlitePath: "",
    blobPath: "",
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: TEST_API_KEY_SALT,
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
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:0",
    authSecret: "test-secret",
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    ...overrides,
  };
}

export interface BootstrappedFixture {
  /** SDK client wired to call the in-process server via the working key. */
  client: MarfaClient;
  /** The working key (`marfa_k1_*`) the client bears. Holds every
   *  permission and the whole content set. Use to mint additional keys in
   *  tests that need them. */
  workingKey: string;
  /** The operator key minted by the first, unauthenticated request. Holds no
   *  permission: it reaches the instance routes and nothing else. Use where a
   *  test is about the instance tier rather than about work. */
  operatorKey: string;
  /** The custom `fetch` the SDK is wired through. Pass into a second
   *  `MarfaClient` if a test needs another bearer against the same
   *  in-process app. */
  fetch: typeof globalThis.fetch;
  /** Underlying storage handle — surfaced for tests that need to seed
   *  rows directly. */
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

export async function createBootstrappedFixture(
  configOverrides?: Partial<AppConfig>,
  options?: FixtureOptions,
): Promise<BootstrappedFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-sdk-fixture-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"));
  // Before the app, so nothing this fixture serves can be written without
  // reaching the log.
  if (options?.eventLog) initEventLog(storage.eventLog);
  const config = baseConfig({
    blobPath: join(tmpDir, "blobs"),
    ...configOverrides,
  });
  const app = createApp(
    storage,
    await createBlobLayer(storage, config),
    config,
    await ensureInstanceId(storage.settings),
  );
  const fetch = createTestFetch(app);

  // **Two calls, because that is the whole of the bring-up.** The first
  // unauthenticated mint produces the operator key — which is not a working
  // key: running the instance sits outside the permission model, so the row
  // carries no permission of any kind — and the second, made with it, mints
  // the working key. A body naming no reach takes everything, because the
  // operator key is a seed rather than a ceiling.
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
  const bootstrap = (await bootstrapRes.json()) as { key: string };
  const operatorKey = bootstrap.key;
  const workingRes = await fetch("http://localhost/keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorKey}`,
    },
    body: JSON.stringify({
      label: "test-working",
      source: "sdk-test",
      default_tier: "library",
    }),
  });
  if (workingRes.status !== 201) {
    throw new Error(
      `working key mint answered ${String(workingRes.status)}: ${await workingRes.text()}`,
    );
  }
  const key = ((await workingRes.json()) as { key: string }).key;

  const client = new MarfaClient({
    url: "http://localhost",
    apiKey: key,
    fetch,
  });

  return {
    client,
    workingKey: key,
    operatorKey,
    fetch,
    storage,
    cleanup: () => {
      // Unwired here rather than left for the next fixture to overwrite:
      // the binding is module-global and outlives the storage handle it
      // points at, so a suite that ran after this one would be appending
      // to a database that has been closed.
      if (options?.eventLog) __resetEventLogForTests();
      void storage.close();
    },
  };
}
