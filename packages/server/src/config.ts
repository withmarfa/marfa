import type { PermissionBundle } from "@withmarfa/shared";
import { parseTrustedProxyCidrs } from "./middleware/client-ip.js";
import type { CidrRange } from "./middleware/client-ip.js";

/**
 * Numeric env-var read with explicit "missing or empty → default" semantics.
 *
 * The `Number(env) || default` shorthand silently swallows zero — operators
 * cannot disable a sub-job (e.g. set a retention to `0`) because `0` is
 * falsy and gets overridden by the default. This helper is the canonical
 * pattern for every numeric env read in the server: an undefined or empty
 * env var falls back to the default; any other value (including `0`,
 * negatives, or `NaN`) is honoured as written.
 *
 * If you need range/validity checking on top, parse explicitly (see
 * `parseEventLogRetentionHours` for an example with warnings on bad input).
 */
export function envNumber(raw: string | undefined, fallback: number): number {
  return raw !== undefined && raw !== "" ? Number(raw) : fallback;
}

export interface AppConfig {
  port: number;
  storageDialect: "sqlite" | "pg";
  sqlitePath: string;
  databaseUrl: string;
  blobPath: string;
  blobBackend: "fs" | "s3";
  /** Maximum blob upload size in bytes. Uploads exceeding this are rejected
   *  with HTTP 413 `blob_too_large`. Default: 50MB. */
  maxBlobSize: number;
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
  versionSnapshotIntervalMs: number;
  rateLimitEnabled: boolean;
  enableHsts: boolean;
  /**
   * When `true`, wraps each tenant-bounded Postgres request in a
   * transaction with `SET LOCAL ROLE marfa_app` and
   * `SET LOCAL marfa.tenant_id = '<id>'` so RLS policies enforce
   * tenant isolation at the DB layer (defense-in-depth beneath the
   * application-layer scoping). Defaults to `true`. See
   * `packages/server/CLAUDE.md` under "Postgres RLS".
   *
   * Optional on the type so test contexts that construct AppConfig
   * literals continue to compile.
   */
  rlsEnforce?: boolean;
  auditRetentionDays: number;
  auditCleanupIntervalMs: number;
  /** Hours an event_log entry survives before the cleanup job purges it.
   *  Default 168 (7 days). Controls how far back a client's SSE replay
   *  cursor can reach; requests with `Last-Event-ID` older than the
   *  oldest retained event get a terminal `catchup_too_old` event.
   *  Optional on the type so callers constructing `AppConfig` literals
   *  don't have to supply it; `index.ts` applies the 168 fallback. */
  eventLogRetentionHours?: number;
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
  /** How long a terminal `bulk_action_jobs` row survives before the GC
   *  sweep drops it. Counted against `finished_at`. Default 7 days; env
   *  override `MARFA_BULK_ACTION_JOB_RETENTION_MS`. Set to `0` to
   *  disable the sweep entirely (the table grows unbounded). */
  bulkActionJobRetentionMs?: number;
  /** Cadence (ms) for the `bulk_action_jobs` GC sweep. Default 3_600_000
   *  (1h); env override `MARFA_BULK_ACTION_JOB_GC_INTERVAL_MS`. */
  bulkActionJobGcIntervalMs?: number;
  errorWebhookUrl: string;
  /** Per-fetch timeout (ms) for error-webhook delivery in
   *  `middleware/error-notifier.ts`. Env override
   *  `MARFA_ERROR_WEBHOOK_TIMEOUT_MS`. Default 5000. Optional on the type
   *  so test contexts constructing `AppConfig` literals don't have to
   *  supply it; `loadConfig` always populates it. */
  errorWebhookTimeoutMs?: number;
  /** Per-fetch timeout (ms) for the reactive-run bridge's Cloudflare
   *  Queues producer call. Env override `MARFA_REACTIVE_RUN_SEND_TIMEOUT_MS`.
   *  Default 5000. Threaded into `BridgeConfig.sendTimeoutMs` at bridge
   *  construction so operators can tune it for real Queues latency.
   *  Optional on the type for the same reason as `errorWebhookTimeoutMs`. */
  reactiveRunSendTimeoutMs?: number;
  /** Pre-parsed CIDR list for opt-in `x-forwarded-for` trust. Empty
   *  means "no proxy trusted; ignore the header". See middleware/client-ip.ts. */
  trustedProxyCidrs: CidrRange[];
  /** Allow-list of `redirect_uri` values accepted by the connector OAuth
   *  bootstrap (`POST /connections/:id/oauth/start`). Comma-separated
   *  via `MARFA_OAUTH_REDIRECT_ALLOWLIST`. Empty list disables enforcement
   *  — convenient for self-hosted dev but an open-redirect risk in
   *  hosted mode, so production deployments must set this. */
  oauthRedirectAllowlist: string[];
  /** Issuer URL the better-auth instance is reached at — protocol + host
   *  (and port). Drives cookie domains and the OAuth issuer field on the
   *  discovery doc. Defaults to `http://localhost:<port>` if unset. */
  authBaseUrl: string;
  /** When `true`, the email + password sign-up endpoint is enabled.
   *  Default `false` — single-user self-hosted instances enable this
   *  only for the initial admin account. */
  authAllowSignup: boolean;
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
  /** Deployed-build identifier, surfaced on `GET /` as `version`. Filled
   *  by `index.ts` from `version.json` at startup; defaults to `"dev"`
   *  when no version file is present (local development). The committed
   *  OpenAPI spec keeps a separate, semantically-distinct
   *  API-contract version. */
  versionSha?: string;
  /**
   * Default per-tenant quota ceilings. NULL = unlimited (no enforcement).
   * Each is read from a corresponding env var (`MARFA_DEFAULT_QUOTA_*`);
   * per-tenant overrides via `tenant_quotas` rows take precedence.
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
   * Integration runtime substrate. `"hosted"` runs against the
   * Cloudflare control plane + per-Integration Workers (set
   * `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` + `CLOUDFLARE_QUEUES_API_TOKEN`).
   * `"local"` runs the in-process Node substrate (`pg-boss` for
   * scheduling, `worker_thread` pool for handler execution); requires
   * Postgres.
   *
   * Defaults to `"local"` — fresh self-host `docker compose up` works
   * without a Cloudflare account. Hosted Marfa deployments + any
   * operator that wants the Cloudflare path sets the env var explicitly
   * to `"hosted"`.
   *
   * Optional on the type so test contexts constructing `AppConfig`
   * literals don't have to supply it; `index.ts` applies the
   * `"local"` fallback.
   */
  integrationRuntime?: "hosted" | "local";
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
 * (e.g. `Authorization=Bearer abc123,X-Tenant=acme`). Whitespace around
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
 * The default four consent-screen permission bundles. Each renders as one
 * plain-language checkbox (all pre-ticked); the issued token carries the
 * concrete scopes the bundle expands to, enforced through the usual
 * permission maps.
 *
 * `read` / `write` use per-namespace wildcards covering the user's content
 * (`core.*`, `user.*`, `app.*`, and the integration namespaces) plus edges
 * and tags. They deliberately EXCLUDE `system.*` so an app signed into
 * "your stuff" can't read your security internals (credentials, devices,
 * webhooks); `user.*` is what makes an app work against its own runtime
 * types without those types appearing in the static scope allowlist. The
 * separate `connected` bundle grants read on `system.connection` /
 * `system.integration` only. Full `*:read` / `*:write` stays available via
 * the consent screen's "Customise" path, never by default.
 */
