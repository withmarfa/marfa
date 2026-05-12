import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { hashApiKey } from "./auth.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Storage } from "../storage/interface.js";
import type { Hono } from "hono";
import type { AppEnv } from "./auth.js";

const SALT = "test-salt";

interface Ctx {
  app: Hono<AppEnv>;
  storage: Storage;
  adminKey: string;
  cleanup: () => void;
}

// Build an app with rate limiting ENABLED and an intentionally tiny
// per-window limit, so we can observe per-credential isolation in a
// handful of requests rather than thousands.
async function buildCtx(): Promise<Ctx> {
  // Rate-limit values now flow through AppConfig (single env-read site
  // lives in loadConfig). Set them directly on the literal below; the
  // middleware no longer reads process.env.
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-ratelimit-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"));
  const blobBackend = new FilesystemBlobBackend(join(tmpDir, "blobs"));
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: "sqlite",
    sqlitePath: "",
    databaseUrl: "",
    blobPath: join(tmpDir, "blobs"),
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: SALT,
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "keys",
    versionSnapshotIntervalMs: 600_000,
    rateLimitEnabled: true,
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
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:0",
    authAllowSignup: true,
    authSecret: "test-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 2,
    rateLimitWindowMs: 60_000,
    oauthRedirectAllowlist: [],
  });

  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = `myme_k1_rl_admin_${suffix}`;
  await storage.keys.create(
    {
      label: "rl-admin",
      source: `rl-admin-${suffix}`,
      role: "admin",
      type_permissions: { "*": "write" },
      default_tier: "feed",
    },
    hashApiKey(rawKey, SALT),
  );
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    adminKey: rawKey,
    cleanup: () => {
      void storage.close();
      delete process.env.RATE_LIMIT_REQUESTS;
      delete process.env.RATE_LIMIT_WINDOW_MS;
    },
  };
}

async function makeMemberKey(ctx: Ctx, label: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await ctx.app.request("/keys", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label,
      source: `${label}-${suffix}`,
      role: "member",
      default_origin: "user",
      default_tier: "feed",
      type_permissions: { "*": "read" },
      extension_permissions: {},
      edge_permissions: {},
    }),
  });
  const body = (await res.json()) as { key: string };
  return body.key;
}

let ctx: Ctx;

beforeAll(async () => {
  ctx = await buildCtx();
});

afterAll(() => {
  ctx.cleanup();
});

describe("rate-limit keying", () => {
  it("limits per credential, not per IP, for authenticated requests", async () => {
    // Two different member keys (so they have distinct credential ids).
    const keyA = await makeMemberKey(ctx, "rl-a");
    const keyB = await makeMemberKey(ctx, "rl-b");

    // Limit is 2/window on non-GET, default*2 on GET. Use GET /items which
    // resolves to limit=4. Issue 5 as key A — last one must 429.
    const hitA = async () =>
      ctx.app.request("/items", {
        headers: { Authorization: `Bearer ${keyA}` },
      });
    const hitB = async () =>
      ctx.app.request("/items", {
        headers: { Authorization: `Bearer ${keyB}` },
      });

    for (let i = 0; i < 4; i++) {
      const res = await hitA();
      expect(res.status).toBe(200);
    }
    const overflow = await hitA();
    expect(overflow.status).toBe(429);

    // Key B must NOT be limited — this is the per-credential property.
    // If keying were IP-based both keys would share the bucket and B
    // would also get 429.
    const bFirst = await hitB();
    expect(bFirst.status).toBe(200);
  });
});
