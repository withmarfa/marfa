export interface AppConfig {
  port: number;
  sqlitePath: string;
  blobPath: string;
  apiKeySalt: string;
  corsOrigins: string[];
}

export function loadConfig(): AppConfig {
  const corsRaw = process.env.CORS_ORIGINS ?? "";
  return {
    port: Number(process.env.PORT) || 8200,
    sqlitePath: process.env.SQLITE_PATH ?? "./data/myme.db",
    blobPath: process.env.BLOB_PATH ?? "./data/blobs",
    apiKeySalt: process.env.API_KEY_SALT ?? "dev-salt-change-in-production",
    corsOrigins: corsRaw ? corsRaw.split(",").map((s) => s.trim()) : [],
  };
}