export const DEFAULT_PERMISSION_BUNDLES: PermissionBundle[] = [
  {
    id: "read",
    label: "Read your stuff",
    description: "See your items, tags, files, and how they connect.",
    scopes: [
      "core.*:read",
      "user.*:read",
      "app.*:read",
      "google.*:read",
      "raindrop.*:read",
      "readwise.*:read",
      "todoist.*:read",
      "withmarfa.*:read",
      "edge.*:read",
      "metadata:read",
    ],
    default_on: true,
  },
  {
    id: "write",
    label: "Write your stuff",
    description:
      "Create, change, and organize your data — and let the app set up the data types it needs.",
    scopes: [
      "core.*:write",
      "user.*:write",
      "app.*:write",
      "google.*:write",
      "raindrop.*:write",
      "readwise.*:write",
      "todoist.*:write",
      "withmarfa.*:write",
      "edge.*:write",
      "metadata:write",
      "metadata.types:write",
      "metadata.edge_types:write",
    ],
    default_on: true,
  },
  {
    id: "profile",
    label: "Your profile",
    description: "See and update your name and account details.",
    scopes: ["openid", "profile", "email"],
    default_on: true,
  },
  {
    id: "connected",
    label: "Connected services",
    description:
      "See the outside services connected to your space, like Google.",
    scopes: ["system.connection:read", "system.integration:read"],
    default_on: true,
  },
];

