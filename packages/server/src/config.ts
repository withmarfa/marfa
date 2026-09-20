import { DEFAULT_MAX_STRING_LENGTH } from "@withmarfa/shared";
import type { PermissionBundle } from "@withmarfa/shared";
import { buildDefaultPermissionBundles } from "./auth/default-bundles.js";
import {
  parseTrustedProxyCidrs,
  parseTrustedProxyHeader,
} from "./middleware/client-ip.js";
import type { CidrRange } from "./middleware/client-ip.js";

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

export interface AppConfig {
  /** True when `NODE_ENV === "production"`. Gates production-only
   *  hardenings (e.g. CORS localhost auto-reflection is dev-only).
   *  Optional on the type so test contexts constructing `AppConfig`
   *  literals don't have to supply it; readers treat `undefined` as
   *  non-production. `loadConfig` always populates it. */
  isProduction?: boolean;
  port: number;
  sqlitePath: string;
  /** The disk store: where every upload lands. Always present. */
  blobPath: string;
  /** Maximum request body size in bytes for the JSON write surface. Bodies
   *  exceeding this are rejected with HTTP 413 `request_too_large` by the
   *  global `bodyLimit` middleware. The blob upload route is exempt and has
   *  no cap: its body streams to disk.
   *  Read from `MARFA_MAX_REQUEST_BYTES`; default 1MB. */
  maxRequestBytes: number;
  /** Maximum request body size in bytes for the bulk write endpoints
   *  (`/items/bulk*`, `/edges/bulk`), which carry up to 5000 items/edges in a
   *  single body and so need a larger cap than the per-request default. Read
   *  from `MARFA_MAX_BULK_REQUEST_BYTES`; default 16MB. Optional — falls back
   *  to the 16MB default when unset. */
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
  /** Key prefix the object store keeps its objects under (`S3_PREFIX`,
   *  default `blobs`), so one bucket can carry the database's replica
   *  beside the bytes, or several instances' drills. Optional on the type
   *  for the same reason as `s3ForcePathStyle`. */
  s3Prefix?: string;
  apiKeySalt: string;
  corsOrigins: string[];
  /** Named consent-screen permission bundles (see `DEFAULT_PERMISSION_BUNDLES`).
   *  Overridable via `MARFA_PERMISSION_BUNDLES`. Optional on the type so test
   *  contexts that construct AppConfig literals compile; `loadConfig` always
   *  populates it, and readers fall back to `getPermissionBundles()`. */
  permissionBundles?: PermissionBundle[];
  rateLimitEnabled: boolean;
  enableHsts: boolean;
  auditRetentionDays: number;
  auditCleanupIntervalMs: number;
  /** Days a `system.activity` item survives before the purger drops it.
   *  Default 14; env override `MARFA_ACTIVITY_RETENTION_DAYS`; instance-config
   *  override `activity_retention_days`. `0` disables the job.
   *
   *  A connector reports every run as an activity row, including the
   *  runs that found nothing to do, so this is the fastest-growing item
   *  type on an instance with connections and nothing aged it out before.
   *
   *  Optional on the type because a dozen test contexts build
   *  `AppConfig` literals, and a required field with
   *  a sensible default would churn every one of them to say what the
   *  default already says. */
  activityRetentionDays?: number;
  /** Days a revoked application-grant tombstone survives before the purger
   *  drops it. Default 90; env override `MARFA_REVOKED_GRANT_RETENTION_DAYS`.
   *  `0` disables the job.
   *
   *  **Ninety rather than a number of its own, and matching
   *  `AUDIT_RETENTION_DAYS` on purpose.** The tombstone and the audit row that
   *  recorded the revocation are the same fact written twice, so keeping them
   *  for different lengths would let the two disagree about whether a
   *  revocation is still visible.
   *
   *  They accumulate because the grant lookup skips a revoked row, which makes
   *  a soft-delete permanent rather than reusable: every revoke-then-reconnect
   *  cycle leaves one behind and nothing swept them. */
  revokedGrantRetentionDays?: number;
  /** Days an app grant may go unused before it is retired: the grant
   *  cascade runs and an `auth.grant.retired` row is written. Default 365;
   *  env override `MARFA_GRANT_INACTIVITY_DAYS`; `0` disables. */
  grantInactivityDays?: number;
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
  /** Cadence (ms) for the unreferenced-blob sweep. A full pass over the
   *  item corpus and the version history, so this is deliberately slow:
   *  default 86_400_000 (24h); env override
   *  `MARFA_BLOB_CLEANUP_INTERVAL_MS`. Optional on the type; `index.ts`
   *  applies the 24h fallback. */
  blobCleanupIntervalMs?: number;
  /** How long (ms) a blob has to have been registered before the sweep
   *  will consider it unreferenced. Registering a blob and creating the
   *  item that names it are two calls, so a window between them is normal
   *  rather than a leak, and this is how much of one the sweep tolerates.
   *  `0` disables the job. Default 86_400_000 (24h); env override
   *  `MARFA_BLOB_CLEANUP_GRACE_MS`. */
  blobCleanupGraceMs?: number;
  /** Cadence (ms) for the `rate_limit_windows` GC sweep that drops rows
   *  past their `expires_at`. Default 3_600_000 (1h); env override
   *  `MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS`. Optional — `index.ts`
   *  applies the 1h fallback when unset. */
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
  /** Extracted text is truncated to this many characters. Defaults to the
   *  validator's own default string ceiling, because text longer than that
   *  is a value the write path refuses; env override
   *  `MARFA_ENRICHMENT_MAX_TEXT_CHARS`. Raising it past the ceiling is
   *  allowed and is not silently clamped: the sweeper validates before it
   *  writes, so an over-long extraction is parked rather than stored. */
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
  /** Header the platform's edge overwrites with the client address, for
   *  platforms whose edge has no pinnable CIDR. Null means unset. Takes
   *  precedence over `trustedProxyCidrs`. Optional on the type for the same
   *  reason as `s3ForcePathStyle`. See middleware/client-ip.ts. */
  trustedProxyHeader?: string | null;
  /** Issuer URL the better-auth instance is reached at — protocol + host
   *  (and port). Drives cookie domains and the OAuth issuer field on the
   *  discovery doc. Defaults to `http://localhost:<port>` if unset. */
  authBaseUrl: string;
  /** Shared secret for cookie signing. Required in production; falls back
   *  to a per-process ephemeral secret in dev. */
  authSecret: string;
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
   * OpenTelemetry configuration. The instrumentation bootstrap
   * (`src/instrumentation.ts`) reads its toggle + exporter config from the
   * environment directly because it must run before `loadConfig` (and
   * before any instrumented module loads). These fields exist so the rest
   * of the server can read the *resolved* OTel config from the single
   * config source — they are NOT the wiring path for the SDK itself.
   *
   * Default OFF, so nothing is exported and the SDK is never loaded unless
   * an operator asks for it with `MARFA_OTEL_ENABLED=true`.
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
   *  A deployment exporting to PostHog leaves it unset — the trace pipeline
   *  is built but points at no store, because PostHog has no general-trace
   *  ingest, only logs and errors. */
  otelTracesEndpoint?: string;
  /** OTLP logs endpoint (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`). A deployment
   *  exporting to PostHog points this at
   *  `https://eu.i.posthog.com/i/v1/logs`. */
  otelLogsEndpoint?: string;
  /** Exporter headers parsed from `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`).
   *  Carries e.g. `Authorization=Bearer <phc_...>` for PostHog. */
  otelHeaders?: Record<string, string>;
  /** Baseline trace sample ratio (`MARFA_OTEL_SAMPLE_RATIO`, default 0.05).
   *  Errors export at 100% regardless — see `otel/error-aware-sampler.ts`. */
  otelSampleRatio?: number;
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
   *  how late a job runs after it falls due, and on how soon a wake is
   *  answered. Optional on the type; `index.ts` applies the default. */
  housekeepingPollIntervalMs?: number;
  /** Ceiling on concurrent SSE viewers per server instance
   *  (`MARFA_SSE_MAX_VIEWERS`, default 0 = uncapped). A deliberate
   *  memory bound: viewers hold no database connection, so any limit is
   *  a stated choice rather than a pool artifact. */
  sseMaxViewers?: number;
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

const DEFAULT_GRANT_INACTIVITY_DAYS = 365;

/** The inactivity window in days: `0` disables the retirement job; a value
 *  that is not a non-negative integer is refused with a warning and the
 *  default stands, because `Number("thirty")` is `NaN`, `NaN > 0` is false,
 *  and the job would otherwise be silently never built for an operator who
 *  believes it is running. */
export function parseGrantInactivityDays(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_GRANT_INACTIVITY_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `Invalid MARFA_GRANT_INACTIVITY_DAYS=${raw}, falling back to ${String(DEFAULT_GRANT_INACTIVITY_DAYS)}`,
    );
    return DEFAULT_GRANT_INACTIVITY_DAYS;
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
 * (e.g. `Authorization=Bearer abc123,X-Scope=acme`). Whitespace around
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
 * live in `auth/default-bundles.ts`. A deployment that registered custom
 * types under its own publisher handles gets those namespaces
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
 * keying on presence alone would drop the handle namespaces the runtime
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

export function loadConfig(): AppConfig {
  const corsRaw = process.env.CORS_ORIGINS ?? "";
  const apiKeySalt = process.env.API_KEY_SALT ?? DEFAULT_SALT;
  const authSecret = process.env.MARFA_AUTH_SECRET ?? "";
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
    // would fall back to a per-process random key, so a restart on a
    // scale-to-zero container leaves all prior ciphertexts
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
    sqlitePath: process.env.SQLITE_PATH ?? "./data/marfa.db",
    blobPath: process.env.BLOB_PATH ?? "./data/blobs",
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
    s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    s3Prefix: process.env.S3_PREFIX?.trim() ? process.env.S3_PREFIX : "blobs",
    apiKeySalt,
    corsOrigins: corsRaw ? corsRaw.split(",").map((s) => s.trim()) : [],
    permissionBundles: getPermissionBundles(),
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== "false",
    enableHsts: process.env.ENABLE_HSTS === "true",
    auditRetentionDays: envNumber(process.env.AUDIT_RETENTION_DAYS, 90),
    revokedGrantRetentionDays: envNumber(
      process.env.MARFA_REVOKED_GRANT_RETENTION_DAYS,
      90,
    ),
    grantInactivityDays: parseGrantInactivityDays(
      process.env.MARFA_GRANT_INACTIVITY_DAYS,
    ),
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
    rateLimitCleanupIntervalMs: envNumber(
      process.env.MARFA_RATE_LIMIT_CLEANUP_INTERVAL_MS,
      3_600_000,
    ),
    blobCleanupIntervalMs: envNumber(
      process.env.MARFA_BLOB_CLEANUP_INTERVAL_MS,
      86_400_000,
    ),
    blobCleanupGraceMs: envNumber(
      process.env.MARFA_BLOB_CLEANUP_GRACE_MS,
      86_400_000,
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
    // Derived, not restated. These were two independent constants that
    // happened not to match: enrichment truncated at 200_000 and the
    // validator refused anything over 100_000, so a long document was
    // extracted successfully onto an item that could never be written to
    // again.
    enrichmentMaxTextChars: envNumber(
      process.env.MARFA_ENRICHMENT_MAX_TEXT_CHARS,
      DEFAULT_MAX_STRING_LENGTH,
    ),
    enrichmentMaxAttempts: envNumber(
      process.env.MARFA_ENRICHMENT_MAX_ATTEMPTS,
      3,
    ),
    enrichmentOcrEnabled: process.env.MARFA_ENRICHMENT_OCR_ENABLED !== "false",
    enrichmentTessdataDir:
      process.env.MARFA_ENRICHMENT_TESSDATA_DIR ?? "./data/tessdata",
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
    trustedProxyHeader: parseTrustedProxyHeader(
      process.env.TRUSTED_PROXY_HEADER,
    ),
    authBaseUrl:
      process.env.MARFA_AUTH_BASE_URL ?? `http://localhost:${String(port)}`,
    authSecret,
    rateLimitDefaultLimit: envNumber(process.env.RATE_LIMIT_REQUESTS, 1000),
    rateLimitWindowMs: envNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitAggregateMultiplier: envNumber(
      process.env.RATE_LIMIT_AGGREGATE_MULTIPLIER,
      4,
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
    housekeepingPollIntervalMs: envNumber(
      process.env.MARFA_HOUSEKEEPING_POLL_INTERVAL_MS,
      1_000,
    ),
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
 * Parse a positive-integer environment variable. Unset or empty → undefined,
 * which keeps the consumer's own default. Anything else that is not a
 * positive integer throws at boot rather than warning.
 *
 * Plain digits only, not `Number()`'s grammar: "1e2" parses to 100, and a
 * sizing knob silently taking a hundred is the surprise this refuses.
 */
export function parsePositiveIntegerEnv(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return Number(trimmed);
}
