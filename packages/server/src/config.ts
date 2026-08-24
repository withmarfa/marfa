import type { PermissionBundle } from "@withmarfa/shared";
import { buildDefaultPermissionBundles } from "./auth/default-bundles.js";
import { parseTrustedProxyCidrs } from "./middleware/client-ip.js";
import type { CidrRange } from "./middleware/client-ip.js";
import { isSamePgEndpoint, pgEndpointLabel } from "./storage/pg/endpoint.js";

/**
 * Numeric env-var read with explicit "missing or empty → default" semantics.
 *
 * The `Number(env) || default` shorthand silently swallows zero — operators
 * cannot disable a sub-job (e.g. set a retention to `0`) because `0` is
 * falsy and gets overridden by the default. This helper is the canonical
 * pattern for every numeric env read in the server: an undefined or empty
 * env var falls back to the default; any other value (including `0`,
 * negatives, or `NaN`) is honored as written.
 *
 * If you need range/validity checking on top, parse explicitly (see
 * `parseEventLogRetentionHours` for an example with warnings on bad input).
 */
export function envNumber(raw: string | undefined, fallback: number): number {
  return raw !== undefined && raw !== "" ? Number(raw) : fallback;
}

/**
 * How the endpoint `DATABASE_URL` points at multiplexes connections.
 *
 * `session` — one client link maps 1:1 to a real backend for its lifetime.
 * True of a direct Postgres connection and of a session-mode pooler.
 *
 * `transaction` — a pooler (PgBouncer, Neon's `-pooler` endpoint) hands out a
 * backend per transaction, so session-level state set outside a transaction
 * lands on whichever backend served that statement and is inherited by later,
 * unrelated queries. Streaming RLS sets exactly that kind of state, so this
 * mode requires a separate direct endpoint to reserve from.
 */
export type DbPoolMode = "session" | "transaction";

export type ProcessRole = "web" | "worker" | "both";

