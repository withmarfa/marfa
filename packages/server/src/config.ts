import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_MAX_STRING_LENGTH } from "@withmarfa/shared";
import { DEFAULT_DEPLOYMENT_ENVIRONMENT } from "./deployment-environment.js";
import { DEFAULT_BLOB_READ_IDLE_TIMEOUT_MS } from "./storage/blob-read.js";
import { DEFAULT_UPLOAD_IDLE_TIMEOUT_MS } from "./upload-body.js";
import type { InstanceConfig, PermissionBundle } from "@withmarfa/shared";
import { buildDefaultPermissionBundles } from "./auth/default-bundles.js";
import {
  parseTrustedProxyCidrs,
  parseTrustedProxyHeader,
} from "./middleware/client-ip.js";
import type { CidrRange } from "./middleware/client-ip.js";
import { MAX_CLOCK_OFFSET_MS } from "./clock.js";
import { readSettings, type SettingReading } from "./settings-reading.js";

/** The largest `MARFA_TEST_CONTRACT_VERSION`. */
const MAX_CONTRACT_VERSION = 2_147_483_647;
import { errorMessage } from "./error-text.js";

/**
 * The cap on every door under `/keys` when the instance names none.
 *
 * Written down once and read in both places that need it: the settings
 * schema below, and the path table in `app.ts` that a test context's
 * `AppConfig` literal leaves unset.
 */
export const DEFAULT_KEYS_RATE_LIMIT = 200;

/**
 * The hours an event stays in the event log when the instance names none:
 * 30 days, so a device offline for up to a month catches up from the log
 * instead of hydrating again.
 *
 * Written down once and read wherever an `AppConfig` literal leaves
 * `eventLogRetentionHours` unset.
 */
export const DEFAULT_EVENT_LOG_RETENTION_HOURS = 720;

// A century-scale retention horizon keeps cutoff dates in ordinary ISO years.
export const MAX_RETENTION_DAYS = 36_500;
export const MAX_RETENTION_HOURS = MAX_RETENTION_DAYS * 24;
export const MAX_RETENTION_MS = MAX_RETENTION_HOURS * 3_600_000;
// Native JavaScript timers support at most a signed 32-bit millisecond delay;
// a longer one fires after 1 ms. `AbortSignal.timeout` refuses one past 2^32 - 1.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** What bounds the inbound webhook doors. */
export interface InboundLimits {
  /** The largest delivery the door stores, in bytes. */
  maxBytes: number;
  /** Receipts per endpoint per `rateLimitWindowMs`, while the limiter is on. */
  requestsPerWindow: number;
  /** Unhandled deliveries a registration may hold before the door refuses. */
  backlogDeliveries: number;
  /** Their bytes. */
  backlogBytes: number;
  /** All retained deliveries across live and retired endpoints. */
  retainedDeliveries: number;
  /** Logical body and metadata charge across all retained deliveries. */
  retainedBytes: number;
  cleanupIntervalMs: number;
  /** Bytes the door holds in memory across every receipt at once. */
  inFlightBytes: number;
  /** How long a body has to arrive whole, so a stalled sender cannot hold in-flight bytes. */
  readTimeoutMs: number;
  handledRetentionDays: number;
  pendingRetentionDays: number;
}

/**
 * GitHub caps a payload at 25 MB. An unhandled delivery is kept long past
 * any sender's own redelivery window, so a connector off for weeks loses
 * nothing that arrived.
 */
export const DEFAULT_INBOUND_LIMITS: InboundLimits = {
  maxBytes: 25 * 1024 * 1024,
  requestsPerWindow: 600,
  backlogDeliveries: 10_000,
  backlogBytes: 1024 * 1024 * 1024,
  retainedDeliveries: 10_000,
  retainedBytes: 1024 * 1024 * 1024,
  cleanupIntervalMs: 60_000,
  inFlightBytes: 100 * 1024 * 1024,
  readTimeoutMs: 30_000,
  handledRetentionDays: 7,
  pendingRetentionDays: 30,
};

export const DEFAULT_CONNECTOR_HOLD_MS = 180_000;

