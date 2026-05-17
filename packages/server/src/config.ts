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
  cdnBaseUrl: string;
  authMode: "hosted" | "keys";
  versionSnapshotIntervalMs: number;
  rateLimitEnabled: boolean;
  enableHsts: boolean;
  /**
   * T-025 part 1: when `true`, the application connects to Postgres as
   * the `myme_app` role with `SET LOCAL myme.tenant_id = '<id>'` per
   * request, so RLS policies enforce tenant isolation at the DB layer
   * (defense-in-depth beneath the application-layer scoping). Default
   * `false` keeps existing single-tenant self-hosts unchanged.
   *
   * Part 1 (this commit) lands the schema scaffold (role, grants,
   * policies). The actual connection-pool wiring — wrapping every
   * request handler in a transaction with `SET LOCAL ROLE myme_app`
   * after auth — lands in T-025 part 2. Until then this flag is read
   * at startup and surfaced to operators but does not yet change
   * connection behaviour. Documented in `packages/server/CLAUDE.md`.
   *
   * Optional on the type so test contexts that construct AppConfig
   * literals continue to compile; defaults to `false`.
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
  /** T-097: cadence (ms) for the better-auth session cleanup sweep —
   *  drops `auth_session` rows whose `expires_at` has passed. Default
   *  3_600_000 (1h); env override `AUTH_SESSION_CLEANUP_INTERVAL_MS`.
   *  No retention-window knob — Better Auth itself owns the TTL.
   *
   *  Optional on the type so test contexts that construct AppConfig
   *  literals don't have to supply it; `index.ts` applies the 1h
   *  fallback. */
  authSessionCleanupIntervalMs?: number;
  /** T-116: grace window between `auth.account.delete_confirmed` and the
   *  hard-delete cascade. `0` disables the purger entirely. Env override
   *  `MYME_ACCOUNT_DELETION_GRACE_DAYS`. Default 30. */
  accountDeletionGraceDays?: number;
  /** T-116: cadence (ms) for the pending-delete purger sweep. Env
   *  override `MYME_ACCOUNT_DELETION_PURGE_INTERVAL_MS`. Default 1h. */
  accountDeletionPurgeIntervalMs?: number;
  /** T-026: cadence (ms) for the `rate_limit_windows` GC sweep that drops
   *  rows past their `expires_at`. Default 3_600_000 (1h); env override
   *  `MYME_RATE_LIMIT_CLEANUP_INTERVAL_MS`. Optional — `index.ts`
   *  applies the 1h fallback when unset. */
  rateLimitCleanupIntervalMs?: number;
  errorWebhookUrl: string;
  /** Pre-parsed CIDR list for opt-in `x-forwarded-for` trust. Empty
   *  means "no proxy trusted; ignore the header". See middleware/client-ip.ts. */
  trustedProxyCidrs: CidrRange[];
  /** Allow-list of `redirect_uri` values accepted by the connector OAuth
   *  bootstrap (`POST /connections/:id/oauth/start`). Comma-separated
   *  via `MYME_OAUTH_REDIRECT_ALLOWLIST`. Empty list disables enforcement
   *  — convenient for self-hosted dev but an open-redirect risk in
   *  hosted mode (T-010), so production deployments must set this. */
  oauthRedirectAllowlist: string[];
  /** Issuer URL the better-auth instance is reached at — protocol + host
   *  (and port). Drives cookie domains and the OAuth issuer field on the
   *  discovery doc. Defaults to `http://localhost:<port>` if unset. */
  authBaseUrl: string;
  /** When `true`, the email + password sign-up endpoint is enabled.
   *  Default `false` per workstream-1 sign-up policy — single-user
   *  self-hosted instances enable this only for the initial admin account. */
  authAllowSignup: boolean;
  /** Shared secret for cookie signing. Required in production; falls back
   *  to a per-process ephemeral secret in dev. */
  authSecret: string;
  /** Wave C PR2: explicit override for `requireEmailVerification`. When
   *  `undefined`, the auth layer auto-detects from the configured email
   *  transport (on for `cloudflare`/`smtp`, off for `none`/missing). When
   *  set, takes precedence over the auto-detect — primarily a test
   *  hook (env-driven config never sets it). */
  authRequireEmailVerification?: boolean;
  /** Federated OIDC providers (Google / GitHub / Authentik / etc.) wired
   *  into the generic-oauth plugin. Parsed from the `MYME_OIDC_PROVIDERS`
   *  env var (JSON array of `{ providerId, clientId, clientSecret,
   *  discoveryUrl?, scopes? }`). */
  oidcProviders: OidcProviderConfig[];
  /** Default per-credential rate limit, requests per `rateLimitWindowMs`
   *  window. Read from `RATE_LIMIT_REQUESTS` (default 1000). Wired through
   *  the rate-limit middleware so there's a single env-read site. */
  rateLimitDefaultLimit: number;
  /** Rate-limit window size in ms. Read from `RATE_LIMIT_WINDOW_MS`
   *  (default 60_000). The self-hosting docs were previously wrong about
   *  this being hard-coded; it's an env var. */
  rateLimitWindowMs: number;
  /** Deployed-build identifier, surfaced on `GET /` as `version`. Filled
   *  by `index.ts` from `version.json` at startup; defaults to `"dev"`
   *  when no version file is present (local development). The committed
   *  OpenAPI spec keeps a separate, semantically-distinct
   *  API-contract version. */
  versionSha?: string;
  /**
   * T-052 default per-tenant quota ceilings. NULL = unlimited (no
   * enforcement). Each is read from a corresponding env var
   * (`MYME_DEFAULT_QUOTA_*`); per-tenant overrides via
   * `tenant_quotas` rows take precedence. Optional on the type so
   * existing test contexts continue to compile.
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
   * - `emailFrom` — visible sender, e.g. `Myme <hello@mail.myme.so>`.
   *   For the Cloudflare backend the domain MUST end in `@mail.myme.so`
   *   (the verified Cloudflare Email sending domain) —
   *   `senderDomainCheck` enforces this at boot. Apex `myme.so` has
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
   * Integration runtime substrate (T-173 + T-174). `"hosted"` runs
   * against the Cloudflare control plane + per-Integration Workers
   * (set `CLOUDFLARE_QUEUES_REACTIVE_RUN_URL` +
   * `CLOUDFLARE_QUEUES_API_TOKEN`). `"local"` runs the in-process Node
   * substrate (`pg-boss` for scheduling, `worker_thread` pool for
   * handler execution); requires Postgres.
   *
   * Default flipped to `"local"` in T-174 so fresh self-host
   * `docker compose up` works without a Cloudflare account. Hosted
   * Myme deployments + any operator that wants the Cloudflare path
   * sets the env var explicitly to `"hosted"`.
   *
   * Optional on the type so test contexts constructing `AppConfig`
   * literals don't have to supply it; `index.ts` applies the
   * `"local"` fallback.
   */
  integrationRuntime?: "hosted" | "local";
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
 * Parses `MYME_EVENT_LOG_RETENTION_HOURS`. Unset → default (168 / 7 days).
 * Non-positive, non-integer, or unparseable values log a warning and fall
 * back to the default rather than throwing — cleanup is belt-and-braces
 * and we'd rather run the server with sensible retention than fail boot.
 * Exported for direct unit testing.
 */