export interface AppConfig {
  /** True when `NODE_ENV === "production"`. Gates production-only
   *  hardenings (e.g. CORS localhost auto-reflection is dev-only).
   *  Optional on the type so test contexts constructing `AppConfig`
   *  literals don't have to supply it; readers treat `undefined` as
   *  non-production. `loadConfig` always populates it. */
  isProduction?: boolean;
  port: number;
  storageDialect: "sqlite" | "pg";
  sqlitePath: string;
  databaseUrl: string;
  /**
   * Direct (session-mode) Postgres URL for streaming RLS, from
   * `MARFA_DATABASE_URL_DIRECT`. Streaming issues a session-level `SET ROLE`,
   * which must run on a connection that owns its backend outright. Required
   * when `dbPoolMode` is `transaction`; unset is fine otherwise, and streaming
   * then reuses the main client.
   */
  databaseUrlDirect?: string;
  /**
   * What kind of endpoint `databaseUrl` points at, from `MARFA_DB_POOL_MODE`.
   * Defaults to `session`, which is what a self-host talking straight to
   * Postgres has. Hosted deployments behind a transaction-mode pooler declare
   * `transaction`, which makes `databaseUrlDirect` mandatory. Optional on the
   * type so test contexts constructing `AppConfig` literals compile; readers
   * treat `undefined` as `session`, and `loadConfig` always populates it.
   */
  dbPoolMode?: DbPoolMode;
  /**
   * What this process does, from `MARFA_PROCESS_ROLE`. `web` serves HTTP
   * (API, SSE, webhook receipt, consent); `worker` runs the pg-boss
   * consumers (scheduled jobs, integration dispatch, enrichment, bulk
   * actions) behind a minimal health endpoint; `both` is the default and
   * the single-container self-host shape. Coordination goes through
   * Postgres, so any mix of roles against one database is valid — which
   * is also why a role other than `both` requires the pg dialect.
   * Optional on the type so test contexts constructing `AppConfig`
   * literals compile; readers treat `undefined` as `both`.
   */
  processRole?: ProcessRole;
  /**
   * Public-to-this-deployment URL the local integration substrate's
   * handlers write back through, from `MARFA_API_URL`. Defaults to
   * `http://localhost:<port>`, which is correct whenever the web tier
   * shares the process (`both`) — a split worker container points this
   * at the web service instead.
   */
  apiUrl?: string;
  /**
   * Main Postgres pool cap, from `MARFA_DB_POOL_SIZE` (default 10). The
   * session/streaming pool follows as `min(this, 5)`. Exists so a split
   * deployment can budget web + worker under a managed tier's connection
   * ceiling; the arithmetic lives in the deployment's env template.
   */
  dbPoolSize?: number;
  blobPath: string;
  blobBackend: "fs" | "s3";
  /** Maximum blob upload size in bytes. Uploads exceeding this are rejected
   *  with HTTP 413 `blob_too_large`. Default: 50MB. */
  maxBlobSize: number;
  /** Maximum request body size in bytes for the JSON write surface. Bodies
   *  exceeding this are rejected with HTTP 413 `request_too_large` by the
   *  global `bodyLimit` middleware. The blob + avatar upload routes are
   *  exempt — they enforce their own (much larger) `maxBlobSize` cap.
   *  Read from `MARFA_MAX_REQUEST_BYTES`; default 1MB. */
  maxRequestBytes: number;
  /** Maximum request body size in bytes for the bulk write endpoints
   *  (`/items/bulk*`, `/edges/bulk`), which carry up to 5000 items/edges in a
   *  single body and so need a larger cap than the per-request default. Read
   *  from `MARFA_MAX_BULK_REQUEST_BYTES`; default 16MB. Optional — falls back
   *  to the 16MB default when unset. */
  maxBulkRequestBytes?: number;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  apiKeySalt: string;
  corsOrigins: string[];
  /** Named consent-screen permission bundles (see `DEFAULT_PERMISSION_BUNDLES`).
   *  Overridable via `MARFA_PERMISSION_BUNDLES`. Optional on the type so test
   *  contexts that construct AppConfig literals compile; `loadConfig` always
   *  populates it, and readers fall back to `getPermissionBundles()`. */
  permissionBundles?: PermissionBundle[];
  cdnBaseUrl: string;
  authMode: "hosted" | "keys";
  rateLimitEnabled: boolean;
  enableHsts: boolean;
  /**
   * When `true`, wraps each space-bounded Postgres request in a
   * transaction with `SET LOCAL ROLE marfa_app` and
   * `SET LOCAL marfa.space_id = '<id>'` so RLS policies enforce
   * space isolation at the DB layer (defense-in-depth beneath the
   * application-layer scoping). Defaults to `true`. See
   * `packages/server/CLAUDE.md` under "Postgres RLS".
   *
   * Optional on the type so test contexts that construct AppConfig
   * literals continue to compile.
   */
  rlsEnforce?: boolean;
  auditRetentionDays: number;
  auditCleanupIntervalMs: number;
  /** Days a `system.activity` item survives before the purger drops it.
   *  Default 14; env override `MARFA_ACTIVITY_RETENTION_DAYS`; per-space
   *  override `activity_retention_days`. `0` disables the job.
   *
   *  An integration reports every run as an activity row, including the
   *  runs that found nothing to do, so this is the fastest-growing item
   *  type on a space with connections and nothing aged it out before.
   *
   *  Optional on the type for the same reason `rlsEnforce` is: a dozen
   *  test contexts build `AppConfig` literals, and a required field with
   *  a sensible default would churn every one of them to say what the
   *  default already says. */
  activityRetentionDays?: number;
  /** Cadence (ms) for the activity purger. Default 3_600_000 (1h);
   *  env override `MARFA_ACTIVITY_PURGE_INTERVAL_MS`. */
  activityPurgeIntervalMs?: number;
  /** Hours an event_log entry survives before the cleanup job purges it.
   *  Default 168 (7 days). Controls how far back a client's SSE replay
   *  cursor can reach; requests with `Last-Event-ID` older than the
   *  oldest retained event get a terminal `catchup_too_old` event.
   *  Optional on the type so callers constructing `AppConfig` literals
   *  don't have to supply it; `index.ts` applies the 168 fallback. */
  eventLogRetentionHours?: number;
  /** Cadence (ms) for the event-log cleanup sweep that purges expired
   *  `event_log` rows. Default 3_600_000 (1h); env override
   *  `MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS`. Optional on the type;
   *  `index.ts` applies the 1h fallback when unset. */
  eventLogCleanupIntervalMs?: number;
  versionThinningIntervalMs: number;
  versionRecentDays: number;
  versionDailySnapshotDays: number;
  versionWeeklySnapshotDays: number;
  versionMaxVersions: number;
  /** Days a trashed item survives before it's hard-deleted by the trash
   *  purger. `0` disables the job. Default: 60. */
  trashRetentionDays: number;
  trashPurgeIntervalMs: number;
  /** Cadence (ms) for the better-auth session cleanup sweep — drops
   *  `auth_session` rows whose `expires_at` has passed. Default
   *  3_600_000 (1h); env override `AUTH_SESSION_CLEANUP_INTERVAL_MS`.
   *  No retention-window knob — Better Auth itself owns the TTL.
   *  Optional on the type; `index.ts` applies the 1h fallback. */
  authSessionCleanupIntervalMs?: number;
  /** Days a grantless DCR (`auth_oauth_client`) row survives before the
   *  reaper hard-deletes it. A row is reaped only when it's older than this
   *  AND carries zero grants (no access token, no refresh token, no
   *  projected `system.connection` app item). Unauthenticated DCR lets
   *  clients accumulate forever; this bounds the abandoned ones. `0`
   *  disables the job. Default 30. Env override
   *  `MARFA_DCR_CLIENT_RETENTION_DAYS`. Optional on the type; `index.ts`
   *  applies the 30-day fallback. */
  dcrClientRetentionDays?: number;
  /** Cadence (ms) for the grantless-DCR-client reaper sweep. Default
   *  86_400_000 (24h); env override `MARFA_DCR_CLIENT_CLEANUP_INTERVAL_MS`.
   *  Optional on the type; `index.ts` applies the 24h fallback. */
  dcrClientCleanupIntervalMs?: number;
  /** Grace window (days) between `auth.account.delete_confirmed` and
   *  the hard-delete cascade. `0` disables the purger entirely. Env
   *  override `MARFA_ACCOUNT_DELETION_GRACE_DAYS`. Default 30. */
  accountDeletionGraceDays?: number;
  /** Cadence (ms) for the pending-delete purger sweep. Env override
   *  `MARFA_ACCOUNT_DELETION_PURGE_INTERVAL_MS`. Default 1h. */
  accountDeletionPurgeIntervalMs?: number;
  /** Cadence (ms) for the `rate_limit_windows` GC sweep that drops rows
   *  past their `expires_at`. Default 3_600_000 (1h); env override
   *  `MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS`. Optional — `index.ts`
   *  applies the 1h fallback when unset. */
  rateLimitCleanupIntervalMs?: number;
  /** Cadence (ms) for the runtime-credential reaper: revokes runtime
   *  credentials past `expires_at`, drains legacy rows minted before
   *  expiry stamping, and hard-deletes revoked rows older than seven
   *  days. `0` disables the job. Default 3_600_000 (1h); env override
   *  `MARFA_RUNTIME_CREDENTIAL_REAPER_INTERVAL_MS`. */
  runtimeCredentialReaperIntervalMs?: number;
  /** Cadence (ms) of the pass that moves connections onto the newest
   *  registered manifest version where doing so widens no grant. `0`
   *  disables it, which leaves drift to be cleared by hand and so leaves
   *  the drift number permanently non-zero. Default 3_600_000 (1h); env
   *  override `MARFA_CONNECTION_UPGRADE_INTERVAL_MS`. */
  connectionUpgradeIntervalMs?: number;
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
  /** Extracted text is truncated to this many characters. Default
   *  200_000; env override `MARFA_ENRICHMENT_MAX_TEXT_CHARS`. */
  enrichmentMaxTextChars?: number;
  /** How many times a failing item is retried before the sweeper stops
   *  offering it. Default 3; env override
   *  `MARFA_ENRICHMENT_MAX_ATTEMPTS`. */
  enrichmentMaxAttempts?: number;
  /** OCR of image files. On unless `MARFA_ENRICHMENT_OCR_ENABLED=false`.
   *  Off means image items are recorded as unsupported and never retried,
   *  which is the right posture for a memory-constrained deployment: the
   *  wasm core is the heaviest thing extraction loads. */
  enrichmentOcrEnabled?: boolean;
  /** Directory the OCR language model is cached in across runs. Default
   *  `./data/tessdata`; env override `MARFA_ENRICHMENT_TESSDATA_DIR`.
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
  /** Issuer URL the better-auth instance is reached at — protocol + host
   *  (and port). Drives cookie domains and the OAuth issuer field on the
   *  discovery doc. Defaults to `http://localhost:<port>` if unset. */
  authBaseUrl: string;
  /** When `true`, the email + password sign-up endpoint is enabled.
   *  Default `false` — single-user self-hosted instances enable this
   *  only for the initial admin account. */
  authAllowSignup: boolean;
  /** Whether the remote MCP surface is mounted at `/mcp`. Default on:
   *  every instance gets the agent surface unless the operator opts out. */
  mcpEnabled: boolean;
  /** Toolsets the remote MCP surface exposes (comma-list: standard,
   *  admin, all). Defaults to `standard`; credentials still gate every
   *  call, so widening this widens offering, not access. */
  mcpToolsets?: string;
  /** When `true`, a fresh sign-up's space is seeded with a few starter
   *  items (a welcome note, a docs bookmark, a first task, one connecting
   *  edge) so the space isn't empty on first open. Default `false`: self-host
   *  and conformance get empty spaces; hosted deployments flip it on. */
  seedStarterContent: boolean;
  /** Shared secret for cookie signing. Required in production; falls back
   *  to a per-process ephemeral secret in dev. */
  authSecret: string;
  /** Explicit override for `requireEmailVerification`. When `undefined`,
   *  the auth layer auto-detects from the configured email transport (on
   *  for `cloudflare`/`smtp`, off for `none`/missing). When set, takes
   *  precedence — primarily a test hook (env-driven config never sets it). */
  authRequireEmailVerification?: boolean;
  /** Federated OIDC providers (Google / GitHub / Authentik / etc.) wired
   *  into the generic-oauth plugin. Parsed from the `MARFA_OIDC_PROVIDERS`
   *  env var (JSON array of `{ providerId, clientId, clientSecret,
   *  discoveryUrl?, scopes? }`). */
  oidcProviders: OidcProviderConfig[];
  /** Default per-credential rate limit, requests per `rateLimitWindowMs`
   *  window. Read from `RATE_LIMIT_REQUESTS` (default 1000). Wired through
   *  the rate-limit middleware so there's a single env-read site. */
  rateLimitDefaultLimit: number;
  /** Rate-limit window size in ms. Read from `RATE_LIMIT_WINDOW_MS`
   *  (default 60_000) — configurable, not hard-coded. */
  rateLimitWindowMs: number;
  /** Multiplier for the aggregate per-identifier rate-limit window. The
   *  aggregate cap is `rateLimitDefaultLimit * this`, keyed on the
   *  identifier alone (no path split) so a caller's budget can't
   *  multiply across path groups. Read from
   *  `RATE_LIMIT_AGGREGATE_MULTIPLIER` (default 4). `0` disables the
   *  aggregate window. Optional on the type so test contexts
   *  constructing `AppConfig` literals don't have to supply it. */
  rateLimitAggregateMultiplier?: number;
  /** Deployed-build identifier, surfaced on `GET /` as `version`. Filled
   *  by `index.ts` from `version.json` at startup; defaults to `"dev"`
   *  when no version file is present (local development). The committed
   *  OpenAPI spec keeps a separate, semantically-distinct
   *  API-contract version. */
  versionSha?: string;
  /**
   * Default per-space quota ceilings. NULL = unlimited (no enforcement).
   * Each is read from a corresponding env var (`MARFA_DEFAULT_QUOTA_*`);
   * per-space overrides via `space_quotas` rows take precedence.
   * Optional on the type so existing test contexts continue to compile.
   */
  defaultQuotaItems?: number | null;
  defaultQuotaWebhooks?: number | null;
  defaultQuotaBlobs?: number | null;
  defaultQuotaStorageBytes?: number | null;
  defaultQuotaRatePerMinute?: number | null;
  /**
   * Email transport configuration.
   *
   * - `emailBackend` — `cloudflare | smtp | none`. Default `none` —
   *   email-dependent flows (forgot-password, magic-link, email-verify)
   *   return `email_transport_not_configured` until an operator picks
   *   a backend. The factory + boot guard at `src/email/index.ts`
   *   constructs the right transport at startup.
   * - `emailFrom` — visible sender, e.g. `Marfa <hello@mail.marfa.so>`.
   *   For the Cloudflare backend the domain MUST end in `@mail.marfa.so`
   *   (the verified Cloudflare Email sending domain) —
   *   `senderDomainCheck` enforces this at boot. Apex `marfa.so` has
   *   no DKIM and would fail SPF.
   * - `emailReplyTo` — monitored Reply-To. Optional; recommend a
   *   real inbox so user replies don't bounce silently.
   * - `cloudflareAccountId` / `cloudflareEmailApiToken` — Cloudflare
   *   Email backend creds.
   * - `smtpHost` / `smtpPort` / `smtpUser` / `smtpPass` /
   *   `smtpSecure` — SMTP backend creds (self-host fallback).
   */
  emailBackend?: "cloudflare" | "smtp" | "none";
  emailFrom?: string;
  emailReplyTo?: string;
  cloudflareAccountId?: string;
  cloudflareEmailApiToken?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpSecure?: boolean;
  /**
   * Worker threads per integration on the local substrate
   * (`MARFA_INTEGRATION_WORKER_THREADS`). Sets the executor's
   * per-integration pool size. Every thread holds its own resource-limit
   * budget in memory, so raising this is a deployment sizing decision,
   * not a free throughput dial. Optional: unset keeps the executor's
   * default of 2.
   */
  integrationWorkerThreads?: number;
  /**
   * OpenTelemetry configuration. The instrumentation bootstrap
   * (`src/instrumentation.ts`) reads its toggle + exporter config from the
   * environment directly because it must run before `loadConfig` (and
   * before any instrumented module loads). These fields exist so the rest
   * of the server can read the *resolved* OTel config from the single
   * config source — they are NOT the wiring path for the SDK itself.
   *
   * Default OFF. Deployed hosted containers set `MARFA_OTEL_ENABLED=true`.
   * Standard `OTEL_EXPORTER_OTLP_*` env vars carry endpoint + headers;
   * `MARFA_OTEL_*` carries Marfa policy (toggle, sampling). Optional on
   * the type so `AppConfig` literals
   * in tests keep compiling.
   */
  otelEnabled?: boolean;
  otelServiceName?: string;
  /** Deployment environment stamped onto the `deployment.environment` OTel
   *  resource attribute (`MARFA_OTEL_ENVIRONMENT`). No fallback: the value is
   *  stated per environment or absent, because the only thing available to
   *  infer from is `NODE_ENV`, which reports how the image was built rather
   *  than which deployment is running it. Mirrored here for
   *  read-from-one-place consistency; the bootstrap in `instrumentation.ts`
   *  reads the env var directly (it runs before `loadConfig`) and refuses to
   *  start without it when telemetry is actually being exported. */
  otelEnvironment?: string;
  /** OTLP traces endpoint (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`). Empty in
   *  hosted test mode — the trace pipeline is built but points at no store;
   *  PostHog has no general-trace ingest (only logs + errors). */
  otelTracesEndpoint?: string;
  /** OTLP logs endpoint (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`). Hosted points
   *  this at PostHog's `https://eu.i.posthog.com/i/v1/logs`. */
  otelLogsEndpoint?: string;
  /** Exporter headers parsed from `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`).
   *  Carries e.g. `Authorization=Bearer <phc_...>` for PostHog. */
  otelHeaders?: Record<string, string>;
  /** Baseline trace sample ratio (`MARFA_OTEL_SAMPLE_RATIO`, default 0.05).
   *  Errors export at 100% regardless — see `otel/error-aware-sampler.ts`. */
  otelSampleRatio?: number;
  /** Liveness heartbeat target (`MARFA_HEARTBEAT_URL`). Empty = off, the
   *  default. When set, the server GETs this URL on a timer so something
   *  running elsewhere can notice when the pings stop — a process cannot
   *  report its own death. A ping, not a report: no payload leaves. */
  heartbeatUrl?: string;
  /** Heartbeat cadence in ms (`MARFA_HEARTBEAT_INTERVAL_MS`, default
   *  60000). Ignored while `heartbeatUrl` is unset. */
  heartbeatIntervalMs?: number;
  /** How long boot waits for the database before giving up
   *  (`MARFA_DB_STARTUP_WAIT_MS`, default 90000; `0` = fail fast).
   *  Covers the slow-Postgres-after-reboot case that otherwise turns a
   *  supervised server into a crash loop. Only connection-shaped
   *  failures wait; misconfiguration still fails immediately. */
  dbStartupWaitMs?: number;
  /** Ceiling on concurrent SSE viewers per server instance
   *  (`MARFA_SSE_MAX_VIEWERS`, default 0 = uncapped). A deliberate
   *  memory bound: viewers hold no database connection, so any limit is
   *  a stated choice rather than a pool artifact. */
  sseMaxViewers?: number;
}

