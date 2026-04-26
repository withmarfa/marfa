import { parseTrustedProxyCidrs } from "./middleware/client-ip.js";
import type { CidrRange } from "./middleware/client-ip.js";

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
  /** Days an ambient (`library: false`) item survives before it's hard-
   *  deleted, regardless of state. `0` disables the job (the default). */
  ambientRetentionDays: number;
  ambientExpiryIntervalMs: number;
  errorWebhookUrl: string;
  /** Pre-parsed CIDR list for opt-in `x-forwarded-for` trust. Empty
   *  means "no proxy trusted; ignore the header". See middleware/client-ip.ts. */
  trustedProxyCidrs: CidrRange[];
  /**
   * Base URL of the ElectricSQL service this Myme instance proxies to
   * for `/sync/shapes/:family`. Empty string disables the route — fresh
   * deployments without Electric stay on the HTTP-only path.
   *
   * Per the deployment plan: `:8602` (active) points at `http://localhost:8603`,
   * `:8601` (mock) points at `http://localhost:8604`.
   */
  electricUrl: string;
  /** Hours an `Idempotency-Key` cache entry survives before the cleanup
   *  job purges it. Default 24h. */
  idempotencyRetentionHours: number;
  /** Idempotency cache cleanup interval in ms. Default 1h. */
  idempotencyCleanupIntervalMs: number;
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

  return {
    port: Number(process.env.PORT) || 8600,
    storageDialect: process.env.STORAGE_DIALECT === "pg" ? "pg" : "sqlite",
    sqlitePath: process.env.SQLITE_PATH ?? "./data/myme.db",
    databaseUrl: process.env.DATABASE_URL ?? "",
    blobPath: process.env.BLOB_PATH ?? "./data/blobs",
    blobBackend: process.env.BLOB_BACKEND === "s3" ? "s3" : "fs",
    maxBlobSize: Number(process.env.MAX_BLOB_SIZE) || 50 * 1024 * 1024,
    s3Bucket: process.env.S3_BUCKET ?? "",
    s3Region: process.env.S3_REGION ?? "us-east-1",
    s3Endpoint: process.env.S3_ENDPOINT ?? "",
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    apiKeySalt,
    corsOrigins: corsRaw ? corsRaw.split(",").map((s) => s.trim()) : [],
    cdnBaseUrl: process.env.CDN_BASE_URL ?? "",
    authMode: process.env.AUTH_MODE === "hosted" ? "hosted" : "keys",
    versionSnapshotIntervalMs:
      Number(process.env.VERSION_SNAPSHOT_INTERVAL_MS) || 600_000,
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== "false",
    enableHsts: process.env.ENABLE_HSTS === "true",
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS) || 90,
    auditCleanupIntervalMs:
      Number(process.env.AUDIT_CLEANUP_INTERVAL_MS) || 86_400_000,
    eventLogRetentionHours: parseEventLogRetentionHours(
      process.env.MYME_EVENT_LOG_RETENTION_HOURS,
    ),
    versionThinningIntervalMs:
      Number(process.env.VERSION_THINNING_INTERVAL_MS) || 3_600_000,
    versionRecentDays: Number(process.env.VERSION_RECENT_DAYS) || 30,
    versionDailySnapshotDays:
      Number(process.env.VERSION_DAILY_SNAPSHOT_DAYS) || 90,
    versionWeeklySnapshotDays:
      Number(process.env.VERSION_WEEKLY_SNAPSHOT_DAYS) || 365,
    versionMaxVersions: Number(process.env.VERSION_MAX_VERSIONS) || 500,
    trashRetentionDays:
      process.env.TRASH_RETENTION_DAYS !== undefined
        ? Number(process.env.TRASH_RETENTION_DAYS)
        : 60,
    trashPurgeIntervalMs:
      Number(process.env.TRASH_PURGE_INTERVAL_MS) || 86_400_000,
    ambientRetentionDays:
      process.env.AMBIENT_RETENTION_DAYS !== undefined
        ? Number(process.env.AMBIENT_RETENTION_DAYS)
        : 0,
    ambientExpiryIntervalMs:
      Number(process.env.AMBIENT_EXPIRY_INTERVAL_MS) || 86_400_000,
    errorWebhookUrl: process.env.ERROR_WEBHOOK_URL ?? "",
    // Parse + validate at startup. Malformed CIDRs throw — we want bad
    // config to surface immediately, not silently degrade.
    trustedProxyCidrs: parseTrustedProxyCidrs(process.env.TRUSTED_PROXY_CIDRS),
    electricUrl: process.env.ELECTRIC_URL ?? "",
    idempotencyRetentionHours:
      Number(process.env.IDEMPOTENCY_RETENTION_HOURS) || 24,
    idempotencyCleanupIntervalMs:
      Number(process.env.IDEMPOTENCY_CLEANUP_INTERVAL_MS) || 3_600_000,
  };
}