export interface AppConfig {
  /** True when `NODE_ENV === "production"`. Gates production-only
   *  hardenings (e.g. CORS localhost auto-reflection is dev-only).
   *  Optional on the type so test contexts constructing `AppConfig`
   *  literals don't have to supply it; readers treat `undefined` as
   *  non-production. `loadConfig` always populates it. */
  isProduction?: boolean;
  port: number;
  /** Unset keeps the runtime's unspecified listening address. */
  listenHost?: string;
  sqlitePath: string;
  controlSocket?: string;
  controlOnly?: boolean;
  /** `MARFA_TEST_HOOKS`: whether the private control socket serves the
   *  clock and fault routes a conformance harness drives. Never true in
   *  production; `loadConfig` refuses that. */
  testHooks?: boolean;
  /** `MARFA_TEST_CLOCK_OFFSET_MS`: how far ahead of the system clock the
   *  server's clock starts, so a restart keeps the time the harness moved to. */
  testClockOffsetMs?: number;
  /** `MARFA_TEST_CONTRACT_VERSION`: the contract version the server speaks
   *  instead of the build's, so a harness can show what a change of contract
   *  does to what the server kept. Unset speaks the build's. */
  testContractVersion?: number;
  /** `MARFA_TEST_MIGRATION_FAULT` and `MARFA_TEST_FREE_DISK_BYTES`: what
   *  the update of an earlier schema version meets, so a harness can show a
   *  failed, interrupted or refused update changes nothing. */
  testMigration?: {
    fault?: "hold" | "lose-row" | "change-shape";
    freeDiskBytes?: number;
  };
  /** The disk store: where every upload lands. Always present. */
  blobPath: string;
  /** Ordinary JSON body cap, excluding the doors with separate caps in
   *  `bodyCapFor`. `MARFA_MAX_REQUEST_BYTES`, default 1 MiB. */
  maxRequestBytes: number;
  /** Max body size in bytes for the doors `bodyCapFor` names bulk; batches
   *  outgrow the per-request cap. `MARFA_MAX_BULK_REQUEST_BYTES`, 16MB. */
  maxBulkRequestBytes?: number;
  /** The object store, attached when this is set: a second place the bytes
   *  live, and the one that signs its own fetch links. */
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  /** See `S3BlobConfig.forcePathStyle`. Defaults true; only read when an
   *  endpoint is set. Optional on the type so test contexts constructing
   *  `AppConfig` literals don't have to supply it; `loadConfig` always
   *  populates it. */
  s3ForcePathStyle?: boolean;
  /** Key prefix the instance keeps everything in the bucket under
   *  (`S3_PREFIX`, default `blobs`): the blobs, and the database replica at
   *  `<prefix>/db`, so one bucket can carry several instances. Optional on
   *  the type for the same reason as `s3ForcePathStyle`. */
  s3Prefix?: string;
  apiKeySalt: string;
  corsOrigins: string[];
  /** Named consent-screen permission bundles (see `DEFAULT_PERMISSION_BUNDLES`).
   *  `loadConfig` sets it only from the operator's override,
   *  `MARFA_PERMISSION_BUNDLES`; boot fills it otherwise, and readers fall
   *  back to `getPermissionBundles()`. */
  permissionBundles?: PermissionBundle[];
  rateLimitEnabled: boolean;
  enableHsts: boolean;
  auditRetentionDays: number;
  auditCleanupIntervalMs: number;
  /** Days a revoked application-grant row survives before the purger
   *  drops it. Default 90; env override `MARFA_REVOKED_GRANT_RETENTION_DAYS`.
   *  `0` switches the housekeeping job off.
   *
   *  **Ninety rather than a number of its own, and matching
   *  `AUDIT_RETENTION_DAYS` on purpose.** The revoked grant row and the audit row that
   *  recorded the revocation are the same fact written twice, so keeping them
   *  for different lengths would let the two disagree about whether a
   *  revocation is still visible.
   *
   *  They accumulate because the grant lookup skips a revoked row, which makes
   *  a soft-delete permanent rather than reusable: every revoke-then-reconnect
   *  cycle leaves one behind. */
  revokedGrantRetentionDays?: number;
  /** Days an app grant may go unused before it is retired: the grant
   *  cascade runs and an `auth.grant.retired` row is written. Default 365;
   *  env override `MARFA_GRANT_INACTIVITY_DAYS`; `0` disables. */
  grantInactivityDays?: number;
  /** Hours an event_log entry survives at least before the event-log
   *  housekeeping job may purge it.
   *  Default `DEFAULT_EVENT_LOG_RETENTION_HOURS` (720, 30 days). Controls how far back a client's SSE replay
   *  cursor can reach; a request whose `Last-Event-ID` is followed by an
   *  event no longer retained gets a terminal `catchup_too_old` event.
   *  Optional on the type so callers constructing `AppConfig` literals
   *  don't have to supply it; the default applies in their place. */
  eventLogRetentionHours?: number;
  /** Cadence (ms) for the event-log cleanup sweep that purges expired
   *  `event_log` rows. Default 3_600_000 (1h); env override
   *  `MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS`. Optional on the type;
   *  `housekeeping/registrations.ts` applies the 1h fallback when unset. */
  eventLogCleanupIntervalMs?: number;
  versionThinningIntervalMs: number;
  feedExpiryIntervalMs: number;
  versionRecentDays: number;
  versionDailySnapshotDays: number;
  versionWeeklySnapshotDays: number;
  versionMaxVersions: number;
  /** Days a trashed item survives before it's hard-deleted by the trash
   *  purger. `0` switches the housekeeping job off. Default: 60. */
  trashRetentionDays: number;
  trashPurgeIntervalMs: number;
  /** Cadence (ms) for the better-auth session cleanup sweep — drops
   *  `auth_session` rows whose `expires_at` has passed. Default
   *  3_600_000 (1h); env override `AUTH_SESSION_CLEANUP_INTERVAL_MS`.
   *  No retention-window knob — Better Auth itself owns the TTL.
   *  Optional on the type; `housekeeping/registrations.ts` applies the 1h
   *  fallback. */
  authSessionCleanupIntervalMs?: number;
  /** Days a registered client that no grant names survives, counted from
   *  its registration or the last time an approval page offered it, before
   *  the reaper hard-deletes it. Registration takes no credential and
   *  answers every origin, so this bounds what any page can leave behind;
   *  one day is far longer than any approval takes, since the offer itself
   *  restarts the count. `0` switches the housekeeping job off. Env override
   *  `MARFA_DCR_CLIENT_RETENTION_DAYS`. Optional on the type;
   *  `housekeeping/registrations.ts` applies the fallback. */
  dcrClientRetentionDays?: number;
  /** Cadence (ms) for the registration reaper. Env override
   *  `MARFA_DCR_CLIENT_CLEANUP_INTERVAL_MS`. Optional on the type;
   *  `housekeeping/registrations.ts` applies the fallback. */
  dcrClientCleanupIntervalMs?: number;
  /** Cadence (ms) for the unreferenced-blob sweep, `blob-orphans`. A full
   *  pass over the item corpus and the version history, so this is
   *  deliberately slow: default 86_400_000 (24h); env override
   *  `MARFA_BLOB_CLEANUP_INTERVAL_MS`. `0` switches the sweep off. */
  blobCleanupIntervalMs?: number;
  /** How long (ms) a blob has to have stood in the orphan report before a
   *  later run of the sweep purges it. The report is what stands between
   *  an unreferenced blob and its deletion: a run reports, and a run at
   *  least this much later purges what is still unreferenced. `0` lets the
   *  next run purge what the one before reported. Default 86_400_000
   *  (24h); env override `MARFA_BLOB_CLEANUP_GRACE_MS`. */
  blobCleanupGraceMs?: number;
  /** The live copies a blob keeps at the least: a drop that would leave
   *  fewer is refused. A positive integer; default 1; env override
   *  `MARFA_BLOB_MIN_COPIES`. */
  blobMinCopies?: number;
  /** Idle lifetime of a blob read before its file or socket is closed. */
  blobReadIdleTimeoutMs?: number;
  /** How long a restore or blob upload may receive no bytes before it is
   *  ended `408 request_timeout`. Optional on the type so a test context's
   *  `AppConfig` literal takes `DEFAULT_UPLOAD_IDLE_TIMEOUT_MS`; env
   *  override `MARFA_UPLOAD_IDLE_TIMEOUT_MS`. */
  uploadIdleTimeoutMs?: number;
  /** The free bytes uploads, restores, and archive exports must leave on
   *  the disk store's volume. A non-negative integer; default 134_217_728 (128 MiB); env
   *  override `MARFA_DISK_RESERVE_BYTES`. */
  diskReserveBytes?: number;
  /** Cadence (ms) for `blob-replicate`, which gives every attached store
   *  the copies its policy wants; an upload wakes it too. A positive
   *  integer, since the housekeeping job has no off switch: a store the
   *  configuration names is a store whose copies are kept. Default
   *  60_000; env override
   *  `MARFA_BLOB_REPLICATE_INTERVAL_MS`. */
  blobReplicateIntervalMs?: number;
  /** Most blobs, and most bytes, one replication run copies before it
   *  answers and is woken again. Positive integers; defaults 100 and 1 GiB;
   *  env overrides `MARFA_BLOB_REPLICATE_BATCH` and
   *  `MARFA_BLOB_REPLICATE_BATCH_BYTES`. */
  blobReplicateBatch?: number;
  blobReplicateBatchBytes?: number;
  /** Cadence (ms) for `blob-integrity`, which checks the copies the
   *  copy record names, least recently checked first. A positive integer, for the
   *  reason replication's is. Default 3_600_000 (1h); env override
   *  `MARFA_BLOB_INTEGRITY_INTERVAL_MS`. */
  blobIntegrityIntervalMs?: number;
  /** Most copies, and most bytes, one integrity run checks. Positive
   *  integers; defaults 500 and 1 GiB; env overrides
   *  `MARFA_BLOB_INTEGRITY_BATCH` and `MARFA_BLOB_INTEGRITY_BATCH_BYTES`. */
  blobIntegrityBatch?: number;
  blobIntegrityBatchBytes?: number;
  /** Cadence (ms) for the `rate_limit_windows` GC sweep that drops rows
   *  past their `expires_at`. Default 3_600_000 (1h); env override
   *  `MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS`. Optional;
   *  `housekeeping/registrations.ts` applies the 1h fallback when unset. */
  rateLimitCleanupIntervalMs?: number;
  /** Deterministic text extraction from file blobs. On unless
   *  `MARFA_ENRICHMENT_ENABLED=false`: extraction is what makes an
   *  uploaded document findable, so an operator opts out rather than in. */
  enrichmentEnabled?: boolean;
  /** Cadence (ms) of the enrichment sweep. Default 30_000; env override
   *  `MARFA_ENRICHMENT_INTERVAL_MS`. */
  enrichmentIntervalMs?: number;
  /** Items extracted per sweep. Default 8; env override
   *  `MARFA_ENRICHMENT_BATCH_SIZE`. Small because extraction is
   *  CPU-bound and shares the event loop with the request path. */
  enrichmentBatchSize?: number;
  /** Per-item extraction budget (ms). Default 60_000; env override
   *  `MARFA_ENRICHMENT_ITEM_TIMEOUT_MS`. */
  enrichmentItemTimeoutMs?: number;
  /** Blobs above this size are skipped without being read. Default
   *  20MB; env override `MARFA_ENRICHMENT_MAX_BLOB_BYTES`. */
  enrichmentMaxBlobBytes?: number;
  /** Extracted text is cut to at most this many UTF-16 code units.
   *  Defaults to the validator's own default string ceiling, because text
   *  longer than that is a value the write path refuses; env override
   *  `MARFA_ENRICHMENT_MAX_TEXT_CHARS`. Raising it past the ceiling is
   *  allowed and is not silently clamped: the sweeper validates before it
   *  writes, so an over-long extraction is parked rather than stored. */
  enrichmentMaxTextChars?: number;
  /** How many times a failing item is retried before the sweeper stops
   *  offering it. Default 3; env override
   *  `MARFA_ENRICHMENT_MAX_ATTEMPTS`. */
  enrichmentMaxAttempts?: number;
  /** The most a document may inflate to, all its parts together, when its
   *  text is extracted; a document past it is skipped. Default 64 MiB; env
   *  override `MARFA_ENRICHMENT_MAX_INFLATED_BYTES`. */
  enrichmentMaxInflatedBytes?: number;
  /** The most the JavaScript heap of the process that reads one document
   *  may take; a document that needs more is skipped. Default 256 MiB; env override
   *  `MARFA_ENRICHMENT_MAX_MEMORY_BYTES`. */
  enrichmentMaxMemoryBytes?: number;
  /** OCR of image files. On unless `MARFA_ENRICHMENT_OCR_ENABLED=false`.
   *  Off parks image text extraction; enabling it reconsiders skipped images.
   *  The wasm core is the heaviest thing extraction loads. */
  enrichmentOcrEnabled?: boolean;
  /** Directory the OCR language model is cached in across runs. Default
   *  {@link defaultTessdataDir}; env override `MARFA_ENRICHMENT_TESSDATA_DIR`.
   *  The model downloads on first use, so a writable path here is what
   *  stops every restart re-fetching it. */
  enrichmentTessdataDir?: string;
  /** How long a terminal `bulk_action_jobs` row survives before the GC
   *  sweep drops it. Counted against `finished_at`. Default 7 days; env
   *  override `MARFA_BULK_ACTION_JOB_RETENTION_MS`. Set to `0` to
   *  disable the sweep entirely (the table grows unbounded). */
  bulkActionJobRetentionMs?: number;
  /** Cadence (ms) for the `bulk_action_jobs` GC sweep. Default 3_600_000
   *  (1h); env override `MARFA_BULK_ACTION_JOB_GC_INTERVAL_MS`. */
  bulkActionJobGcIntervalMs?: number;
  /** Base (and floor) poll cadence for the in-process bulk-action worker
   *  loop. Default 500ms; env override `MARFA_BULK_ACTION_POLL_INTERVAL_MS`. */
  bulkActionPollIntervalMs?: number;
  /** Ceiling the bulk-action worker's idle poll backoff widens toward, so a
   *  quiet worker stops polling the DB every base interval. Default 60_000
   *  (60s); env override `MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS`. */
  bulkActionPollMaxIntervalMs?: number;
  /** Factor the bulk-action worker's empty-poll interval grows by each idle
   *  tick. Default 2; env override `MARFA_BULK_ACTION_POLL_BACKOFF_MULTIPLIER`. */
  bulkActionPollBackoffMultiplier?: number;
  /** Whether outbound webhooks may reach loopback, private and other
   *  non-public addresses, for an operator whose receivers run on a private
   *  network. Optional on the type so test contexts constructing
   *  `AppConfig` literals keep the default, off. */
  webhookAllowPrivateAddresses?: boolean;
  /** Whether MCP tools fetch files from web addresses. Optional on the
   *  type so a test context's `AppConfig` literal takes the default, on. */
  mcpFetchEnabled?: boolean;
  /** The largest file an MCP tool fetches from a web address. Optional on
   *  the type so a test context's `AppConfig` literal takes the default. */
  mcpFetchMaxBytes?: number;
  /** How long an MCP tool's fetch from a web address may take. */
  mcpFetchTimeoutMs?: number;
  /** The environment exported telemetry and an error notification name:
   *  `deployment.environment.name` or `deployment.environment` of
   *  `OTEL_RESOURCE_ATTRIBUTES`, else `production`. Optional on the type so
   *  a test context's `AppConfig` literal takes the default. */
  deploymentEnvironment?: string;
  errorReportingEnabled?: boolean;
  heartbeatEnabled?: boolean;
  errorWebhookUrl: string;
  /** Per-fetch timeout (ms) for error-webhook delivery in
   *  `middleware/error-notifier.ts`. Env override
   *  `MARFA_ERROR_WEBHOOK_TIMEOUT_MS`. Default 5000. Optional on the type
   *  so test contexts constructing `AppConfig` literals don't have to
   *  supply it; `loadConfig` always populates it. */
  errorWebhookTimeoutMs?: number;
  /** Pre-parsed CIDR list for opt-in `x-forwarded-for` trust. Empty
   *  means "no proxy trusted; ignore the header". See middleware/client-ip.ts. */
  trustedProxyCidrs: CidrRange[];
  /** Header the platform's edge overwrites with the client address, for
   *  platforms whose edge has no pinnable CIDR. Null means unset. Takes
   *  precedence over `trustedProxyCidrs`. Optional on the type for the same
   *  reason as `s3ForcePathStyle`. See middleware/client-ip.ts. */
  trustedProxyHeader?: string | null;
  /** Issuer URL the better-auth instance is reached at — protocol + host
   *  (and port). Drives cookie domains and the OAuth issuer field on the
   *  discovery doc. Defaults to a loopback origin with the assigned listening port if unset. */
  authBaseUrl: string;
  /** The implicit development origin follows the port assigned by the listener. */
  authBaseUrlFromPort?: boolean;
  /** Signs Better Auth's cookies and authorize query, and keys the blob
   *  link. Required in production; minted per process otherwise. */
  authSecret: string;
  /** How long a write refused with `SQLITE_BUSY` is retried before it
   *  answers `503 write_contention`. Read from
   *  `SQLITE_BUSY_BUDGET_MS` (default 5_000). Configurable so an
   *  instance under a slow sidecar can wait longer, and so a fixture can
   *  boot at `0` and provoke the refusal rather than racing a
   *  five-second retry loop for it. Optional on the type, following
   *  `rateLimitAggregateMultiplier`, so a test context constructing an
   *  `AppConfig` literal need not supply it; the one default lives in
   *  `storage/sqlite/connection.ts` and absence leaves it standing. */
  sqliteBusyBudgetMs?: number;
  /** Default per-credential rate limit, requests per `rateLimitWindowMs`
   *  window. Read from `RATE_LIMIT_REQUESTS` (default 1000). Wired through
   *  the rate-limit middleware so there's a single env-read site. */
  rateLimitDefaultLimit: number;
  /** Rate-limit window size in ms. Read from `RATE_LIMIT_WINDOW_MS`
   *  (default 60_000) — configurable, not hard-coded. */
  rateLimitWindowMs: number;
  /** The cap on every door under `/keys`, requests per
   *  `rateLimitWindowMs` window. Read from `RATE_LIMIT_KEYS_REQUESTS`
   *  (default `DEFAULT_KEYS_RATE_LIMIT`); `app.ts` says why these doors
   *  are capped apart from the rest. Bounded from above by the aggregate
   *  window, `rateLimitDefaultLimit * rateLimitAggregateMultiplier`,
   *  which keys on the credential alone: a number past that one cannot
   *  be reached. Optional on the type, following
   *  `rateLimitAggregateMultiplier`, so a test context constructing an
   *  `AppConfig` literal need not supply it. */
  rateLimitKeysLimit?: number;
  /** Multiplier for the aggregate per-identifier rate-limit window. The
   *  aggregate cap is `rateLimitDefaultLimit * this`, keyed on the
   *  identifier alone (no path split) so a caller's budget can't
   *  multiply across path groups. Read from
   *  `RATE_LIMIT_AGGREGATE_MULTIPLIER` (default 4). `0` disables the
   *  aggregate window. Optional on the type so test contexts
   *  constructing `AppConfig` literals don't have to supply it. */
  rateLimitAggregateMultiplier?: number;
  /** Optional on the type so a test context's `AppConfig` literal takes
   *  `DEFAULT_INBOUND_LIMITS`. */
  inbound?: InboundLimits;
  /** Optional on the type so a test context's `AppConfig` literal takes
   *  `DEFAULT_CONNECTOR_HOLD_MS`. */
  connectorHoldMs?: number;
  /** Deployed-build identifier, surfaced on `GET /` as `version` and on
   *  telemetry as the service version: the `sha` in `version.json`, which
   *  the image writes at build time. Unset in development, where readers
   *  report `"dev"`. It is not the contract version, which `GET /` answers
   *  as `contract`. */
  versionSha?: string;
  /** The release the image was built as, `major.minor.patch`: the `release`
   *  in `version.json`, surfaced on `GET /` as `release`. Unset for a build
   *  that is not a release, which says nothing rather than a placeholder. */
  releaseVersion?: string;
  /** The whole of `version.json`, which `/health` reports. */
  versionFile?: Record<string, unknown>;
  /** Where this deployment says it runs, reported on `/health`; unset when
   *  it states nothing. */
  placement?: Placement;
  /** Telemetry, read by `instrumentation.ts`. Optional on the type so a test
   *  context's `AppConfig` literal need not supply it. */
  otel?: OtelSettings;
  /** Exception reports, read by `instrumentation.ts`. */
  exceptions?: ExceptionSettings;
  /** Liveness heartbeat target (`MARFA_HEARTBEAT_URL`). Empty = off, the
   *  default. When set, the server GETs this URL on its housekeeping
   *  cadence so something running elsewhere can notice when the pings
   *  stop — a process cannot report its own death. A ping, not a report:
   *  no payload leaves. */
  heartbeatUrl?: string;
  /** Heartbeat cadence in ms (`MARFA_HEARTBEAT_INTERVAL_MS`, default
   *  60000). Ignored while `heartbeatUrl` is unset. */
  heartbeatIntervalMs?: number;
  /** How often (ms) the housekeeping scheduler asks its table what is due
   *  (`MARFA_HOUSEKEEPING_POLL_INTERVAL_MS`, default 1000). The floor on
   *  how late a housekeeping job runs after it falls due, and on how soon a wake is
   *  answered. Optional on the type; `index.ts` applies the default. */
  housekeepingPollIntervalMs?: number;
  /** Ceiling on concurrent SSE viewers per server instance
   *  (`MARFA_SSE_MAX_VIEWERS`, default 0 = uncapped). A deliberate
   *  memory bound: viewers hold no database connection, so any limit is
   *  a stated choice rather than a pool artifact. */
  sseMaxViewers?: number;
  /** What boot logs as a warning: names in the environment that look like a
   *  misspelled setting, and a setting that turns off one report. */
  settingWarnings?: string[];
  /** Every setting as the console shows it. A secret has no value in it.
   *  Optional on the type for the same reason as `s3ForcePathStyle`. */
  settingReadings?: SettingReading[];
}