export interface OidcProviderConfig {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  scopes?: string[];
}

const DEFAULT_SALT = "dev-salt-change-in-production";

const DEFAULT_EVENT_LOG_RETENTION_HOURS = 168;

/**
 * Parses `MARFA_EVENT_LOG_RETENTION_HOURS`. Unset → default (168 / 7 days).
 * Non-positive, non-integer, or unparseable values log a warning and fall
 * back to the default rather than throwing — cleanup is belt-and-braces
 * and we'd rather run the server with sensible retention than fail boot.
 * Exported for direct unit testing.
 */
/**
 * Parses a quota env var. Returns null for unset / empty (the
 * "unlimited" sentinel) and a parsed integer otherwise. Negative or
 * non-integer values log a warning and fall back to null.
 */
function parseQuotaEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.warn(
      `Invalid quota env value "${raw}", treating as unlimited (null).`,
    );
    return null;
  }
  return parsed;
}

export function parseEventLogRetentionHours(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_EVENT_LOG_RETENTION_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    console.warn(
      `Invalid MARFA_EVENT_LOG_RETENTION_HOURS=${raw}, falling back to ${String(DEFAULT_EVENT_LOG_RETENTION_HOURS)}`,
    );
    return DEFAULT_EVENT_LOG_RETENTION_HOURS;
  }
  return parsed;
}