/**
 * T-052: parses a quota env var. Returns null for unset / empty (the
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
      `Invalid MYME_EVENT_LOG_RETENTION_HOURS=${raw}, falling back to ${String(DEFAULT_EVENT_LOG_RETENTION_HOURS)}`,
    );
    return DEFAULT_EVENT_LOG_RETENTION_HOURS;
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const corsRaw = process.env.CORS_ORIGINS ?? "";
  const apiKeySalt = process.env.API_KEY_SALT ?? DEFAULT_SALT;

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
  }

  const port = envNumber(process.env.PORT, 8600);
  return {
    port,
    storageDialect: process.env.STORAGE_DIALECT === "pg" ? "pg" : "sqlite",
    sqlitePath: process.env.SQLITE_PATH ?? "./data/myme.db",
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
    cdnBaseUrl: process.env.CDN_BASE_URL ?? "",
    authMode: process.env.AUTH_MODE === "hosted" ? "hosted" : "keys",
    versionSnapshotIntervalMs: envNumber(
      process.env.VERSION_SNAPSHOT_INTERVAL_MS,
      600_000,
    ),
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== "false",
    enableHsts: process.env.ENABLE_HSTS === "true",
    // T-146: default flipped from `false` to `true`. RLS now enforces
    // by default; explicit opt-out is `MYME_RLS_ENFORCE=false`. The
    // SQLite dialect is unaffected — the middleware skips when
    // `storage.pgDb` is undefined regardless of this flag.
    rlsEnforce: process.env.MYME_RLS_ENFORCE !== "false",
    auditRetentionDays: envNumber(process.env.AUDIT_RETENTION_DAYS, 90),
    auditCleanupIntervalMs: envNumber(
      process.env.AUDIT_CLEANUP_INTERVAL_MS,
      86_400_000,
    ),
    eventLogRetentionHours: parseEventLogRetentionHours(
      process.env.MYME_EVENT_LOG_RETENTION_HOURS,
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
      process.env.MYME_ACCOUNT_DELETION_GRACE_DAYS,
      30,
    ),
    accountDeletionPurgeIntervalMs: envNumber(
      process.env.MYME_ACCOUNT_DELETION_PURGE_INTERVAL_MS,
      3_600_000,
    ),
    rateLimitCleanupIntervalMs: envNumber(
      process.env.MYME_RATE_LIMIT_CLEANUP_INTERVAL_MS,
      3_600_000,
    ),
    errorWebhookUrl: process.env.ERROR_WEBHOOK_URL ?? "",
    // Parse + validate at startup. Malformed CIDRs throw — we want bad
    // config to surface immediately, not silently degrade.
    trustedProxyCidrs: parseTrustedProxyCidrs(process.env.TRUSTED_PROXY_CIDRS),
    oauthRedirectAllowlist: parseOauthRedirectAllowlist(
      process.env.MYME_OAUTH_REDIRECT_ALLOWLIST,
    ),
    authBaseUrl:
      process.env.MYME_AUTH_BASE_URL ?? `http://localhost:${String(port)}`,
    authAllowSignup: process.env.MYME_AUTH_ALLOW_SIGNUP === "true",
    authSecret: process.env.MYME_AUTH_SECRET ?? "",
    oidcProviders: parseOidcProviders(process.env.MYME_OIDC_PROVIDERS),
    rateLimitDefaultLimit: envNumber(process.env.RATE_LIMIT_REQUESTS, 1000),
    rateLimitWindowMs: envNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    defaultQuotaItems: parseQuotaEnv(process.env.MYME_DEFAULT_QUOTA_ITEMS),
    defaultQuotaWebhooks: parseQuotaEnv(
      process.env.MYME_DEFAULT_QUOTA_WEBHOOKS,
    ),
    defaultQuotaBlobs: parseQuotaEnv(process.env.MYME_DEFAULT_QUOTA_BLOBS),
    defaultQuotaStorageBytes: parseQuotaEnv(
      process.env.MYME_DEFAULT_QUOTA_STORAGE_BYTES,
    ),
    defaultQuotaRatePerMinute: parseQuotaEnv(
      process.env.MYME_DEFAULT_QUOTA_RATE_PER_MINUTE,
    ),
    emailBackend: parseEmailBackend(process.env.MYME_EMAIL_BACKEND),
    emailFrom: process.env.MYME_EMAIL_FROM ?? "",
    emailReplyTo: process.env.MYME_EMAIL_REPLY_TO ?? "",
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    cloudflareEmailApiToken: process.env.CLOUDFLARE_EMAIL_API_TOKEN ?? "",
    smtpHost: process.env.MYME_SMTP_HOST ?? "",
    smtpPort: envNumber(process.env.MYME_SMTP_PORT, 587),
    smtpUser: process.env.MYME_SMTP_USER ?? "",
    smtpPass: process.env.MYME_SMTP_PASS ?? "",
    smtpSecure: process.env.MYME_SMTP_SECURE === "true",
    integrationRuntime: parseIntegrationRuntime(
      process.env.MYME_INTEGRATION_RUNTIME,
    ),
  };
}

/**
 * Parse `MYME_INTEGRATION_RUNTIME` (T-173 + T-174). Unset → `"local"` —
 * fresh self-hosters using `docker compose up` pick up the Node
 * substrate without needing a Cloudflare account. Hosted Myme + any
 * deployment that wants the Cloudflare path sets the env var
 * explicitly to `"hosted"`. Unknown values warn and fall back to the
 * default so a typo doesn't silently start the wrong substrate.
 *
 * Operator action when migrating from T-173 (default was `"hosted"`)
 * to T-174 (default is `"local"`): if your deployment relied on the
 * Cloudflare-side runtime AND your config did not set
 * `MYME_INTEGRATION_RUNTIME` explicitly, set it to `"hosted"` before
 * the upgrade. Existing Atlas plists / Cloudflare Containers configs
 * that already set the var explicitly are unaffected.
 */