/**
 * Parse the operator override `MARFA_PERMISSION_BUNDLES` (a JSON array of
 * `PermissionBundle`). Falls back to {@link DEFAULT_PERMISSION_BUNDLES} on
 * absent, non-array, or malformed input — a bad override must never strand
 * the consent screen with zero bundles.
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
    const valid = parsed.every(
      (b): b is PermissionBundle =>
        typeof b === "object" &&
        b !== null &&
        typeof (b as PermissionBundle).id === "string" &&
        Array.isArray((b as PermissionBundle).scopes),
    );
    if (!valid) {
      console.warn(
        "MARFA_PERMISSION_BUNDLES has malformed entries; using defaults.",
      );
      return DEFAULT_PERMISSION_BUNDLES;
    }
    return parsed;
  } catch (err) {
    console.warn(
      `Failed to parse MARFA_PERMISSION_BUNDLES (${String(err)}); using defaults.`,
    );
    return DEFAULT_PERMISSION_BUNDLES;
  }
}

/** Resolve the active permission bundles from the environment. */
export function getPermissionBundles(): PermissionBundle[] {
  return loadPermissionBundles(process.env.MARFA_PERMISSION_BUNDLES);
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
    port,
    storageDialect: process.env.DB_DIALECT === "pg" ? "pg" : "sqlite",
    sqlitePath: process.env.SQLITE_PATH ?? "./data/marfa.db",
    databaseUrl: process.env.DATABASE_URL ?? "",
    blobPath: process.env.BLOB_PATH ?? "./data/blobs",
    blobBackend: process.env.BLOB_BACKEND === "s3" ? "s3" : "fs",
    maxBlobSize: envNumber(process.env.MAX_BLOB_SIZE, 50 * 1024 * 1024),
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
    versionSnapshotIntervalMs: envNumber(
      process.env.VERSION_SNAPSHOT_INTERVAL_MS,
      600_000,
    ),
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== "false",
    enableHsts: process.env.ENABLE_HSTS === "true",
    // RLS enforces by default; explicit opt-out is `MARFA_RLS_ENFORCE=false`.
    // SQLite is unaffected — the middleware skips when `storage.pgDb` is
    // undefined regardless of this flag.
    rlsEnforce: process.env.MARFA_RLS_ENFORCE !== "false",
    auditRetentionDays: envNumber(process.env.AUDIT_RETENTION_DAYS, 90),
    auditCleanupIntervalMs: envNumber(
      process.env.AUDIT_CLEANUP_INTERVAL_MS,
      86_400_000,
    ),
    eventLogRetentionHours: parseEventLogRetentionHours(
      process.env.MARFA_EVENT_LOG_RETENTION_HOURS,
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
    bulkActionJobRetentionMs: envNumber(
      process.env.MARFA_BULK_ACTION_JOB_RETENTION_MS,
      7 * 24 * 3_600_000,
    ),
    bulkActionJobGcIntervalMs: envNumber(
      process.env.MARFA_BULK_ACTION_JOB_GC_INTERVAL_MS,
      3_600_000,
    ),
    errorWebhookUrl: process.env.ERROR_WEBHOOK_URL ?? "",
    errorWebhookTimeoutMs: envNumber(
      process.env.MARFA_ERROR_WEBHOOK_TIMEOUT_MS,
      5000,
    ),
    reactiveRunSendTimeoutMs: envNumber(
      process.env.MARFA_REACTIVE_RUN_SEND_TIMEOUT_MS,
      5000,
    ),
    // Parse + validate at startup. Malformed CIDRs throw — we want bad
    // config to surface immediately, not silently degrade.
    trustedProxyCidrs: parseTrustedProxyCidrs(process.env.TRUSTED_PROXY_CIDRS),
    oauthRedirectAllowlist: parseOauthRedirectAllowlist(
      process.env.MARFA_OAUTH_REDIRECT_ALLOWLIST,
    ),
    authBaseUrl:
      process.env.MARFA_AUTH_BASE_URL ?? `http://localhost:${String(port)}`,
    authAllowSignup: process.env.MARFA_AUTH_ALLOW_SIGNUP === "true",
    authSecret,
    oidcProviders: parseOidcProviders(process.env.MARFA_OIDC_PROVIDERS),
    rateLimitDefaultLimit: envNumber(process.env.RATE_LIMIT_REQUESTS, 1000),
    rateLimitWindowMs: envNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
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
    integrationRuntime: parseIntegrationRuntime(
      process.env.MARFA_INTEGRATION_RUNTIME,
    ),
    otelEnabled: process.env.MARFA_OTEL_ENABLED === "true",
    otelServiceName: process.env.OTEL_SERVICE_NAME ?? "marfa-server",
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
  };
}

/**
 * Parse `MARFA_INTEGRATION_RUNTIME`. Unset → `"local"` — fresh
 * self-hosters using `docker compose up` pick up the Node substrate
 * without needing a Cloudflare account. Hosted Marfa + any deployment
 * that wants the Cloudflare path sets the env var explicitly to
 * `"hosted"`. Unknown values warn and fall back to `"local"` so a
 * typo doesn't silently start the wrong substrate.
 */
export function parseIntegrationRuntime(
  raw: string | undefined,
): "hosted" | "local" {
  if (raw === "hosted" || raw === "local") return raw;
  if (raw && raw.length > 0) {
    console.warn(
      `Unknown MARFA_INTEGRATION_RUNTIME=${raw}; falling back to "local". ` +
        `Legal values: hosted | local.`,
    );
  }
  return "local";
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

/**
 * Parse `MARFA_OAUTH_REDIRECT_ALLOWLIST` — comma-separated list of
 * fully-qualified `redirect_uri` values accepted by the connector OAuth
 * bootstrap. Whitespace between entries is tolerated. Empty / unset
 * means "no allow-list" (validation is bypassed; see oauth-callback.ts).
 */
export function parseOauthRedirectAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