const DEFAULT_OTEL_SAMPLE_RATIO = 0.05;

/**
 * Parses `MARFA_OTEL_SAMPLE_RATIO` — the baseline head-sampling ratio for
 * traces. Unset → default (0.05). Out-of-range or unparseable values warn
 * and clamp into [0, 1] (or fall back to the default), mirroring the
 * fail-soft stance of `parseEventLogRetentionHours`. Exported for unit
 * testing. Errors always export at 100% regardless of this ratio — see
 * `otel/error-aware-sampler.ts`.
 */
export function parseOtelSampleRatio(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_OTEL_SAMPLE_RATIO;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `Invalid MARFA_OTEL_SAMPLE_RATIO=${raw}, falling back to ${String(DEFAULT_OTEL_SAMPLE_RATIO)}`,
    );
    return DEFAULT_OTEL_SAMPLE_RATIO;
  }
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

/**
 * Parses the OTLP exporter headers env var (`OTEL_EXPORTER_OTLP_HEADERS`),
 * a comma-separated list of `key=value` pairs per the OTLP exporter spec
 * (e.g. `Authorization=Bearer abc123,X-Space=acme`). Whitespace around
 * keys/values is trimmed; the value may itself contain `=` (split on the
 * first only). Malformed entries are skipped. Exported for unit testing.
 */