/** Where the deployment says it runs: free text, set per environment. */
export interface Placement {
  region?: string;
  location?: string;
  country?: string;
}

/** What every report of the server shares, whichever of them is asked for. */
export interface TelemetryIdentity {
  serviceName: string;
  /** `OTEL_RESOURCE_ATTRIBUTES`, which replace the server's own of the same
   *  name. `service.name` is not among them: it is `serviceName`. */
  resourceAttributes: Record<string, string>;
}

/**
 * Present only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_SDK_DISABLED`
 * is not `true`. Absent, no trace or log record is exported.
 */
export interface OtelSettings extends TelemetryIdentity {
  /** Each signal's resolved URL. */
  tracesEndpoint: string;
  logsEndpoint: string;
  /** Each signal's headers: the general ones, overridden by its own. */
  tracesHeaders: Record<string, string>;
  logsHeaders: Record<string, string>;
  /** Baseline trace sample ratio; errors export whatever it says, see
   *  `otel/error-aware-sampler.ts`. */
  sampleRatio: number;
}

/**
 * Exception reports to PostHog: present when `MARFA_POSTHOG_HOST` is usable,
 * `MARFA_POSTHOG_PROJECT_TOKEN` is set and `OTEL_SDK_DISABLED` is not `true`,
 * whatever the OTLP settings are. OTLP carries no exceptions into PostHog's
 * error tracking, so this is a pipeline of its own.
 */
export interface ExceptionSettings extends TelemetryIdentity {
  posthogHost: string;
  posthogToken: string;
}

/**
 * The default consent-screen permission bundles, derived from the type
 * registry at module load. A type renders as one plain-language control
 * with a level for each of its scopes; the issued token carries exactly the
 * scopes the user chooses, enforced through the usual permission maps. Every
 * bundle here declares `default_on: true`, so all of them start on, and that
 * is a property of these five rather than of the renderer.
 *
 * The derivation, its family rules, and the rationale each rule carries
 * live in `auth/default-bundles.ts`. A deployment that registered custom
 * types under its own publisher handles gets those namespaces
 * folded in at boot via {@link setActivePermissionBundles}; this constant
 * is the registry-only baseline.
 */
export const DEFAULT_PERMISSION_BUNDLES: PermissionBundle[] =
  buildDefaultPermissionBundles();

/**
 * Bundles installed at boot: the operator's override when one is set,
 * otherwise the defaults with the runtime custom-type namespaces folded in.
 * Null until then, and in a test that never installs any.
 */
let activePermissionBundles: PermissionBundle[] | null = null;

/** Install the active bundle set. Called once at boot, and by tests. */
export function setActivePermissionBundles(
  bundles: PermissionBundle[] | null,
): void {
  activePermissionBundles = bundles;
}

/** Resolve the active permission bundles. */
export function getPermissionBundles(): PermissionBundle[] {
  return activePermissionBundles ?? DEFAULT_PERMISSION_BUNDLES;
}

/**
 * The OCR model cache sits beside the database, so it lands on whatever
 * volume holds the instance's data rather than under the working
 * directory. An in-memory or `file:` database has no directory to sit
 * beside.
 */
export function defaultTessdataDir(sqlitePath: string): string {
  if (sqlitePath === ":memory:" || sqlitePath.startsWith("file:")) {
    return "./data/tessdata";
  }
  return join(dirname(sqlitePath), "tessdata");
}

// ---------------------------------------------------------------------------
// The settings schema
// ---------------------------------------------------------------------------

/**
 * What a setting accepts, as data. The refusal text a parser throws and the
 * settings table in `conformance/spec/instance.md` are both written from the
 * same numbers, so neither can drift from the rule.
 */
export type SettingRule =
  | { kind: "count"; min: number; max?: number; unit?: SettingUnit }
  | { kind: "decimal"; min: number; max: number }
  | { kind: "flag" }
  | { kind: "choice"; values: readonly string[] }
  | { kind: "url" }
  | { kind: "text" }
  | { kind: "key-prefix" }
  | { kind: "secret"; minLength?: number }
  | { kind: "origins" }
  | { kind: "cidrs" }
  | { kind: "header-name" }
  | { kind: "headers" }
  | { kind: "permission-bundles" };

/** What a number counts, when it counts something named. */
export type SettingUnit = "ms" | "days" | "hours" | "bytes";

/** The groups the console lists settings under, in the order it lists them. */
export const SETTING_GROUPS = [
  "Address and network",
  "Where data is kept",
  "File storage",
  "Sign-in and access",
  "Keeping things",
  "Text from files",
  "Alerts and monitoring",
  "Connectors and webhooks",
  "Limits",
  "Fine tuning",
  "Development and testing",
] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** Settings the owner can change while the server runs, by their name in `/config`. */
export type LiveSetting = keyof Pick<
  InstanceConfig,
  | "audit_retention_days"
  | "event_log_retention_hours"
  | "trash_retention_days"
  | "inbound_handled_retention_days"
  | "inbound_pending_retention_days"
  | "version_recent_days"
  | "version_daily_snapshot_days"
  | "version_weekly_snapshot_days"
  | "version_max_versions"
  | "grant_inactivity_days"
  | "enrichment_enabled"
  | "enrichment_ocr_enabled"
  | "error_reporting_enabled"
  | "heartbeat_enabled"
>;

/** How a stated value is read: it throws to refuse, and the message completes "NAME ...". */
interface Parser<T> {
  rule: SettingRule;
  parse: (value: string) => T;
}

/** A setting as the settings table states it. */
export interface SettingDescription {
  name: string;
  rule: SettingRule;
  /** What an unset or blank value resolves to. Absent for a secret, and for a setting that resolves to nothing. */
  default?: string | number | boolean;
  /** Said in words where the default is not one value: derived from another setting or from the environment. */
  defaultNote?: string;
  /** Never echoed into a refusal, which lands in a log. */
  secret: boolean;
  /** One plain statement of what the setting controls. */
  description: string;
  /** The one group the console lists it under. */
  group: SettingGroup;
  /** What the console calls it. */
  label: string;
  /** Its name in `PUT /config`, when the owner can also change it while the server runs. */
  live?: LiveSetting;
}

type SettingMeta = Omit<
  SettingDescription,
  "name" | "group" | "label" | "live"
> &
  Partial<Pick<SettingDescription, "group" | "label" | "live">>;

const SETTING_META = new WeakMap<object, SettingMeta>();

interface SettingOptions {
  /** Never echoed into a refusal, and no default is stated. */
  secret?: boolean;
  defaultNote?: string;
}

/**
 * Puts a setting in its group and names it for the console. Every setting
 * in the schema passes through here, and `describeSettings` refuses one that
 * did not.
 */
function grouped<S extends z.ZodType>(
  placing: { group: SettingGroup; label: string; live?: LiveSetting },
  schema: S,
): S {
  const meta = SETTING_META.get(schema);
  if (meta === undefined) throw new Error(`${placing.label} is not a setting`);
  SETTING_META.set(schema, { ...meta, ...placing });
  return schema;
}

/** An empty default is no default: the setting then resolves to nothing. */
function statedDefault(value: unknown): SettingMeta["default"] {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

/**
 * One setting: what an unset or blank value resolves to, how a stated value
 * is read, and one line on what it controls. Blank counts as unset, so an
 * orchestrator that writes `NAME=` for every variable it knows about leaves
 * the default standing.
 */
function setting<T>(
  parser: Parser<T>,
  fallback: () => T,
  description: string,
  { secret = false, defaultNote }: SettingOptions = {},
) {
  const schema = z
    .string()
    .optional()
    .transform((raw, ctx): T => {
      const value = raw?.trim();
      if (value === undefined || value === "") return fallback();
      try {
        return parser.parse(value);
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: errorMessage(err),
        });
        return z.NEVER;
      }
    });
  const stated = secret ? undefined : statedDefault(fallback());
  SETTING_META.set(schema, {
    rule: parser.rule,
    ...(stated !== undefined && { default: stated }),
    ...(defaultNote !== undefined && { defaultNote }),
    secret,
    description,
  });
  return schema;
}

/**
 * A secret is used exactly as written, never trimmed: a value read from a
 * file often ends in a newline, and trimming it would key every hash and
 * signature with something other than what was set. Surrounding whitespace
 * is refused instead, so neither reading happens silently.
 */
const DEFAULT_SALT = "dev-salt-change-in-production";
/** Every process signs with `MARFA_AUTH_SECRET` (`crypto/derive-key.ts`
 * and Better Auth), so a short one is refused outside production too. */
const SECRET_MIN_LENGTH = 32;

function secretSetting(
  description: string,
  defaultNote?: string,
  minLength?: number,
) {
  const schema = z
    .string()
    .optional()
    .transform((raw, ctx): string | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      if (raw !== raw.trim()) {
        ctx.addIssue({
          code: "custom",
          message:
            "has whitespace around it, which would be part of the secret; remove it",
        });
        return z.NEVER;
      }
      if (minLength !== undefined && raw.length < minLength) {
        ctx.addIssue({
          code: "custom",
          message: `must be at least ${String(minLength)} characters; generate one with \`openssl rand -hex 32\``,
        });
        return z.NEVER;
      }
      return raw;
    });
  SETTING_META.set(schema, {
    rule: {
      kind: "secret",
      ...(minLength !== undefined && { minLength }),
    },
    ...(defaultNote !== undefined && { defaultNote }),
    secret: true,
    description,
  });
  return schema;
}

/** Plain digits only, not `Number()`'s grammar: `1e2` is not a hundred and `0x10` is not sixteen. */
function wholeNumber(
  min: number,
  max?: number,
  unit?: SettingUnit,
): Parser<number> {
  const ceiling = max ?? Number.MAX_SAFE_INTEGER;
  return {
    rule: {
      kind: "count",
      min,
      ...(max !== undefined && { max }),
      ...(unit !== undefined && { unit }),
    },
    parse: (value) => {
      const parsed = Number(value);
      if (!/^\d+$/.test(value) || parsed < min || parsed > ceiling) {
        const range =
          max === undefined
            ? `${String(min)} or more`
            : `from ${String(min)} to ${String(max)}`;
        throw new Error(`must be a whole number, ${range}`);
      }
      return parsed;
    },
  };
}

function decimal(min: number, max: number): Parser<number> {
  return {
    rule: { kind: "decimal", min, max },
    parse: (value) => {
      const parsed = Number(value);
      if (
        !/^\d+(\.\d+)?$/.test(value) ||
        !Number.isFinite(parsed) ||
        parsed < min ||
        parsed > max
      ) {
        throw new Error(
          `must be a number from ${String(min)} to ${String(max)}`,
        );
      }
      return parsed;
    },
  };
}

function choice<const T extends string>(...values: readonly T[]): Parser<T> {
  const last = values[values.length - 1];
  const message = `must be ${values.slice(0, -1).join(", ")} or ${String(last)}`;
  return {
    rule: { kind: "choice", values },
    parse: (value) => {
      const match = values.find((candidate) => candidate === value);
      if (match === undefined) throw new Error(message);
      return match;
    },
  };
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

const flag: Parser<boolean> = {
  rule: { kind: "flag" },
  parse: (value) => {
    const word = value.toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    throw new Error("must be true or false (also 1/0, yes/no, on/off)");
  },
};

/**
 * `OTEL_SDK_DISABLED` as the command line reads it (`telemetry/settings.rs`):
 * `true` in any case switches telemetry off and every other value leaves it
 * on, so one shell setting means the same to both.
 */
const disabledSwitch: Parser<boolean> = {
  rule: { kind: "flag" },
  parse: (value) => value.toLowerCase() === "true",
};

/** Text kept as written; {@link usablePosthogHost} judges it. */
const anyAddress: Parser<string> = {
  rule: { kind: "url" },
  parse: (value) => value,
};

const httpUrl: Parser<string> = {
  rule: { kind: "url" },
  parse: (value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("must be an absolute http or https URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("must be an absolute http or https URL");
    }
    return value;
  },
};

/** The instance's public address, which anyone may read: no user info and no query string. */
const publicUrl: Parser<string> = {
  rule: { kind: "url" },
  parse: (value) => {
    httpUrl.parse(value);
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.search !== "") {
      throw new Error("must have no user name, password or query string");
    }
    return value;
  },
};

