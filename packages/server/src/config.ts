export interface AppConfig {
  port: number;
  storageDialect: "sqlite" | "pg";
  sqlitePath: string;
  databaseUrl: string;
  blobPath: string;
  blobBackend: "fs" | "s3";
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
}

const DEFAULT_SALT = "dev-salt-change-in-production";

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
  };
}