export function parseOtelHeaders(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * The default consent-screen permission bundles, derived from the type
 * registry at module load. Each scope renders as one plain-language
 * per-type toggle; the issued token carries exactly the scopes the user
 * keeps ticked, enforced through the usual permission maps. Every bundle
 * here declares `default_on: true`, so all of them arrive pre-ticked, and
 * that is a property of these five rather than of the renderer.
 *
 * The derivation, its family rules, and the rationale each rule carries
 * live in `auth/default-bundles.ts`. Deployments whose spaces registered
 * custom types under their own publisher handles get those namespaces
 * folded in at boot via {@link setActivePermissionBundles}; this constant
 * is the registry-only baseline.
 */
export const DEFAULT_PERMISSION_BUNDLES: PermissionBundle[] =
  buildDefaultPermissionBundles();

/**
 * Parse the operator override `MARFA_PERMISSION_BUNDLES` (a JSON array of
 * `PermissionBundle`). Falls back to {@link DEFAULT_PERMISSION_BUNDLES} on
 * absent, non-array, or malformed input — a bad override must never strand
 * the consent screen with zero bundles.
 *
 * **A missing `default_on` is an error, not a default.** The field is
 * required on `PermissionBundle`, and an override is JSON the type system
 * never checks.
 *
 * Neither implicit reading is better than refusing. Defaulting to `true`
 * makes a required field optional in practice and turns an operator who
 * meant `false` and misspelled the key into an on-by-default grant, which
 * is the wrong direction to fail on a permission question. Defaulting to
 * `false` fails in the safe direction and silently, producing a consent
 * screen that looks broken and a grant that reaches nothing. Refusing the
 * override says so, keeps the type honest, and leaves a working screen up.
 */
export function loadPermissionBundles(
  raw: string | undefined,
): PermissionBundle[] {
  if (!raw) return DEFAULT_PERMISSION_BUNDLES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(
        "MARFA_PERMISSION_BUNDLES is not a JSON array; using defaults.",
      );
      return DEFAULT_PERMISSION_BUNDLES;
    }
    const isValidBundle = (b: unknown): b is PermissionBundle =>
      typeof b === "object" &&
      b !== null &&
      typeof (b as PermissionBundle).id === "string" &&
      Array.isArray((b as PermissionBundle).scopes) &&
      typeof (b as PermissionBundle).default_on === "boolean";
    // Names the entry an operator has to go and fix: its id when it has one,
    // its position when it does not, since a missing id is one of the ways an
    // entry lands here.
    const nameOf = (b: unknown, i: number): string => {
      const id: unknown = (b as { id?: unknown } | null)?.id;
      return typeof id === "string" && id.length > 0
        ? id
        : `index ${String(i)}`;
    };
    const rejected: string[] = [];
    const bundles: PermissionBundle[] = [];
    parsed.forEach((b: unknown, i: number) => {
      if (isValidBundle(b)) bundles.push(b);
      else rejected.push(nameOf(b, i));
    });
    if (rejected.length > 0) {
      // Loud, and it names them. A rejected override silently reverts the
      // instance to the shipped bundles, and the operator's next signal is a
      // consent screen that does not offer what they configured — with
      // nothing on it pointing at the environment variable. Naming the
      // entries turns that into a one-line fix.
      console.error(
        `MARFA_PERMISSION_BUNDLES rejected; using defaults. ` +
          `Each entry needs a string id, a scopes array, and a boolean default_on. ` +
          `Offending entries: ${rejected.join(", ")}.`,
      );
      return DEFAULT_PERMISSION_BUNDLES;
    }
    return bundles;
  } catch (err) {
    console.warn(
      `Failed to parse MARFA_PERMISSION_BUNDLES (${String(err)}); using defaults.`,
    );
    return DEFAULT_PERMISSION_BUNDLES;
  }
}

/**
 * Bundles installed at boot, when the runtime custom-type namespaces have
 * been folded in. Null until then; every reader falls back to the
 * environment/default resolution so nothing changes for callers that run
 * before boot completes (config load, tests that never call the setter).
 */
let activePermissionBundles: PermissionBundle[] | null = null;

/**
 * Install the active bundle set. Called once at boot after storage is up
 * (so the custom-type namespace read has a database to ask), and by tests
 * that exercise the runtime-namespace path. The operator override
 * `MARFA_PERMISSION_BUNDLES` outranks it: when that is set, boot skips the
 * call and the override stays authoritative.
 */
export function setActivePermissionBundles(
  bundles: PermissionBundle[] | null,
): void {
  activePermissionBundles = bundles;
}

/**
 * Whether the operator override is both set and usable.
 *
 * Boot skips folding the runtime custom-type namespaces in when an override
 * is present, because the override outranks the derivation. Presence and
 * validity are different questions, and only the second one should suppress
 * the derivation: a rejected override falls back to the shipped defaults, so
 * keying on presence alone would drop the handle namespaces a space's own
 * custom types need on top of dropping the override.
 */
export function hasUsablePermissionBundleOverride(): boolean {
  const raw = process.env.MARFA_PERMISSION_BUNDLES;
  if (!raw) return false;
  return loadPermissionBundles(raw) !== DEFAULT_PERMISSION_BUNDLES;
}

/** Resolve the active permission bundles. */
export function getPermissionBundles(): PermissionBundle[] {
  return (
    activePermissionBundles ??
    loadPermissionBundles(process.env.MARFA_PERMISSION_BUNDLES)
  );
}

/**
 * Parse `MARFA_DB_POOL_MODE`. Unset → `session`, so a self-host connecting
 * straight to Postgres is unaffected by the guard below.
 *
 * Unlike the other enum parsers in this file, an unrecognized value throws
 * rather than warning and falling back. The fallback here is the permissive
 * mode, and resolving a typo to it would silently re-open exactly the
 * misconfiguration this setting exists to close.
 */
export function parseDbPoolMode(raw: string | undefined): DbPoolMode {
  if (raw === undefined || raw === "") return "session";
  if (raw === "session" || raw === "transaction") return raw;
  throw new Error(
    `Unknown MARFA_DB_POOL_MODE=${raw}. Legal values: session | transaction.`,
  );
}

function parseProcessRole(raw: string | undefined): ProcessRole {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return "both";
  if (value === "web" || value === "worker" || value === "both") return value;
  // A typo silently defaulting to `both` would run every consumer twice
  // across a split deployment, so an unknown value refuses to boot.
  throw new Error(
    `Unknown MARFA_PROCESS_ROLE=${raw ?? ""}. Legal values: web | worker | both.`,
  );
}

function parseApiUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  // The worker's handlers spend this on every write-back; a malformed
  // value surfaces there as an opaque fetch failure at dispatch time, so
  // it refuses at boot instead, matching the sibling knobs.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`MARFA_API_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MARFA_API_URL must be http or https, got ${parsed.protocol}//`,
    );
  }
  return raw;
}