const text: Parser<string> = {
  rule: { kind: "text" },
  parse: (value) => value,
};

/**
 * `deploy/entrypoint.sh` reads the value the same way for the database
 * replica, `<prefix>/db`, before the server starts, and `ci/entrypoint.test.ts`
 * holds the two readings together. A segment that is empty, `.` or `..` is
 * refused because an HTTP client or a store that normalizes the path would
 * read two different prefixes as one place, such as `trial/../blobs` as
 * `blobs`.
 */
const keyPrefix: Parser<string> = {
  rule: { kind: "key-prefix" },
  parse: (value) => {
    const prefix = value.replace(/^\/+/, "").replace(/\/+$/, "");
    const segments = prefix.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          !/^[A-Za-z0-9._-]+$/.test(segment),
      )
    ) {
      throw new Error(
        "must be segments of letters, digits, `.`, `_` and `-` joined by `/`, none of them `.` or `..`, such as `blobs` or `trial/blobs`",
      );
    }
    return prefix;
  },
};

/** The comparison is exact, so `https://app.example/` would never match an `Origin` header. */
const origins: Parser<string[]> = {
  rule: { kind: "origins" },
  parse: (value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        let origin: string;
        try {
          origin = new URL(entry).origin;
        } catch {
          origin = "null";
        }
        if (origin !== entry) {
          throw new Error(
            `must list origins, scheme and host with no path or trailing slash; "${entry}" is not one`,
          );
        }
        return entry;
      }),
};

/**
 * `key=value` pairs separated by commas, values percent-decoded, as the OTLP
 * exporters read the `OTEL_EXPORTER_OTLP_*_HEADERS` variables themselves.
 * Every pair has a value, as a header does.
 */
const otlpHeaders: Parser<Record<string, string>> = {
  rule: { kind: "headers" },
  parse: (value) => {
    const out: Record<string, string> = {};
    for (const pair of value.split(",")) {
      if (pair.trim() === "") continue;
      const eq = pair.indexOf("=");
      const key = eq > 0 ? pair.slice(0, eq).trim() : "";
      const raw = eq > 0 ? pair.slice(eq + 1).trim() : "";
      let decoded: string | undefined;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        decoded = undefined;
      }
      if (!key || !raw || decoded === undefined) {
        throw new Error(
          "must be comma-separated key=value pairs with percent-encoded values",
        );
      }
      out[key] = decoded;
    }
    return out;
  },
};

/**
 * `OTEL_RESOURCE_ATTRIBUTES`: the same pairs, in the W3C Baggage format the
 * OpenTelemetry specification names, in which a value may be empty.
 */
const resourceAttributes: Parser<Record<string, string>> = {
  rule: { kind: "headers" },
  parse: (value) => {
    const out: Record<string, string> = {};
    for (const pair of value.split(",")) {
      if (pair.trim() === "") continue;
      const eq = pair.indexOf("=");
      const key = eq > 0 ? pair.slice(0, eq).trim() : "";
      let decoded: string | undefined;
      try {
        decoded = decodeURIComponent(pair.slice(eq + 1).trim());
      } catch {
        decoded = undefined;
      }
      if (eq < 0 || !key || decoded === undefined) {
        throw new Error(
          "must be comma-separated key=value pairs with percent-encoded values",
        );
      }
      out[key] = decoded;
    }
    return out;
  },
};

/**
 * The override is JSON the type system never checks, so a missing
 * `default_on` is refused rather than defaulted: `true` would turn a
 * misspelled key into an on-by-default grant, and `false` would leave a
 * consent screen that grants nothing without saying why.
 */
const permissionBundles: Parser<PermissionBundle[]> = {
  rule: { kind: "permission-bundles" },
  parse: (value) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("must be a JSON array of permission bundles");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("must be a JSON array of permission bundles");
    }
    const rejected: string[] = [];
    parsed.forEach((entry: unknown, i: number) => {
      const b = entry as Partial<PermissionBundle> | null;
      const valid =
        typeof b === "object" &&
        b !== null &&
        typeof b.id === "string" &&
        b.id.length > 0 &&
        Array.isArray(b.scopes) &&
        b.scopes.every((s) => typeof s === "string") &&
        typeof b.default_on === "boolean";
      if (!valid) {
        const id: unknown = b?.id;
        rejected.push(
          typeof id === "string" && id.length > 0 ? id : `index ${String(i)}`,
        );
      }
    });
    if (rejected.length > 0) {
      throw new Error(
        `needs a string id, an array of scopes and a boolean default_on on every entry; offending entries: ${rejected.join(", ")}`,
      );
    }
    return parsed as PermissionBundle[];
  },
};

function fromThrowingParser<T>(
  rule: SettingRule,
  parse: (raw: string) => T,
): Parser<T> {
  return {
    rule,
    parse: (value) => {
      try {
        return parse(value);
      } catch (err) {
        // The parsers name the setting themselves; the schema names it again.
        const message = errorMessage(err);
        throw new Error(message.replace(/^[A-Z_]+:\s*/, ""), { cause: err });
      }
    },
  };
}

const optionalText = (description: string, defaultNote?: string) =>
  setting<string | undefined>(
    text,
    () => undefined,
    description,
    defaultNote === undefined ? {} : { defaultNote },
  );
const optionalUrl = (description: string, options?: SettingOptions) =>
  setting<string | undefined>(httpUrl, () => undefined, description, options);
const blankText = (description: string, options?: SettingOptions) =>
  setting(text, () => "", description, options);
const blankUrl = (description: string, options?: SettingOptions) =>
  setting(httpUrl, () => "", description, options);
const count = (
  fallback: number,
  description: string,
  {
    min = 1,
    max,
    unit,
  }: { min?: number; max?: number; unit?: SettingUnit } = {},
) => setting(wholeNumber(min, max, unit), () => fallback, description);
const on = (fallback: boolean, description: string) =>
  setting(flag, () => fallback, description);

/**
 * Every setting the server reads, by the environment variable that carries
 * it. Read once, at boot, by {@link loadConfig}; nothing else in the server
 * reads the environment. A value outside its rule stops the server with a
 * message naming the setting. `.env.example` lists every name here, and the
 * settings table in `conformance/spec/instance.md` is written from it.
 */
