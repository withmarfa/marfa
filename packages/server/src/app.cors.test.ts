import { describe, expect, it, afterEach } from "vitest";
import { createApp } from "./app.js";
import { CONTRACT_HEADER } from "./contract.js";
import { EXPOSED_RESPONSE_HEADERS } from "./openapi-finalize.js";
import { ensureInstanceId } from "./storage/instance-id.js";
import { createSqliteStorage } from "./storage/sqlite/index.js";
import { createBlobLayer } from "./storage/blob-layer.js";
import { Housekeeping } from "./housekeeping/scheduler.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Storage } from "./storage/interface.js";
import type { Hono } from "hono";
import type { AppEnv } from "./middleware/auth.js";

const SALT = "test-salt";
const ALLOWED_ORIGIN = "https://app.example.com";
const LOCALHOST_ORIGIN = "http://localhost:5173";

interface Ctx {
  app: Hono<AppEnv>;
  cleanup: () => Promise<void>;
}

// Build an app whose CORS config lists exactly one explicit origin and
// whose `isProduction` flag is the variable under test. The localhost
// origin probed below is deliberately NOT in `corsOrigins`, so the only
// thing that could echo it back is the dev-only auto-reflect.
async function buildCtx(isProduction: boolean): Promise<Ctx> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-cors-"));
  const storage: Storage = await createSqliteStorage(join(tmpDir, "test.db"));
  const blobs = await createBlobLayer(storage, {
    blobPath: join(tmpDir, "blobs"),
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
  });
  const instanceId = await ensureInstanceId(storage.settings);
  const app = createApp(
    storage,
    blobs,
    new Housekeeping(storage.housekeeping, { pollIntervalMs: 1_000 }),
    {
      isProduction,
      port: 0,
      sqlitePath: "",
      blobPath: join(tmpDir, "blobs"),
      maxRequestBytes: 1_048_576,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      apiKeySalt: SALT,
      corsOrigins: [ALLOWED_ORIGIN],
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
      errorWebhookUrl: "",
      trustedProxyCidrs: [],
      authBaseUrl: "http://localhost:0",
      authSecret: "test-auth-secret",
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
    },
    instanceId,
  );

  return {
    app,
    cleanup: async () => {
      try {
        await storage.close();
      } catch {
        // Best-effort.
      }
      // The directory holds this file's sqlite database and blob
      // root; nothing else removes it.
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

let ctx: Ctx | undefined;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = undefined;
  }
});

describe("CORS localhost auto-reflect gating", () => {
  it("reflects an arbitrary localhost origin in non-production", async () => {
    ctx = await buildCtx(false);
    const res = await ctx.app.request("/health", {
      headers: { Origin: LOCALHOST_ORIGIN },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      LOCALHOST_ORIGIN,
    );
  });

  it("does NOT reflect a localhost origin in production", async () => {
    ctx = await buildCtx(true);
    const res = await ctx.app.request("/health", {
      headers: { Origin: LOCALHOST_ORIGIN },
    });
    // The localhost origin is not in CORS_ORIGINS, so production must not
    // echo it back. The callback falls back to the first explicit origin
    // instead — never the attacker-supplied localhost value.
    expect(res.headers.get("access-control-allow-origin")).not.toBe(
      LOCALHOST_ORIGIN,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("still honors an explicitly listed origin in production", async () => {
    ctx = await buildCtx(true);
    const res = await ctx.app.request("/health", {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("exposes every header the chain sets to a page on another origin", async () => {
    ctx = await buildCtx(true);
    const res = await ctx.app.request("/health", {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const exposed = (res.headers.get("access-control-expose-headers") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase());
    // The one a generated client cannot work without, then the rest.
    expect(exposed).toContain(CONTRACT_HEADER.toLowerCase());
    for (const name of EXPOSED_RESPONSE_HEADERS) {
      expect(exposed).toContain(name.toLowerCase());
    }
  });
});