function parseDbPoolSize(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  // The pool cap is a connection-budget control; a NaN or non-positive
  // value silently falling back to the default would blow exactly the
  // budget it exists to hold, so it refuses to boot instead.
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `MARFA_DB_POOL_SIZE must be a positive integer, got ${raw}.`,
    );
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const corsRaw = process.env.CORS_ORIGINS ?? "";
  const apiKeySalt = process.env.API_KEY_SALT ?? DEFAULT_SALT;
  const authSecret = process.env.MARFA_AUTH_SECRET ?? "";
  const storageDialect = process.env.DB_DIALECT === "pg" ? "pg" : "sqlite";
  const dbPoolMode = parseDbPoolMode(process.env.MARFA_DB_POOL_MODE);
  const processRole = parseProcessRole(process.env.MARFA_PROCESS_ROLE);
  const dbPoolSize = parseDbPoolSize(process.env.MARFA_DB_POOL_SIZE);
  const apiUrl = parseApiUrl(process.env.MARFA_API_URL);

  // The split's coordination is all Postgres: pg-boss pins scheduled and
  // dispatch work to whichever process registered the workers, pg_notify
  // replicates events between processes, and the consent lock's
  // cross-process backend is an advisory lock. SQLite has none of that, so
  // a role other than `both` there would silently run half a deployment.
  if (processRole !== "both" && storageDialect !== "pg") {
    throw new Error(
      `MARFA_PROCESS_ROLE=${processRole} requires DB_DIALECT=pg. ` +
        "Role-split deployments coordinate through Postgres; SQLite runs one process with the default role (both).",
    );
  }
  const databaseUrl = process.env.DATABASE_URL ?? "";
  // Trimmed here so every consumer sees the same value the guards below
  // judged: createConnection trims its copy, and an untrimmed
  // whitespace-only value passing this check would hand downstream
  // consumers (the pg-boss endpoint choice) a string that is truthy and
  // useless.
  const databaseUrlDirect = (
    process.env.MARFA_DATABASE_URL_DIRECT ?? ""
  ).trim();

  if (storageDialect === "pg" && dbPoolMode === "transaction") {
    // Fail closed. Streaming RLS issues a session-level `SET ROLE marfa_app`;
    // over a transaction-mode pooler that role strands on a shared backend and
    // is inherited by later, unrelated queries, including Better Auth's session
    // reads on tables the role holds no grant on. Falling back to the pooled
    // client when the direct endpoint is missing is a silent downgrade from
    // "isolated" to "leaks across the whole instance", so refuse to start
    // instead. Disabling streaming RLS as the fallback would be no better: that
    // trades a visible outage for an invisible loss of space isolation.
    if (databaseUrlDirect === "") {
      throw new Error(
        "MARFA_DATABASE_URL_DIRECT is required when MARFA_DB_POOL_MODE=transaction. " +
          "Streaming RLS sets a session-level role, which strands on a shared backend " +
          "over a transaction-mode pooler; point this at the direct (unpooled) " +
          "endpoint of the same database as DATABASE_URL.",
      );
    }
    // Presence is not directness. The two hosts are resolved from adjacent
    // variable names in the deploy tooling, and on Neon they differ by the
    // six characters of the `-pooler` suffix, so the plausible misconfiguration
    // is not "unset" but "set to the pooled endpoint again" — which satisfies
    // every other signal (a distinct client, a `direct` boot log) while
    // reproducing the outage exactly.
    if (isSamePgEndpoint(databaseUrl, databaseUrlDirect)) {
      throw new Error(
        "MARFA_DATABASE_URL_DIRECT points at the same endpoint as DATABASE_URL " +
          `(${pgEndpointLabel(databaseUrlDirect)}), so it is the pooled one. ` +
          "Streaming RLS needs an endpoint that owns its backend outright; a " +
          "session-level SET ROLE over a transaction-mode pooler strands on a " +
          "shared backend. On Neon the direct host is the pooled host without " +
          "the `-pooler` suffix.",
      );
    }
  }

  if (process.env.NODE_ENV === "production") {
    if (!apiKeySalt || apiKeySalt === DEFAULT_SALT) {
      throw new Error(
        "API_KEY_SALT must be set to a unique value in production. " +
          "Generate one with: openssl rand -hex 32",
      );
    }
    if (apiKeySalt.length < 32) {
      throw new Error(
        "API_KEY_SALT must be at least 32 characters. " +
          "Generate one with: openssl rand -hex 32",
      );
    }
    // MARFA_AUTH_SECRET derives the at-rest encryption key for every
    // stored ciphertext (OAuth tokens, webhook secrets, OAuth callback
    // state, system.credential rows). If it is unset, the crypto layer
    // would fall back to a per-process random key, so a restart on the
    // scale-to-zero hosted container leaves all prior ciphertexts
    // undecryptable. Enforce presence at boot so that never happens.
    if (!authSecret || authSecret.length < 32) {
      throw new Error(
        "MARFA_AUTH_SECRET must be set to at least 32 characters in production. " +
          "Generate one with: openssl rand -hex 32",
      );
    }
  }

  const port = envNumber(process.env.PORT, 8600);
  return {
    isProduction: process.env.NODE_ENV === "production",
    port,
    storageDialect,
    sqlitePath: process.env.SQLITE_PATH ?? "./data/marfa.db",
    databaseUrl,
    databaseUrlDirect,
    dbPoolMode,
    processRole,
    ...(apiUrl !== undefined && { apiUrl }),
    ...(dbPoolSize !== undefined && { dbPoolSize }),
    blobPath: process.env.BLOB_PATH ?? "./data/blobs",
    blobBackend: process.env.BLOB_BACKEND === "s3" ? "s3" : "fs",
    maxBlobSize: envNumber(process.env.MAX_BLOB_SIZE, 50 * 1024 * 1024),
    maxRequestBytes: envNumber(process.env.MARFA_MAX_REQUEST_BYTES, 1_048_576),
    maxBulkRequestBytes: envNumber(
      process.env.MARFA_MAX_BULK_REQUEST_BYTES,
      16 * 1024 * 1024,
    ),
    s3Bucket: process.env.S3_BUCKET ?? "",
    s3Region: process.env.S3_REGION ?? "us-east-1",
    s3Endpoint: process.env.S3_ENDPOINT ?? "",
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    apiKeySalt,
    corsOrigins: corsRaw ? corsRaw.split(",").map((s) => s.trim()) : [],
    permissionBundles: getPermissionBundles(),
    cdnBaseUrl: process.env.CDN_BASE_URL ?? "",
    authMode: process.env.AUTH_MODE === "hosted" ? "hosted" : "keys",
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== "false",
    enableHsts: process.env.ENABLE_HSTS === "true",
    // RLS enforces by default; explicit opt-out is `MARFA_RLS_ENFORCE=false`.
    // SQLite is unaffected — the middleware skips when `storage.pgDb` is
    // undefined regardless of this flag.
    rlsEnforce: process.env.MARFA_RLS_ENFORCE !== "false",
    auditRetentionDays: envNumber(process.env.AUDIT_RETENTION_DAYS, 90),
    activityRetentionDays: envNumber(
      process.env.MARFA_ACTIVITY_RETENTION_DAYS,
      14,
    ),
    activityPurgeIntervalMs: envNumber(
      process.env.MARFA_ACTIVITY_PURGE_INTERVAL_MS,
      3_600_000,
    ),
    auditCleanupIntervalMs: envNumber(
      process.env.AUDIT_CLEANUP_INTERVAL_MS,
      86_400_000,
    ),
    eventLogRetentionHours: parseEventLogRetentionHours(
      process.env.MARFA_EVENT_LOG_RETENTION_HOURS,
    ),
    eventLogCleanupIntervalMs: envNumber(
      process.env.MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS,
      3_600_000,
    ),
    versionThinningIntervalMs: envNumber(
      process.env.VERSION_THINNING_INTERVAL_MS,
      3_600_000,
    ),
    versionRecentDays: envNumber(process.env.VERSION_RECENT_DAYS, 30),
    versionDailySnapshotDays: envNumber(
      process.env.VERSION_DAILY_SNAPSHOT_DAYS,
      90,
    ),
    versionWeeklySnapshotDays: envNumber(
      process.env.VERSION_WEEKLY_SNAPSHOT_DAYS,
      365,
    ),
    versionMaxVersions: envNumber(process.env.VERSION_MAX_VERSIONS, 500),
    trashRetentionDays: envNumber(process.env.TRASH_RETENTION_DAYS, 60),
    trashPurgeIntervalMs: envNumber(
      process.env.TRASH_PURGE_INTERVAL_MS,
      86_400_000,
    ),
    authSessionCleanupIntervalMs: envNumber(
      process.env.AUTH_SESSION_CLEANUP_INTERVAL_MS,
      3_600_000,
    ),
    dcrClientRetentionDays: envNumber(
      process.env.MARFA_DCR_CLIENT_RETENTION_DAYS,
      30,
    ),
    dcrClientCleanupIntervalMs: envNumber(
      process.env.MARFA_DCR_CLIENT_CLEANUP_INTERVAL_MS,
      86_400_000,
    ),
    accountDeletionGraceDays: envNumber(
      process.env.MARFA_ACCOUNT_DELETION_GRACE_DAYS,
      30,
    ),
    accountDeletionPurgeIntervalMs: envNumber(
      process.env.MARFA_ACCOUNT_DELETION_PURGE_INTERVAL_MS,
      3_600_000,
    ),
    rateLimitCleanupIntervalMs: envNumber(
      process.env.MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS,
      3_600_000,
    ),
    enrichmentEnabled: process.env.MARFA_ENRICHMENT_ENABLED !== "false",
    enrichmentIntervalMs: envNumber(
      process.env.MARFA_ENRICHMENT_INTERVAL_MS,
      30_000,
    ),
    enrichmentBatchSize: envNumber(process.env.MARFA_ENRICHMENT_BATCH_SIZE, 8),
    enrichmentItemTimeoutMs: envNumber(
      process.env.MARFA_ENRICHMENT_ITEM_TIMEOUT_MS,
      60_000,
    ),
    enrichmentMaxBlobBytes: envNumber(
      process.env.MARFA_ENRICHMENT_MAX_BLOB_BYTES,
      20 * 1024 * 1024,
    ),
    enrichmentMaxTextChars: envNumber(
      process.env.MARFA_ENRICHMENT_MAX_TEXT_CHARS,
      200_000,
    ),
    enrichmentMaxAttempts: envNumber(
      process.env.MARFA_ENRICHMENT_MAX_ATTEMPTS,
      3,
    ),
    enrichmentOcrEnabled: process.env.MARFA_ENRICHMENT_OCR_ENABLED !== "false",
    enrichmentTessdataDir:
      process.env.MARFA_ENRICHMENT_TESSDATA_DIR ?? "./data/tessdata",
    runtimeCredentialReaperIntervalMs: envNumber(
      process.env.MARFA_RUNTIME_CREDENTIAL_REAPER_INTERVAL_MS,
      3_600_000,
    ),
    connectionUpgradeIntervalMs: envNumber(
      process.env.MARFA_CONNECTION_UPGRADE_INTERVAL_MS,
      3_600_000,
    ),
    bulkActionJobRetentionMs: envNumber(
      process.env.MARFA_BULK_ACTION_JOB_RETENTION_MS,
      7 * 24 * 3_600_000,
    ),
    bulkActionJobGcIntervalMs: envNumber(
      process.env.MARFA_BULK_ACTION_JOB_GC_INTERVAL_MS,
      3_600_000,
    ),
    bulkActionPollIntervalMs: envNumber(
      process.env.MARFA_BULK_ACTION_POLL_INTERVAL_MS,
      500,
    ),
    bulkActionPollMaxIntervalMs: envNumber(
      process.env.MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS,
      60_000,
    ),
    bulkActionPollBackoffMultiplier: envNumber(
      process.env.MARFA_BULK_ACTION_POLL_BACKOFF_MULTIPLIER,
      2,
    ),
    errorWebhookUrl: process.env.ERROR_WEBHOOK_URL ?? "",
    errorWebhookTimeoutMs: envNumber(
      process.env.MARFA_ERROR_WEBHOOK_TIMEOUT_MS,
      5000,
    ),
    // Parse + validate at startup. Malformed CIDRs throw — we want bad
    // config to surface immediately, not silently degrade.
    trustedProxyCidrs: parseTrustedProxyCidrs(process.env.TRUSTED_PROXY_CIDRS),
    authBaseUrl:
      process.env.MARFA_AUTH_BASE_URL ?? `http://localhost:${String(port)}`,
    authAllowSignup: process.env.MARFA_AUTH_ALLOW_SIGNUP === "true",
    mcpEnabled: process.env.MARFA_MCP_ENABLED !== "false",
    mcpToolsets: process.env.MARFA_MCP_TOOLSETS,
    seedStarterContent: process.env.MARFA_SEED_STARTER_CONTENT === "true",
    authSecret,
    oidcProviders: parseOidcProviders(process.env.MARFA_OIDC_PROVIDERS),
    rateLimitDefaultLimit: envNumber(process.env.RATE_LIMIT_REQUESTS, 1000),
    rateLimitWindowMs: envNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitAggregateMultiplier: envNumber(
      process.env.RATE_LIMIT_AGGREGATE_MULTIPLIER,
      4,
    ),
    defaultQuotaItems: parseQuotaEnv(process.env.MARFA_DEFAULT_QUOTA_ITEMS),
    defaultQuotaWebhooks: parseQuotaEnv(
      process.env.MARFA_DEFAULT_QUOTA_WEBHOOKS,
    ),
    defaultQuotaBlobs: parseQuotaEnv(process.env.MARFA_DEFAULT_QUOTA_BLOBS),
    defaultQuotaStorageBytes: parseQuotaEnv(
      process.env.MARFA_DEFAULT_QUOTA_STORAGE_BYTES,
    ),
    defaultQuotaRatePerMinute: parseQuotaEnv(
      process.env.MARFA_DEFAULT_QUOTA_RATE_PER_MINUTE,
    ),
    emailBackend: parseEmailBackend(process.env.MARFA_EMAIL_BACKEND),
    emailFrom: process.env.MARFA_EMAIL_FROM ?? "",
    emailReplyTo: process.env.MARFA_EMAIL_REPLY_TO ?? "",
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    cloudflareEmailApiToken: process.env.CLOUDFLARE_EMAIL_API_TOKEN ?? "",
    smtpHost: process.env.MARFA_SMTP_HOST ?? "",
    smtpPort: envNumber(process.env.MARFA_SMTP_PORT, 587),
    smtpUser: process.env.MARFA_SMTP_USER ?? "",
    smtpPass: process.env.MARFA_SMTP_PASS ?? "",
    smtpSecure: process.env.MARFA_SMTP_SECURE === "true",
    integrationWorkerThreads: parseIntegrationWorkerThreads(
      process.env.MARFA_INTEGRATION_WORKER_THREADS,
    ),
    otelEnabled: process.env.MARFA_OTEL_ENABLED === "true",
    otelServiceName: process.env.OTEL_SERVICE_NAME ?? "marfa-server",
    otelEnvironment: process.env.MARFA_OTEL_ENVIRONMENT,
    otelTracesEndpoint:
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "",
    otelLogsEndpoint:
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "",
    otelHeaders: parseOtelHeaders(
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
        process.env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
    otelSampleRatio: parseOtelSampleRatio(process.env.MARFA_OTEL_SAMPLE_RATIO),
    heartbeatUrl: process.env.MARFA_HEARTBEAT_URL ?? "",
    heartbeatIntervalMs: envNumber(
      process.env.MARFA_HEARTBEAT_INTERVAL_MS,
      60_000,
    ),
    dbStartupWaitMs: envNumber(process.env.MARFA_DB_STARTUP_WAIT_MS, 90_000),
    sseMaxViewers: parseSseMaxViewers(process.env.MARFA_SSE_MAX_VIEWERS),
  };
}