const settingsShape = {
  NODE_ENV: grouped(
    { group: "Development and testing", label: "Server mode" },
    setting(
      choice("production", "development", "test"),
      () => "development" as const,
      "The environment the server runs in. Production makes `API_KEY_SALT`, `MARFA_AUTH_SECRET` and `MARFA_AUTH_BASE_URL` mandatory, and the two secrets strong.",
    ),
  ),
  PORT: grouped(
    { group: "Address and network", label: "Port" },
    count(
      8600,
      "The port the server listens on. Zero lets the operating system assign a port.",
      { min: 0, max: 65_535 },
    ),
  ),
  MARFA_LISTEN_HOST: grouped(
    { group: "Address and network", label: "Listen address" },
    optionalText(
      "The IP address or hostname the public HTTP listener binds to. Unset uses the runtime's unspecified address: IPv6 when available, otherwise IPv4.",
    ),
  ),
  SQLITE_PATH: grouped(
    { group: "Where data is kept", label: "Database file" },
    setting(
      text,
      () => "./data/marfa.db",
      "The path of the database file. A value starting with `file:` is passed to the database as written, and `:memory:` opens a database held in memory.",
    ),
  ),
  MARFA_CONTROL_SOCKET: grouped(
    { group: "Address and network", label: "Private control socket" },
    setting(
      text,
      () => "",
      "Absolute private Unix socket path. Defaults to control/marfa.sock beside the database. Its directory must belong to the server account with mode 0700. Linux requires getfacl.",
    ),
  ),
  MARFA_CONTROL_ONLY: grouped(
    { group: "Development and testing", label: "Recovery mode" },
    setting(
      flag,
      () => false,
      "Start only the private control listener, without public HTTP or background jobs, for local recovery.",
    ),
  ),
  MARFA_TEST_HOOKS: grouped(
    { group: "Development and testing", label: "Test hooks" },
    on(
      false,
      "Serve the clock and fault routes a conformance harness drives on the private control socket. Never on the public listener, and refused when `NODE_ENV` is production. Leave off on every instance that holds real data.",
    ),
  ),
  MARFA_TEST_CLOCK_OFFSET_MS: grouped(
    { group: "Development and testing", label: "Test clock offset" },
    count(
      0,
      "How far ahead of the system clock the server's clock starts. Needs `MARFA_TEST_HOOKS`, so a harness that moved the clock can restart the server without the time going back.",
      { min: 0, max: MAX_CLOCK_OFFSET_MS, unit: "ms" },
    ),
  ),
  MARFA_TEST_CONTRACT_VERSION: grouped(
    { group: "Development and testing", label: "Test contract version" },
    setting<number | undefined>(
      wholeNumber(0, MAX_CONTRACT_VERSION),
      () => undefined,
      "The contract version the server speaks instead of the build's, in the root's `contract`, the `X-Marfa-Contract` header and the document's `info.version`. Needs `MARFA_TEST_HOOKS`, so a harness can show what a change of contract does to what the server kept.",
      { defaultNote: "The build's contract version" },
    ),
  ),
  MARFA_TEST_MIGRATION_FAULT: grouped(
    { group: "Development and testing", label: "Test migration fault" },
    setting<"hold" | "lose-row" | "change-shape" | undefined>(
      choice("hold", "lose-row", "change-shape"),
      () => undefined,
      "A failure the update of an earlier schema version meets before it commits: `hold` waits there until the process is stopped, `lose-row` deletes a row the update must keep, and `change-shape` adds a column this build does not declare. Needs `MARFA_TEST_HOOKS`, so a harness can show that a failed or interrupted update changes nothing.",
      { defaultNote: "None" },
    ),
  ),
  MARFA_TEST_FREE_DISK_BYTES: grouped(
    { group: "Development and testing", label: "Test free disk space" },
    setting<number | undefined>(
      wholeNumber(0, undefined, "bytes"),
      () => undefined,
      "The free space, in bytes, the update of an earlier schema version takes the database's volume to have. Needs `MARFA_TEST_HOOKS`, so a harness can show the refusal of an update there is no room for.",
      { defaultNote: "What the volume reports" },
    ),
  ),
  SQLITE_BUSY_BUDGET_MS: grouped(
    { group: "Fine tuning", label: "Database busy wait" },
    count(
      5_000,
      "How long a write that meets a locked database is retried before the server answers `503 write_contention`. At 0 the first refusal is answered.",
      { min: 0, max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  BLOB_PATH: grouped(
    { group: "Where data is kept", label: "File folder" },
    setting(
      text,
      () => "./data/blobs",
      "The folder of the disk store, where every upload lands.",
    ),
  ),
  MARFA_DISK_RESERVE_BYTES: grouped(
    { group: "File storage", label: "Free disk space to keep" },
    count(
      128 * 1024 * 1024,
      "The free space on the disk store's volume that uploads, restores, and archive exports must leave. An export's temporary files are included. A request that would take the volume below it is refused `507 insufficient_storage`. At 0 nothing is held back.",
      { min: 0, unit: "bytes" },
    ),
  ),
  MARFA_UPLOAD_IDLE_TIMEOUT_MS: grouped(
    { group: "Fine tuning", label: "Upload idle timeout" },
    count(
      DEFAULT_UPLOAD_IDLE_TIMEOUT_MS,
      "How long a restore or a blob upload may receive no bytes before the server ends it `408 request_timeout`. An upload has no other time limit while bytes keep arriving.",
      { max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  MARFA_MAX_REQUEST_BYTES: grouped(
    { group: "Limits", label: "Largest request" },
    count(
      1_048_576,
      "The largest ordinary JSON request body. A larger body is answered `413 request_too_large`. Bulk writes, connector state, client registration, blob uploads and inbound webhook deliveries have separate limits.",
      { unit: "bytes" },
    ),
  ),
  MARFA_MAX_BULK_REQUEST_BYTES: grouped(
    { group: "Limits", label: "Largest bulk request" },
    count(16 * 1024 * 1024, "The largest body the bulk operations accept.", {
      unit: "bytes",
    }),
  ),

  S3_BUCKET: grouped(
    { group: "File storage", label: "Object store bucket" },
    blankText(
      "The bucket of an S3-compatible object store. The store is attached when this is set.",
    ),
  ),
  S3_REGION: grouped(
    { group: "File storage", label: "Object store region" },
    setting(text, () => "us-east-1", "The region of the object store."),
  ),
  S3_ENDPOINT: grouped(
    { group: "File storage", label: "Object store address" },
    blankUrl(
      "The endpoint of the object store. When blank, the store's provider chooses it.",
      { secret: true },
    ),
  ),
  S3_ACCESS_KEY_ID: grouped(
    { group: "File storage", label: "Object store access key ID" },
    blankText("The access key ID for the object store.", { secret: true }),
  ),
  S3_SECRET_ACCESS_KEY: grouped(
    { group: "File storage", label: "Object store secret key" },
    secretSetting("The secret access key for the object store."),
  ),
  S3_FORCE_PATH_STYLE: grouped(
    { group: "File storage", label: "Use path-style addressing" },
    on(
      true,
      "Whether the object store is addressed by path rather than by virtual host. Read only when `S3_ENDPOINT` is set.",
    ),
  ),
  S3_PREFIX: grouped(
    { group: "File storage", label: "Object store prefix" },
    setting(
      keyPrefix,
      () => "blobs",
      "The key prefix the instance keeps everything in the bucket under: its blobs and, in the image, its database replica under `db/`. Each instance on a bucket needs its own. A `/` at either end is dropped; a `.` or `..` segment is refused.",
    ),
  ),
  MARFA_BLOB_MIN_COPIES: grouped(
    { group: "File storage", label: "Minimum file copies" },
    count(
      1,
      "The fewest live copies a blob keeps. A drop that would leave fewer is refused.",
    ),
  ),
  MARFA_BLOB_READ_IDLE_TIMEOUT_MS: grouped(
    { group: "Fine tuning", label: "File read idle timeout" },
    count(
      DEFAULT_BLOB_READ_IDLE_TIMEOUT_MS,
      "How long a blob read may make no progress before its stream and file or socket are closed. Slow consumers must read within this interval.",
      { max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  MARFA_BLOB_REPLICATE_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Copy files every" },
    count(
      60_000,
      "How often the `blob-replicate` job gives every attached store its copies. The job has no off switch.",
      { max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_BLOB_REPLICATE_BATCH: grouped(
    { group: "Fine tuning", label: "Files per copy run" },
    count(100, "The most blobs one replication run copies."),
  ),
  MARFA_BLOB_REPLICATE_BATCH_BYTES: grouped(
    { group: "Fine tuning", label: "Bytes per copy run" },
    count(1024 * 1024 * 1024, "The most bytes one replication run copies.", {
      unit: "bytes",
    }),
  ),
  MARFA_BLOB_INTEGRITY_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Check file copies every" },
    count(
      3_600_000,
      "How often the `blob-integrity` job checks the copies it holds. The job has no off switch.",
      { max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_BLOB_INTEGRITY_BATCH: grouped(
    { group: "Fine tuning", label: "Copies per check run" },
    count(500, "The most copies one integrity run checks."),
  ),
  MARFA_BLOB_INTEGRITY_BATCH_BYTES: grouped(
    { group: "Fine tuning", label: "Bytes per check run" },
    count(1024 * 1024 * 1024, "The most bytes one integrity run checks.", {
      unit: "bytes",
    }),
  ),
  MARFA_BLOB_CLEANUP_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Look for orphan files every" },
    count(
      86_400_000,
      "How often the `blob-orphans` job sweeps for unreferenced blobs. At 0 the sweep is off.",
      { min: 0, max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_BLOB_CLEANUP_GRACE_MS: grouped(
    { group: "Keeping things", label: "Keep orphan files for" },
    count(
      86_400_000,
      "How long an unreferenced blob stands in the orphan report before a later run purges it. At 0 the next run purges it.",
      { min: 0, max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),

  MARFA_ENRICHMENT_ENABLED: grouped(
    {
      group: "Text from files",
      label: "Read text in documents",
      live: "enrichment_enabled",
    },
    on(true, "Whether the server extracts text from uploaded files."),
  ),
  MARFA_ENRICHMENT_OCR_ENABLED: grouped(
    {
      group: "Text from files",
      label: "Read text in images",
      live: "enrichment_ocr_enabled",
    },
    on(
      true,
      "Whether the server reads text from images with OCR. When off, images are recorded as unsupported.",
    ),
  ),
  MARFA_ENRICHMENT_TESSDATA_DIR: grouped(
    { group: "Text from files", label: "Image reader data folder" },
    optionalText(
      "The folder where the OCR language model is cached. When unset, it is a `tessdata` folder beside the database file.",
    ),
  ),
  MARFA_ENRICHMENT_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Read text every" },
    count(30_000, "How often the enrichment sweep runs.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  MARFA_ENRICHMENT_BATCH_SIZE: grouped(
    { group: "Fine tuning", label: "Files per text run" },
    count(8, "The most items one enrichment sweep extracts."),
  ),
  MARFA_ENRICHMENT_ITEM_TIMEOUT_MS: grouped(
    { group: "Fine tuning", label: "Time allowed per file" },
    count(60_000, "How long the extraction of one item may take.", {
      max: MAX_TIMER_DELAY_MS,
      unit: "ms",
    }),
  ),
  MARFA_ENRICHMENT_MAX_BLOB_BYTES: grouped(
    { group: "Text from files", label: "Largest file to read" },
    count(
      20 * 1024 * 1024,
      "The largest blob the server extracts text from. A larger blob is skipped unread.",
      { unit: "bytes" },
    ),
  ),
  // The validator's cap, not restated: above it, the sweeper's validation
  // parks an over-long extraction rather than storing it.
  MARFA_ENRICHMENT_MAX_TEXT_CHARS: grouped(
    { group: "Text from files", label: "Most text to keep" },
    count(
      DEFAULT_MAX_STRING_LENGTH,
      "The most UTF-16 code units of extracted text the server keeps. Longer text is cut short, never through a character.",
    ),
  ),
  MARFA_ENRICHMENT_MAX_INFLATED_BYTES: grouped(
    { group: "Text from files", label: "Largest unpacked document" },
    count(
      64 * 1024 * 1024,
      "The most a document may inflate to when the server extracts its text, all of its parts together. A document that inflates past it is skipped.",
      { unit: "bytes" },
    ),
  ),
  MARFA_ENRICHMENT_MAX_MEMORY_BYTES: grouped(
    { group: "Text from files", label: "Memory for reading a document" },
    count(
      256 * 1024 * 1024,
      "The most the JavaScript heap of the process that reads one document's text may take. That process also holds the document and what it inflates to, outside the heap, so allow this and the two limits above together. A document that needs more is skipped.",
      { unit: "bytes" },
    ),
  ),
  MARFA_ENRICHMENT_MAX_ATTEMPTS: grouped(
    { group: "Text from files", label: "Attempts per file" },
    count(
      3,
      "How many times the server tries to extract text from a failing item before it stops.",
    ),
  ),

  TRUSTED_PROXY_CIDRS: grouped(
    { group: "Address and network", label: "Trusted proxy ranges" },
    setting<CidrRange[]>(
      fromThrowingParser({ kind: "cidrs" }, parseTrustedProxyCidrs),
      () => [],
      "The address ranges of the proxies whose `X-Forwarded-For` header the server believes. When empty, the header is ignored.",
    ),
  ),
  TRUSTED_PROXY_HEADER: grouped(
    { group: "Address and network", label: "Trusted client address header" },
    setting<string | null>(
      fromThrowingParser({ kind: "header-name" }, parseTrustedProxyHeader),
      () => null,
      "The name of a header that the platform's edge overwrites with the client address. It takes precedence over `TRUSTED_PROXY_CIDRS`.",
    ),
  ),

  API_KEY_SALT: grouped(
    { group: "Sign-in and access", label: "API key salt" },
    secretSetting(
      "The salt for hashing API keys and app tokens. Changing it invalidates every existing key and token. Outside production, an unset salt falls back to a built-in one.",
      "None. Required in production.",
    ),
  ),
  MARFA_AUTH_SECRET: grouped(
    { group: "Sign-in and access", label: "Sign-in secret" },
    secretSetting(
      "The secret that signs sign-in cookies, authorize queries, reach proofs and credential-free blob links. It must be at least 32 characters. Outside production, an unset secret falls back to a random one for each process.",
      "None. Required in production.",
      SECRET_MIN_LENGTH,
    ),
  ),
  MARFA_AUTH_BASE_URL: grouped(
    { group: "Address and network", label: "Public address" },
    setting<string | undefined>(
      publicUrl,
      () => undefined,
      "The public URL for OAuth, cookies, and links. It has no user name, password or query string. Outside production, an unset URL uses the assigned port with `http://127.0.0.1` when `MARFA_LISTEN_HOST` is `127.0.0.1`, otherwise `http://localhost`.",
      { defaultNote: "None. Required in production." },
    ),
  ),
  CORS_ORIGINS: grouped(
    { group: "Address and network", label: "Allowed websites" },
    setting(
      origins,
      () => [],
      "The browser origins allowed to call the API across origins, beside the web pages the owner approves, and trusted by the sign-in forms. Each is an exact scheme and host with no trailing slash.",
    ),
  ),
  MARFA_PERMISSION_BUNDLES: grouped(
    { group: "Sign-in and access", label: "Approve access groups" },
    setting<PermissionBundle[] | undefined>(
      permissionBundles,
      () => undefined,
      "The permission bundles the consent screen offers, replacing the built-in ones. Each entry has a string `id`, an array of `scopes` and a boolean `default_on`.",
      { secret: true },
    ),
  ),
  ENABLE_HSTS: grouped(
    { group: "Address and network", label: "Require secure connections" },
    on(
      false,
      "Whether the server sends the `Strict-Transport-Security` header.",
    ),
  ),

  RATE_LIMIT_ENABLED: grouped(
    { group: "Limits", label: "Rate limiting" },
    on(true, "Whether the rate limiter is on."),
  ),
  RATE_LIMIT_REQUESTS: grouped(
    { group: "Limits", label: "Requests per window" },
    count(
      1000,
      "The requests one credential may make to one group of operations in each window. A `GET` may make twice as many, except in a group that another setting caps.",
    ),
  ),
  RATE_LIMIT_WINDOW_MS: grouped(
    { group: "Limits", label: "Rate limit window" },
    count(60_000, "The length of a rate-limit window.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  RATE_LIMIT_KEYS_REQUESTS: grouped(
    { group: "Limits", label: "Key requests per window" },
    count(
      DEFAULT_KEYS_RATE_LIMIT,
      "The requests one credential may make in each window to the operations under `/keys`.",
    ),
  ),
  RATE_LIMIT_AGGREGATE_MULTIPLIER: grouped(
    { group: "Limits", label: "Overall request multiplier" },
    count(
      4,
      "The multiplier of `RATE_LIMIT_REQUESTS` that caps a credential across every operation in a window. At 0 there is no such cap.",
      { min: 0 },
    ),
  ),
  MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Clear rate limit records every" },
    count(
      3_600_000,
      "How often the `rate-limit-cleanup` job drops expired rate-limit windows.",
      { max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),

  MARFA_CONNECTOR_HOLD_MS: grouped(
    { group: "Connectors and webhooks", label: "Connector hold time" },
    count(
      DEFAULT_CONNECTOR_HOLD_MS,
      "How long a connector's hold on its registration lasts after its last take or renewal.",
      { min: 1_000, max: 3_600_000, unit: "ms" },
    ),
  ),
  MARFA_INBOUND_MAX_BYTES: grouped(
    { group: "Connectors and webhooks", label: "Largest incoming webhook" },
    count(
      DEFAULT_INBOUND_LIMITS.maxBytes,
      "The largest inbound webhook delivery the server stores.",
      { unit: "bytes" },
    ),
  ),
  RATE_LIMIT_INBOUND_REQUESTS: grouped(
    { group: "Limits", label: "Incoming webhooks per window" },
    count(
      DEFAULT_INBOUND_LIMITS.requestsPerWindow,
      "The deliveries one inbound endpoint accepts in each rate-limit window.",
    ),
  ),
  MARFA_INBOUND_BACKLOG_DELIVERIES: grouped(
    {
      group: "Connectors and webhooks",
      label: "Waiting webhooks per connector",
    },
    count(
      DEFAULT_INBOUND_LIMITS.backlogDeliveries,
      "The unhandled deliveries one registration may hold before the server refuses more deliveries for it.",
    ),
  ),
  MARFA_INBOUND_BACKLOG_BYTES: grouped(
    {
      group: "Connectors and webhooks",
      label: "Waiting webhook size per connector",
    },
    count(
      DEFAULT_INBOUND_LIMITS.backlogBytes,
      "The bytes of unhandled deliveries one registration may hold before the server refuses more deliveries for it.",
      { unit: "bytes" },
    ),
  ),
  MARFA_INBOUND_RETAINED_DELIVERIES: grouped(
    { group: "Connectors and webhooks", label: "Webhooks kept in total" },
    count(
      DEFAULT_INBOUND_LIMITS.retainedDeliveries,
      "The most deliveries the server retains across live and retired endpoints.",
    ),
  ),
  MARFA_INBOUND_RETAINED_BYTES: grouped(
    { group: "Connectors and webhooks", label: "Webhook storage in total" },
    count(
      DEFAULT_INBOUND_LIMITS.retainedBytes,
      "The most bytes of deliveries the server retains across live and retired endpoints.",
      { unit: "bytes" },
    ),
  ),
  MARFA_INBOUND_CLEANUP_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Clean up webhooks every" },
    count(
      DEFAULT_INBOUND_LIMITS.cleanupIntervalMs,
      "How often the `inbound-delivery-cleanup` job runs.",
      { max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_INBOUND_IN_FLIGHT_BYTES: grouped(
    { group: "Connectors and webhooks", label: "Webhook memory limit" },
    count(
      DEFAULT_INBOUND_LIMITS.inFlightBytes,
      "The most bytes of inbound webhook deliveries the server holds in memory at once.",
      { unit: "bytes" },
    ),
  ),
  MARFA_INBOUND_READ_TIMEOUT_MS: grouped(
    { group: "Fine tuning", label: "Webhook body timeout" },
    count(
      DEFAULT_INBOUND_LIMITS.readTimeoutMs,
      "How long a delivery's body has to arrive whole.",
      { max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  MARFA_INBOUND_HANDLED_RETENTION_DAYS: grouped(
    {
      group: "Keeping things",
      label: "Keep handled webhooks",
      live: "inbound_handled_retention_days",
    },
    count(
      DEFAULT_INBOUND_LIMITS.handledRetentionDays,
      "How long the server keeps a handled delivery. `PUT /config` overrides it. At 0 age does not expire a delivery.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  MARFA_INBOUND_PENDING_RETENTION_DAYS: grouped(
    {
      group: "Keeping things",
      label: "Keep waiting webhooks",
      live: "inbound_pending_retention_days",
    },
    count(
      DEFAULT_INBOUND_LIMITS.pendingRetentionDays,
      "How long the server keeps an unhandled delivery. `PUT /config` overrides it. At 0 age does not expire a delivery.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),

  MARFA_HOUSEKEEPING_POLL_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Check for due jobs every" },
    count(
      1_000,
      "How often the housekeeping scheduler asks its table which jobs are due.",
      { max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  AUDIT_RETENTION_DAYS: grouped(
    {
      group: "Keeping things",
      label: "Keep activity",
      live: "audit_retention_days",
    },
    count(
      90,
      "How long the server keeps audit entries and webhook delivery history. At 0 no entry expires by age. `PUT /config` overrides it.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  AUDIT_CLEANUP_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Clean up the audit log every" },
    count(86_400_000, "How often the `audit-cleanup` job runs.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  MARFA_REVOKED_GRANT_RETENTION_DAYS: grouped(
    { group: "Keeping things", label: "Keep records of disconnected apps" },
    count(
      90,
      "How long a revoked application grant is kept. At 0 the job that purges them is off. `PUT /config` does not override it.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  MARFA_GRANT_INACTIVITY_DAYS: grouped(
    {
      group: "Sign-in and access",
      label: "Disconnect apps left unused",
      live: "grant_inactivity_days",
    },
    count(
      365,
      "How long an application grant may go unused before the server retires it. At 0 grants are never retired. `/config` overrides it.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  MARFA_EVENT_LOG_RETENTION_HOURS: grouped(
    {
      group: "Keeping things",
      label: "Let apps catch up on changes",
      live: "event_log_retention_hours",
    },
    count(
      DEFAULT_EVENT_LOG_RETENTION_HOURS,
      "The least time an event stays in the event log, which bounds how far back a stream can replay. At 0 no event expires by age. `PUT /config` overrides it.",
      { min: 0, max: MAX_RETENTION_HOURS, unit: "hours" },
    ),
  ),
  MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Clean up the event log every" },
    count(3_600_000, "How often the `event-log-cleanup` job runs.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  VERSION_THINNING_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Thin old versions every" },
    count(3_600_000, "How often the `version-thinning` job runs.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  FEED_EXPIRY_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Expire feed items every" },
    count(3_600_000, "How often the `feed-expiry` job runs.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  VERSION_RECENT_DAYS: grouped(
    {
      group: "Keeping things",
      label: "Keep every version of an item",
      live: "version_recent_days",
    },
    count(
      30,
      "The window in which the version policy keeps every version of an item.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  VERSION_DAILY_SNAPSHOT_DAYS: grouped(
    {
      group: "Keeping things",
      label: "Keep daily versions for",
      live: "version_daily_snapshot_days",
    },
    count(
      90,
      "The window in which the version policy keeps one version a day. It must be at least `VERSION_RECENT_DAYS`.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  VERSION_WEEKLY_SNAPSHOT_DAYS: grouped(
    {
      group: "Keeping things",
      label: "Keep weekly versions for",
      live: "version_weekly_snapshot_days",
    },
    count(
      365,
      "The window in which the version policy keeps one version a week. It must be at least `VERSION_DAILY_SNAPSHOT_DAYS`.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  VERSION_MAX_VERSIONS: grouped(
    {
      group: "Keeping things",
      label: "Most versions per item",
      live: "version_max_versions",
    },
    count(500, "The most versions the version policy keeps for one item."),
  ),
  TRASH_RETENTION_DAYS: grouped(
    {
      group: "Keeping things",
      label: "Keep items in the trash",
      live: "trash_retention_days",
    },
    count(
      60,
      "How long an item stays in the trash before the server deletes it. At 0 nothing in the trash expires by age. `PUT /config` overrides it.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  TRASH_PURGE_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Empty the trash every" },
    count(86_400_000, "How often the `trash-purge` job runs.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  AUTH_SESSION_CLEANUP_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Clear old sign-ins every" },
    count(
      3_600_000,
      "How often the `auth-session-cleanup` job drops expired sign-in sessions.",
      { max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_DCR_CLIENT_RETENTION_DAYS: grouped(
    { group: "Keeping things", label: "Keep unused app registrations" },
    count(
      1,
      "How long a dynamically registered client with no grants is kept, counted from its registration or the last time an approval page offered it. At 0 the job that removes them is off.",
      { min: 0, max: MAX_RETENTION_DAYS, unit: "days" },
    ),
  ),
  MARFA_DCR_CLIENT_CLEANUP_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Clear app registrations every" },
    count(
      3_600_000,
      "How often the job that removes dynamically registered clients with no grants runs.",
      { max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_BULK_ACTION_JOB_RETENTION_MS: grouped(
    { group: "Keeping things", label: "Keep finished bulk jobs" },
    count(
      7 * 24 * 3_600_000,
      "How long a finished bulk-action job is kept. At 0 the sweep that removes them is off.",
      { min: 0, max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_BULK_ACTION_JOB_GC_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Clear finished bulk jobs every" },
    count(
      3_600_000,
      "How often the sweep that removes finished bulk-action jobs runs.",
      { max: MAX_RETENTION_MS, unit: "ms" },
    ),
  ),
  MARFA_BULK_ACTION_POLL_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Bulk job check interval" },
    count(
      500,
      "The base interval at which the bulk-action worker looks for work.",
      { max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Longest bulk job wait" },
    count(
      60_000,
      "The longest the bulk-action worker waits between looks for work when it is idle. It must be at least `MARFA_BULK_ACTION_POLL_INTERVAL_MS`.",
      { max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  MARFA_BULK_ACTION_POLL_BACKOFF_MULTIPLIER: grouped(
    { group: "Fine tuning", label: "Bulk job wait growth" },
    setting(
      decimal(1, 100),
      () => 2,
      "The factor by which the bulk-action worker's wait grows after each look that finds no work.",
    ),
  ),
  MARFA_SSE_MAX_VIEWERS: grouped(
    { group: "Limits", label: "Most live viewers" },
    count(
      0,
      "The most event-stream viewers one server instance serves at once. At 0 there is no limit.",
      { min: 0 },
    ),
  ),

  MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES: grouped(
    {
      group: "Connectors and webhooks",
      label: "Allow private webhook targets",
    },
    on(
      false,
      "Whether outbound webhooks may reach loopback, private and other non-public addresses.",
    ),
  ),
  MARFA_MCP_FETCH_ENABLED: grouped(
    { group: "Connectors and webhooks", label: "Let agents fetch files" },
    on(
      true,
      "Whether MCP tools fetch a file from a web address, or a file a chat attached, to save it. When off, a tool asked to fetch one is refused.",
    ),
  ),
  MARFA_MCP_FETCH_MAX_BYTES: grouped(
    { group: "Limits", label: "Largest file an agent fetches" },
    count(
      50 * 1024 * 1024,
      "The largest file an MCP tool fetches from a web address to save. A larger file is refused and nothing is stored.",
      { unit: "bytes" },
    ),
  ),
  MARFA_MCP_FETCH_TIMEOUT_MS: grouped(
    { group: "Limits", label: "Time an agent's fetch may take" },
    count(
      60_000,
      "How long an MCP tool's fetch of a file from a web address may take, from connecting to the last byte.",
      { max: MAX_TIMER_DELAY_MS, unit: "ms" },
    ),
  ),
  MARFA_ERROR_REPORTING_ENABLED: grouped(
    {
      group: "Alerts and monitoring",
      label: "Send error reports",
      live: "error_reporting_enabled",
    },
    on(
      true,
      "Send error alerts and exception reports to configured receivers. `/config` overrides it; receiver addresses and credentials stay machine settings.",
    ),
  ),
  MARFA_HEARTBEAT_ENABLED: grouped(
    {
      group: "Alerts and monitoring",
      label: "Send a heartbeat",
      live: "heartbeat_enabled",
    },
    on(
      true,
      "Send scheduled requests to the configured heartbeat receiver. `/config` overrides it; its address stays a machine setting.",
    ),
  ),
  ERROR_WEBHOOK_URL: grouped(
    { group: "Alerts and monitoring", label: "Error alert address" },
    blankUrl(
      "The URL the server posts a notice to when a request fails with a 500 error. When blank, no notice is sent.",
      { secret: true },
    ),
  ),
  MARFA_ERROR_WEBHOOK_TIMEOUT_MS: grouped(
    { group: "Fine tuning", label: "Error alert timeout" },
    count(5_000, "How long one post to `ERROR_WEBHOOK_URL` may take.", {
      max: MAX_TIMER_DELAY_MS,
      unit: "ms",
    }),
  ),
  MARFA_HEARTBEAT_URL: grouped(
    { group: "Alerts and monitoring", label: "Heartbeat address" },
    blankUrl(
      "The URL the server requests on a schedule, so that something else can notice when the requests stop. When blank, there is no heartbeat.",
      { secret: true },
    ),
  ),
  MARFA_HEARTBEAT_INTERVAL_MS: grouped(
    { group: "Fine tuning", label: "Heartbeat interval" },
    count(60_000, "How often the server requests `MARFA_HEARTBEAT_URL`.", {
      max: MAX_RETENTION_MS,
      unit: "ms",
    }),
  ),
  MARFA_PLACEMENT_REGION: grouped(
    { group: "Alerts and monitoring", label: "Server region" },
    optionalText(
      "Free text naming the region the server runs in, reported at `/health` as `placement.region`.",
    ),
  ),
  MARFA_PLACEMENT_LOCATION: grouped(
    { group: "Alerts and monitoring", label: "Server location" },
    optionalText(
      "Free text naming the location the server runs in, reported at `/health` as `placement.location`.",
    ),
  ),
  MARFA_PLACEMENT_COUNTRY: grouped(
    { group: "Alerts and monitoring", label: "Server country" },
    optionalText(
      "Free text naming the country the server runs in, reported at `/health` as `placement.country`.",
    ),
  ),

  MARFA_OTEL_SAMPLE_RATIO: grouped(
    { group: "Alerts and monitoring", label: "Share of traces sent" },
    setting(
      decimal(0, 1),
      () => 0.05,
      "The share of traces exported. A trace that contains an error is exported whatever this says: the span that failed, the spans held for the trace (at most 500) and every span after it.",
    ),
  ),
  OTEL_SDK_DISABLED: grouped(
    { group: "Alerts and monitoring", label: "Telemetry switch" },
    setting(
      disabledSwitch,
      () => false,
      "Setting this to `true` turns off traces, logs and exception reports together, whatever the other telemetry settings say. Any other value leaves them as they are.",
    ),
  ),
  OTEL_SERVICE_NAME: grouped(
    { group: "Alerts and monitoring", label: "Telemetry service name" },
    optionalText(
      "The service name on exported telemetry. It takes precedence over a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`.",
      "`marfa-server`",
    ),
  ),
  OTEL_RESOURCE_ATTRIBUTES: grouped(
    { group: "Alerts and monitoring", label: "Telemetry resource attributes" },
    setting<Record<string, string>>(
      resourceAttributes,
      () => ({}),
      "Attributes added to everything exported, as OpenTelemetry defines them. One named here replaces the server's own of the same name, such as `deployment.environment`, which an error notification names too.",
    ),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: grouped(
    { group: "Alerts and monitoring", label: "Telemetry address" },
    optionalUrl(
      "The base URL of the OTLP receiver. Setting it turns traces and logs on: the server exports traces to `v1/traces` and logs to `v1/logs` under it. Unset, no trace or log is exported; exception reports have settings of their own (`MARFA_POSTHOG_HOST`).",
      { secret: true },
    ),
  ),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: grouped(
    { group: "Alerts and monitoring", label: "Trace address" },
    optionalUrl(
      "The URL traces post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.",
      { secret: true },
    ),
  ),
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: grouped(
    { group: "Alerts and monitoring", label: "Log address" },
    optionalUrl(
      "The URL logs post to, used as written. It takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`, which must also be set.",
      { secret: true },
    ),
  ),
  OTEL_EXPORTER_OTLP_HEADERS: grouped(
    { group: "Alerts and monitoring", label: "Telemetry headers" },
    setting(
      otlpHeaders,
      () => ({}),
      "The headers sent with every OTLP export, as `key=value` pairs.",
      { secret: true },
    ),
  ),
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: grouped(
    { group: "Alerts and monitoring", label: "Trace headers" },
    setting(
      otlpHeaders,
      () => ({}),
      "The headers sent with trace exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.",
      { secret: true },
    ),
  ),
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: grouped(
    { group: "Alerts and monitoring", label: "Log headers" },
    setting(
      otlpHeaders,
      () => ({}),
      "The headers sent with log exports, as `key=value` pairs. They override `OTEL_EXPORTER_OTLP_HEADERS`.",
      { secret: true },
    ),
  ),
  MARFA_POSTHOG_HOST: grouped(
    { group: "Alerts and monitoring", label: "PostHog address" },
    setting<string | undefined>(
      anyAddress,
      () => undefined,
      "The PostHog host that receives exception reports, which OTLP cannot carry into error tracking. With `MARFA_POSTHOG_PROJECT_TOKEN` it turns exception reports on; no OTLP setting is needed. It must be an `https` address, or an `http` address on this machine, with no user name or password; any other value turns off exception reports alone and the boot log says so.",
      { secret: true },
    ),
  ),
  MARFA_POSTHOG_PROJECT_TOKEN: grouped(
    { group: "Alerts and monitoring", label: "PostHog project token" },
    secretSetting(
      "The PostHog project token for exception reports. It needs `MARFA_POSTHOG_HOST` set too; no OTLP setting is needed.",
    ),
  ),
};

/** Every setting's name, in the order the schema states them. */
export const SETTING_NAMES: readonly string[] = Object.keys(settingsShape);

/**
 * Every setting as the settings table states it: its rule, its default and
 * what it controls, in the order the schema states them.
 */
export function describeSettings(): SettingDescription[] {
  return Object.entries(settingsShape).map(([name, schema]) => {
    const meta = SETTING_META.get(schema);
    if (meta === undefined) {
      throw new Error(`${name} has no rule or description`);
    }
    const { group, label, ...rest } = meta;
    if (group === undefined || label === undefined) {
      throw new Error(`${name} has no group or label`);
    }
    return { name, ...rest, group, label };
  });
}

/** Never echoed into a refusal, which lands in a log. */
const SECRET_SETTINGS = new Set(
  describeSettings()
    .filter((described) => described.secret)
    .map((described) => described.name),
);

const SECRET_MIN_BITS = 96;

/**
 * Text from `.env.example` and the built-in salt, compared with case and
 * punctuation stripped so `change_me` and `CHANGE ME` are caught too.
 */
const PLACEHOLDER_FRAGMENTS = ["changeme", "changeinproduction", "opensslrand"];

/**
 * Bits by the empirical character distribution, which is an upper bound on
 * a secret's real entropy: it catches a value drawn from too few
 * characters, and `openssl rand -hex 32` scores about 250. A value that
 * repeats one shorter run is caught apart from it.
 */
function estimatedBits(secret: string): number {
  const counts = new Map<string, number>();
  for (const ch of secret) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let perChar = 0;
  for (const n of counts.values()) {
    const p = n / secret.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * secret.length;
}

function weakSecret(secret: string | undefined): string | undefined {
  if (secret === undefined) return "must be set in production";
  if (secret.length < SECRET_MIN_LENGTH) {
    return `must be at least ${String(SECRET_MIN_LENGTH)} characters`;
  }
  const letters = secret.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (PLACEHOLDER_FRAGMENTS.some((fragment) => letters.includes(fragment))) {
    return "is a placeholder anyone can read, not a secret";
  }
  if (estimatedBits(secret) < SECRET_MIN_BITS || /^(.+?)\1+$/.test(secret)) {
    return "is too predictable to be a secret";
  }
  return undefined;
}

const settingsSchema = z.object(settingsShape).superRefine((s, ctx) => {
  const refuse = (name: string, message: string) => {
    ctx.addIssue({ code: "custom", path: [name], message });
  };
  const generate = "; generate one with `openssl rand -hex 32`";
  if (s.NODE_ENV === "production") {
    // MARFA_AUTH_SECRET signs Better Auth's cookies and authorize query and
    // keys the credential-free blob link, so a readable one lets anyone
    // forge a link to any blob whose hash they know.
    const salt = weakSecret(s.API_KEY_SALT);
    if (salt) refuse("API_KEY_SALT", salt + generate);
    const secret = weakSecret(s.MARFA_AUTH_SECRET);
    if (secret) refuse("MARFA_AUTH_SECRET", secret + generate);
    // Unset, the issuer, cookie domain and every minted link would name
    // localhost.
    if (s.MARFA_AUTH_BASE_URL === undefined) {
      refuse(
        "MARFA_AUTH_BASE_URL",
        "must be set in production to the public URL clients reach this server at",
      );
    }
  }
  if (s.MARFA_TEST_HOOKS && s.NODE_ENV === "production") {
    refuse(
      "MARFA_TEST_HOOKS",
      "must not be true in production: the test hooks can move the server's clock, pause work, and inject failures",
    );
  }
  if (s.MARFA_TEST_CLOCK_OFFSET_MS > 0 && !s.MARFA_TEST_HOOKS) {
    refuse("MARFA_TEST_CLOCK_OFFSET_MS", "needs MARFA_TEST_HOOKS to be true");
  }
  if (s.MARFA_TEST_CONTRACT_VERSION !== undefined && !s.MARFA_TEST_HOOKS) {
    refuse("MARFA_TEST_CONTRACT_VERSION", "needs MARFA_TEST_HOOKS to be true");
  }
  if (s.MARFA_TEST_MIGRATION_FAULT !== undefined && !s.MARFA_TEST_HOOKS) {
    refuse("MARFA_TEST_MIGRATION_FAULT", "needs MARFA_TEST_HOOKS to be true");
  }
  if (s.MARFA_TEST_FREE_DISK_BYTES !== undefined && !s.MARFA_TEST_HOOKS) {
    refuse("MARFA_TEST_FREE_DISK_BYTES", "needs MARFA_TEST_HOOKS to be true");
  }
  // Windows are tested in order, so one shorter than the window before it
  // is swallowed by that window: the setting would silently do nothing.
  if (s.VERSION_DAILY_SNAPSHOT_DAYS < s.VERSION_RECENT_DAYS) {
    refuse(
      "VERSION_DAILY_SNAPSHOT_DAYS",
      "must be at least VERSION_RECENT_DAYS",
    );
  }
  if (s.VERSION_WEEKLY_SNAPSHOT_DAYS < s.VERSION_DAILY_SNAPSHOT_DAYS) {
    refuse(
      "VERSION_WEEKLY_SNAPSHOT_DAYS",
      "must be at least VERSION_DAILY_SNAPSHOT_DAYS",
    );
  }
  if (
    s.MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS <
    s.MARFA_BULK_ACTION_POLL_INTERVAL_MS
  ) {
    refuse(
      "MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS",
      "must be at least MARFA_BULK_ACTION_POLL_INTERVAL_MS",
    );
  }
  // Traces and logs are on when the general endpoint is set, so a setting
  // that only refines it has nothing to act on without it.
  if (s.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    for (const name of [
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    ] as const) {
      if (s[name] !== undefined) {
        refuse(name, "needs OTEL_EXPORTER_OTLP_ENDPOINT set too");
      }
    }
  }
  // With one alone no exception could be reported.
  if (s.MARFA_POSTHOG_HOST !== undefined && !s.MARFA_POSTHOG_PROJECT_TOKEN) {
    refuse("MARFA_POSTHOG_HOST", "needs MARFA_POSTHOG_PROJECT_TOKEN set too");
  }
  if (s.MARFA_POSTHOG_PROJECT_TOKEN !== undefined && !s.MARFA_POSTHOG_HOST) {
    refuse("MARFA_POSTHOG_PROJECT_TOKEN", "needs MARFA_POSTHOG_HOST set too");
  }
});

/** Edits (insert, delete, substitute) between two names. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * An unknown `MARFA_*` name close to a setting's, which is most likely that
 * setting misspelled and so silently left at its default. Warned rather
 * than refused: test, client and device variables share the prefix.
 */
function misspelledSettings(env: Record<string, string | undefined>): string[] {
  const known = new Set(SETTING_NAMES);
  const warnings: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("MARFA_") || known.has(name)) continue;
    const near = SETTING_NAMES.find(
      (setting) => editDistance(name, setting) <= 2,
    );
    if (near !== undefined) {
      warnings.push(
        `${name} is not a setting and is ignored; did you mean ${near}?`,
      );
    }
  }
  return warnings;
}

/** A boot refused over its settings. The message names every bad one. */
export class SettingsError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `The server cannot start; fix these settings:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
    this.name = "SettingsError";
  }
}

/**
 * The general endpoint is a base: each signal posts to its own path under
 * it, as the OTLP exporters resolve it themselves. A signal's own endpoint
 * is used as written.
 */
function otlpSignalUrl(
  specific: string | undefined,
  general: string,
  path: "v1/traces" | "v1/logs",
): string {
  if (specific !== undefined) return specific;
  return `${general.endsWith("/") ? general : `${general}/`}${path}`;
}

/** The first value that says something: not unset and not empty. */
function firstNamed(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

/**
 * What `OTEL_RESOURCE_ATTRIBUTES` names, less `service.name`, which is the
 * service name, and less an empty value for the environment, which names
 * none and leaves the default standing.
 */
function namedAttributes(
  attributes: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([name, value]) =>
        name !== "service.name" &&
        !(
          value === "" &&
          (name === "deployment.environment" ||
            name === "deployment.environment.name")
        ),
    ),
  );
}

function telemetryIdentity(
  s: z.output<typeof settingsSchema>,
): TelemetryIdentity {
  return {
    serviceName:
      firstNamed(
        s.OTEL_SERVICE_NAME,
        s.OTEL_RESOURCE_ATTRIBUTES["service.name"],
      ) ?? "marfa-server",
    resourceAttributes: namedAttributes(s.OTEL_RESOURCE_ATTRIBUTES),
  };
}

/** Traces and logs are on exactly when the general endpoint is set and the SDK is not disabled. */
function otelSettings(
  s: z.output<typeof settingsSchema>,
): OtelSettings | undefined {
  const general = s.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (general === undefined || s.OTEL_SDK_DISABLED) return undefined;
  return {
    ...telemetryIdentity(s),
    tracesEndpoint: otlpSignalUrl(
      s.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      general,
      "v1/traces",
    ),
    logsEndpoint: otlpSignalUrl(
      s.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      general,
      "v1/logs",
    ),
    tracesHeaders: {
      ...s.OTEL_EXPORTER_OTLP_HEADERS,
      ...s.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
    },
    logsHeaders: {
      ...s.OTEL_EXPORTER_OTLP_HEADERS,
      ...s.OTEL_EXPORTER_OTLP_LOGS_HEADERS,
    },
    sampleRatio: s.MARFA_OTEL_SAMPLE_RATIO,
  };
}

/**
 * A PostHog host the project token may travel to, the rule the command line
 * applies (`telemetry/posthog.rs`): `https`, or `http` to this machine, with
 * no user name or password.
 */
function usablePosthogHost(host: string): boolean {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hostname === "") {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(\.\d{1,3}){3}$/.test(url.hostname))
  );
}

const UNUSABLE_POSTHOG_HOST =
  "MARFA_POSTHOG_HOST is not an https address, or an http address on this machine, without a user name or password, so exception reports are off";

/** Exception reports are on when both PostHog settings are usable, whatever OTLP says. */
function exceptionSettings(
  s: z.output<typeof settingsSchema>,
): ExceptionSettings | undefined {
  const host = s.MARFA_POSTHOG_HOST;
  const token = s.MARFA_POSTHOG_PROJECT_TOKEN;
  if (host === undefined || !token || s.OTEL_SDK_DISABLED) return undefined;
  if (!usablePosthogHost(host)) return undefined;
  return { ...telemetryIdentity(s), posthogHost: host, posthogToken: token };
}

/**
 * `version.json` is written into the image at build time and absent in
 * development. Read with the settings, once, because the root document,
 * `/health` and telemetry all report it.
 */
function readVersionFile(): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), "version.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsError(["version.json is not valid JSON"]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SettingsError(["version.json must hold a JSON object"]);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The release `version.json` names, if it names one. A value that is not
 * `major.minor.patch` stops the boot rather than being reported, because the
 * root document would otherwise tell a client a release that no tag carries.
 */
function releaseOf(
  file: Record<string, unknown> | undefined,
): string | undefined {
  if (file === undefined || !("release" in file)) return undefined;
  const release = file.release;
  if (
    typeof release !== "string" ||
    !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/.test(release)
  ) {
    throw new SettingsError([
      "version.json release must be a version of the form major.minor.patch",
    ]);
  }
  return release;
}

/**
 * Read every setting from `env` through the schema. Throws a
 * {@link SettingsError} naming each setting whose value breaks its rule.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = settingsSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = String(issue.path[0] ?? "settings");
      const raw = env[name];
      const shown =
        raw === undefined || raw.trim() === "" || SECRET_SETTINGS.has(name)
          ? ""
          : ` (got "${raw}")`;
      return `${name} ${issue.message}${shown}`;
    });
    throw new SettingsError(problems);
  }
  const s = result.data;
  const warnings = misspelledSettings(env);
  if (
    s.MARFA_POSTHOG_HOST !== undefined &&
    !s.OTEL_SDK_DISABLED &&
    !usablePosthogHost(s.MARFA_POSTHOG_HOST)
  ) {
    warnings.push(UNUSABLE_POSTHOG_HOST);
  }
  const versionFile = readVersionFile();
  const sha = versionFile?.sha;
  const release = releaseOf(versionFile);
  const placement = {
    ...(s.MARFA_PLACEMENT_REGION && { region: s.MARFA_PLACEMENT_REGION }),
    ...(s.MARFA_PLACEMENT_LOCATION && { location: s.MARFA_PLACEMENT_LOCATION }),
    ...(s.MARFA_PLACEMENT_COUNTRY && { country: s.MARFA_PLACEMENT_COUNTRY }),
  };

  return {
    isProduction: s.NODE_ENV === "production",
    port: s.PORT,
    listenHost: s.MARFA_LISTEN_HOST,
    sqlitePath: s.SQLITE_PATH,
    controlSocket:
      s.MARFA_CONTROL_SOCKET ||
      resolve(dirname(s.SQLITE_PATH), "control", "marfa.sock"),
    controlOnly: s.MARFA_CONTROL_ONLY,
    testHooks: s.MARFA_TEST_HOOKS,
    testClockOffsetMs: s.MARFA_TEST_CLOCK_OFFSET_MS,
    testContractVersion: s.MARFA_TEST_CONTRACT_VERSION,
    testMigration: {
      ...(s.MARFA_TEST_MIGRATION_FAULT !== undefined && {
        fault: s.MARFA_TEST_MIGRATION_FAULT,
      }),
      ...(s.MARFA_TEST_FREE_DISK_BYTES !== undefined && {
        freeDiskBytes: s.MARFA_TEST_FREE_DISK_BYTES,
      }),
    },
    blobPath: s.BLOB_PATH,
    maxRequestBytes: s.MARFA_MAX_REQUEST_BYTES,
    maxBulkRequestBytes: s.MARFA_MAX_BULK_REQUEST_BYTES,
    s3Bucket: s.S3_BUCKET,
    s3Region: s.S3_REGION,
    s3Endpoint: s.S3_ENDPOINT,
    s3AccessKeyId: s.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: s.S3_SECRET_ACCESS_KEY ?? "",
    s3ForcePathStyle: s.S3_FORCE_PATH_STYLE,
    s3Prefix: s.S3_PREFIX,
    apiKeySalt: s.API_KEY_SALT ?? DEFAULT_SALT,
    corsOrigins: s.CORS_ORIGINS,
    permissionBundles: s.MARFA_PERMISSION_BUNDLES,
    rateLimitEnabled: s.RATE_LIMIT_ENABLED,
    enableHsts: s.ENABLE_HSTS,
    auditRetentionDays: s.AUDIT_RETENTION_DAYS,
    auditCleanupIntervalMs: s.AUDIT_CLEANUP_INTERVAL_MS,
    revokedGrantRetentionDays: s.MARFA_REVOKED_GRANT_RETENTION_DAYS,
    grantInactivityDays: s.MARFA_GRANT_INACTIVITY_DAYS,
    eventLogRetentionHours: s.MARFA_EVENT_LOG_RETENTION_HOURS,
    eventLogCleanupIntervalMs: s.MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS,
    versionThinningIntervalMs: s.VERSION_THINNING_INTERVAL_MS,
    feedExpiryIntervalMs: s.FEED_EXPIRY_INTERVAL_MS,
    versionRecentDays: s.VERSION_RECENT_DAYS,
    versionDailySnapshotDays: s.VERSION_DAILY_SNAPSHOT_DAYS,
    versionWeeklySnapshotDays: s.VERSION_WEEKLY_SNAPSHOT_DAYS,
    versionMaxVersions: s.VERSION_MAX_VERSIONS,
    trashRetentionDays: s.TRASH_RETENTION_DAYS,
    trashPurgeIntervalMs: s.TRASH_PURGE_INTERVAL_MS,
    authSessionCleanupIntervalMs: s.AUTH_SESSION_CLEANUP_INTERVAL_MS,
    dcrClientRetentionDays: s.MARFA_DCR_CLIENT_RETENTION_DAYS,
    dcrClientCleanupIntervalMs: s.MARFA_DCR_CLIENT_CLEANUP_INTERVAL_MS,
    rateLimitCleanupIntervalMs: s.MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS,
    blobCleanupIntervalMs: s.MARFA_BLOB_CLEANUP_INTERVAL_MS,
    blobCleanupGraceMs: s.MARFA_BLOB_CLEANUP_GRACE_MS,
    blobMinCopies: s.MARFA_BLOB_MIN_COPIES,
    blobReadIdleTimeoutMs: s.MARFA_BLOB_READ_IDLE_TIMEOUT_MS,
    uploadIdleTimeoutMs: s.MARFA_UPLOAD_IDLE_TIMEOUT_MS,
    diskReserveBytes: s.MARFA_DISK_RESERVE_BYTES,
    blobReplicateIntervalMs: s.MARFA_BLOB_REPLICATE_INTERVAL_MS,
    blobReplicateBatch: s.MARFA_BLOB_REPLICATE_BATCH,
    blobReplicateBatchBytes: s.MARFA_BLOB_REPLICATE_BATCH_BYTES,
    blobIntegrityIntervalMs: s.MARFA_BLOB_INTEGRITY_INTERVAL_MS,
    blobIntegrityBatch: s.MARFA_BLOB_INTEGRITY_BATCH,
    blobIntegrityBatchBytes: s.MARFA_BLOB_INTEGRITY_BATCH_BYTES,
    enrichmentEnabled: s.MARFA_ENRICHMENT_ENABLED,
    enrichmentIntervalMs: s.MARFA_ENRICHMENT_INTERVAL_MS,
    enrichmentBatchSize: s.MARFA_ENRICHMENT_BATCH_SIZE,
    enrichmentItemTimeoutMs: s.MARFA_ENRICHMENT_ITEM_TIMEOUT_MS,
    enrichmentMaxBlobBytes: s.MARFA_ENRICHMENT_MAX_BLOB_BYTES,
    enrichmentMaxTextChars: s.MARFA_ENRICHMENT_MAX_TEXT_CHARS,
    enrichmentMaxAttempts: s.MARFA_ENRICHMENT_MAX_ATTEMPTS,
    enrichmentMaxInflatedBytes: s.MARFA_ENRICHMENT_MAX_INFLATED_BYTES,
    enrichmentMaxMemoryBytes: s.MARFA_ENRICHMENT_MAX_MEMORY_BYTES,
    enrichmentOcrEnabled: s.MARFA_ENRICHMENT_OCR_ENABLED,
    enrichmentTessdataDir:
      s.MARFA_ENRICHMENT_TESSDATA_DIR ?? defaultTessdataDir(s.SQLITE_PATH),
    bulkActionJobRetentionMs: s.MARFA_BULK_ACTION_JOB_RETENTION_MS,
    bulkActionJobGcIntervalMs: s.MARFA_BULK_ACTION_JOB_GC_INTERVAL_MS,
    bulkActionPollIntervalMs: s.MARFA_BULK_ACTION_POLL_INTERVAL_MS,
    bulkActionPollMaxIntervalMs: s.MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS,
    bulkActionPollBackoffMultiplier:
      s.MARFA_BULK_ACTION_POLL_BACKOFF_MULTIPLIER,
    webhookAllowPrivateAddresses: s.MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES,
    mcpFetchEnabled: s.MARFA_MCP_FETCH_ENABLED,
    mcpFetchMaxBytes: s.MARFA_MCP_FETCH_MAX_BYTES,
    mcpFetchTimeoutMs: s.MARFA_MCP_FETCH_TIMEOUT_MS,
    deploymentEnvironment:
      firstNamed(
        s.OTEL_RESOURCE_ATTRIBUTES["deployment.environment.name"],
        s.OTEL_RESOURCE_ATTRIBUTES["deployment.environment"],
      ) ?? DEFAULT_DEPLOYMENT_ENVIRONMENT,
    errorReportingEnabled: s.MARFA_ERROR_REPORTING_ENABLED,
    heartbeatEnabled: s.MARFA_HEARTBEAT_ENABLED,
    errorWebhookUrl: s.ERROR_WEBHOOK_URL,
    errorWebhookTimeoutMs: s.MARFA_ERROR_WEBHOOK_TIMEOUT_MS,
    trustedProxyCidrs: s.TRUSTED_PROXY_CIDRS,
    trustedProxyHeader: s.TRUSTED_PROXY_HEADER,
    authBaseUrlFromPort: s.MARFA_AUTH_BASE_URL === undefined,
    authBaseUrl: s.MARFA_AUTH_BASE_URL ?? `http://localhost:${String(s.PORT)}`,
    // Minted per process outside production, where a restart ending every
    // session is the documented behavior; production refuses to boot
    // without one.
    authSecret: s.MARFA_AUTH_SECRET ?? randomBytes(32).toString("hex"),
    sqliteBusyBudgetMs: s.SQLITE_BUSY_BUDGET_MS,
    rateLimitDefaultLimit: s.RATE_LIMIT_REQUESTS,
    rateLimitWindowMs: s.RATE_LIMIT_WINDOW_MS,
    rateLimitKeysLimit: s.RATE_LIMIT_KEYS_REQUESTS,
    rateLimitAggregateMultiplier: s.RATE_LIMIT_AGGREGATE_MULTIPLIER,
    inbound: {
      maxBytes: s.MARFA_INBOUND_MAX_BYTES,
      requestsPerWindow: s.RATE_LIMIT_INBOUND_REQUESTS,
      backlogDeliveries: s.MARFA_INBOUND_BACKLOG_DELIVERIES,
      backlogBytes: s.MARFA_INBOUND_BACKLOG_BYTES,
      retainedDeliveries: s.MARFA_INBOUND_RETAINED_DELIVERIES,
      retainedBytes: s.MARFA_INBOUND_RETAINED_BYTES,
      cleanupIntervalMs: s.MARFA_INBOUND_CLEANUP_INTERVAL_MS,
      inFlightBytes: s.MARFA_INBOUND_IN_FLIGHT_BYTES,
      readTimeoutMs: s.MARFA_INBOUND_READ_TIMEOUT_MS,
      handledRetentionDays: s.MARFA_INBOUND_HANDLED_RETENTION_DAYS,
      pendingRetentionDays: s.MARFA_INBOUND_PENDING_RETENTION_DAYS,
    },
    connectorHoldMs: s.MARFA_CONNECTOR_HOLD_MS,
    versionSha: typeof sha === "string" && sha !== "" ? sha : undefined,
    releaseVersion: release,
    versionFile,
    placement: Object.keys(placement).length > 0 ? placement : undefined,
    otel: otelSettings(s),
    exceptions: exceptionSettings(s),
    heartbeatUrl: s.MARFA_HEARTBEAT_URL,
    heartbeatIntervalMs: s.MARFA_HEARTBEAT_INTERVAL_MS,
    housekeepingPollIntervalMs: s.MARFA_HOUSEKEEPING_POLL_INTERVAL_MS,
    sseMaxViewers: s.MARFA_SSE_MAX_VIEWERS,
    ...(warnings.length > 0 && { settingWarnings: warnings }),
    settingReadings: readSettings(describeSettings(), s, env),
  };
}

let booted: AppConfig | undefined;

/**
 * The process's settings, read on first call and the same object after.
 * The telemetry preload and the server entry both run in one process, and
 * this is how the second reads what the first already read, the dev
 * secret minted on the first read included.
 */
export function bootConfig(): AppConfig {
  booted ??= loadConfig(process.env);
  return booted;
}