export function parseIntegrationRuntime(
  raw: string | undefined,
): "hosted" | "local" {
  if (raw === "hosted" || raw === "local") return raw;
  if (raw && raw.length > 0) {
    console.warn(
      `Unknown MYME_INTEGRATION_RUNTIME=${raw}; falling back to "local". ` +
        `Legal values: hosted | local.`,
    );
  }
  return "local";
}

/**
 * Parses `MYME_EMAIL_BACKEND`. Unset / unknown → `none` (the
 * fail-loud-on-send default). Legal values: `cloudflare | smtp | none`.
 */
function parseEmailBackend(
  raw: string | undefined,
): "cloudflare" | "smtp" | "none" {
  if (raw === "cloudflare" || raw === "smtp" || raw === "none") return raw;
  if (raw && raw.length > 0) {
    console.warn(
      `Unknown MYME_EMAIL_BACKEND=${raw}; falling back to "none". ` +
        `Legal values: cloudflare | smtp | none.`,
    );
  }
  return "none";
}

/**
 * Parse `MYME_OAUTH_REDIRECT_ALLOWLIST` — comma-separated list of
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
        "MYME_OIDC_PROVIDERS must be a JSON array, falling back to no federated providers",
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
          "MYME_OIDC_PROVIDERS entry missing providerId/clientId/clientSecret, skipping",
        );
      }
    }
    return out;
  } catch {
    console.warn(
      "MYME_OIDC_PROVIDERS is not valid JSON, falling back to no federated providers",
    );
    return [];
  }
}