/**
 * Refuses to boot on a value that is not a non-negative integer.
 * `envNumber` would resolve garbage to NaN, and `NaN > 0` is false, so
 * a typo would silently switch a stated viewer ceiling OFF — the exact
 * fail-open the worker-threads parser refuses for the same reason.
 */
export function parseSseMaxViewers(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `MARFA_SSE_MAX_VIEWERS must be a non-negative integer (0 = uncapped); got "${raw}"`,
    );
  }
  return Number(trimmed);
}

/**
 * Parse `MARFA_INTEGRATION_WORKER_THREADS`. Unset → undefined, which
 * keeps the executor's own default. Anything that is not a positive
 * integer throws at boot rather than warning: a NaN or zero pool size
 * would pre-warm no worker threads and leave every dispatch waiting on
 * a slot that never comes, a hang far harder to read than a refusal
 * naming the variable.
 */
export function parseIntegrationWorkerThreads(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  // Plain digits only, not Number()'s grammar: "1e2" parses to 100 and
  // would silently pre-warm a hundred threads per integration, each with
  // its own memory budget — the surprise this parser exists to refuse.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `MARFA_INTEGRATION_WORKER_THREADS must be a positive integer, got "${raw}".`,
    );
  }
  const n = Number(trimmed);
  if (n < 1) {
    throw new Error(
      `MARFA_INTEGRATION_WORKER_THREADS must be a positive integer, got "${raw}".`,
    );
  }
  return n;
}

/**
 * Parses `MARFA_EMAIL_BACKEND`. Unset / unknown → `none` (the
 * fail-loud-on-send default). Legal values: `cloudflare | smtp | none`.
 */
function parseEmailBackend(
  raw: string | undefined,
): "cloudflare" | "smtp" | "none" {
  if (raw === "cloudflare" || raw === "smtp" || raw === "none") return raw;
  if (raw && raw.length > 0) {
    console.warn(
      `Unknown MARFA_EMAIL_BACKEND=${raw}; falling back to "none". ` +
        `Legal values: cloudflare | smtp | none.`,
    );
  }
  return "none";
}

function parseOidcProviders(raw: string | undefined): OidcProviderConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn(
        "MARFA_OIDC_PROVIDERS must be a JSON array, falling back to no federated providers",
      );
      return [];
    }
    const out: OidcProviderConfig[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { providerId?: unknown }).providerId === "string" &&
        typeof (entry as { clientId?: unknown }).clientId === "string" &&
        typeof (entry as { clientSecret?: unknown }).clientSecret === "string"
      ) {
        const e = entry as Record<string, unknown>;
        out.push({
          providerId: e.providerId as string,
          clientId: e.clientId as string,
          clientSecret: e.clientSecret as string,
          discoveryUrl:
            typeof e.discoveryUrl === "string" ? e.discoveryUrl : undefined,
          scopes: Array.isArray(e.scopes)
            ? (e.scopes as unknown[]).filter(
                (s): s is string => typeof s === "string",
              )
            : undefined,
        });
      } else {
        console.warn(
          "MARFA_OIDC_PROVIDERS entry missing providerId/clientId/clientSecret, skipping",
        );
      }
    }
    return out;
  } catch {
    console.warn(
      "MARFA_OIDC_PROVIDERS is not valid JSON, falling back to no federated providers",
    );
    return [];
  }
}
