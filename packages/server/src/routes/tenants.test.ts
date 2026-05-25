import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import {
  createPgTestStorage,
  createTestContext,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { hashApiKey } from "../middleware/auth.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const SALT = "test-salt";

// The default createTestContext() runs in `authMode: "keys"`, which does
// not wire up `storage.tenants`. The handler-level fallback paths are
// covered with that context; the happy-path tenant-scoped routes need a
// hosted-mode app, built inline below.
interface HostedContext {
  app: Hono<AppEnv>;
  storage: Storage;
  tenantAdminKey: string;
  tenantId: string;
  cleanup: () => Promise<void>;
}

async function createHostedContext(): Promise<HostedContext> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-tenants-test-"));
  const blobPath = join(tmpDir, "blobs");

  let storage: Storage;
  let pgCleanup: (() => Promise<void>) | undefined;
  if (dialect === "pg") {
    const pg = await createPgTestStorage({ authMode: "hosted" });
    storage = pg.storage;
    pgCleanup = pg.cleanup;
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = await createSqliteStorage(dbPath, { authMode: "hosted" });
  }

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: dialect as "sqlite" | "pg",
    sqlitePath: "",
    databaseUrl: "",
    blobPath,
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
    authMode: "hosted",
    versionSnapshotIntervalMs: 600_000,
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
    authAllowSignup: true,
    authSecret: "test-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    oauthRedirectAllowlist: [],
  });

  const suffix = Math.random().toString(36).slice(2, 10);
  const tenantAdminKey = `myme_k1_tenant_cfg_${suffix}`;

  // Create the tenant row first (required for FK under hosted-mode pg).
  const tenant = await storage.tenants!.create();
  const tenantId = tenant.id;

  await storage.keys.create(
    {
      label: "tenant-cfg-admin",
      source: `tenant-cfg-${suffix}`,
      role: "admin",
      type_permissions: {},
      default_tier: "feed",
    },
    hashApiKey(tenantAdminKey, SALT),
    tenantId,
  );
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    tenantAdminKey,
    tenantId,
    cleanup: async () => {
      if (pgCleanup) {
        await pgCleanup();
      } else {
        await storage.close();
      }
    },
  };
}

// ----- Keys-mode context (default): validates fallback behaviour ---------
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /tenants/current/config — keys-mode fallback", () => {
  it("requires admin — 401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/tenants/current/config");
    expect(res.status).toBe(401);
  });

  it("returns {} for a non-tenant-scoped admin (no tenant store)", async () => {
    // The bootstrap test admin has no tenant_id, and authMode is "keys"
    // so storage.tenants is undefined. The handler short-circuits to {}.
    const res = await request(ctx.app, "GET", "/tenants/current/config", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });
});

describe("PUT /tenants/current/config — keys-mode fallback", () => {
  it("requires admin — 401 without credentials", async () => {
    const res = await request(ctx.app, "PUT", "/tenants/current/config", {
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-tenant-scoped credential with 400 VALIDATION_ERROR", async () => {
    const res = await request(ctx.app, "PUT", "/tenants/current/config", {
      key: ctx.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});

// ----- Hosted-mode context: exercises the tenant store happy paths -------
describe("Tenant config — hosted mode", () => {
  let hosted: HostedContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  it("GET returns stored config for a tenant-scoped admin", async () => {
    expect(hosted.storage.tenants).toBeDefined();
    await hosted.storage.tenants!.updateConfig(hosted.tenantId, {
      enforcement: { strict_mode: { types: ["core.note"] } },
    });

    const res = await request(hosted.app, "GET", "/tenants/current/config", {
      key: hosted.tenantAdminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enforcement?: { strict_mode?: { types: string[] } };
    };
    expect(body.enforcement?.strict_mode?.types).toEqual(["core.note"]);
  });

  it("PUT rejects a negative cleanup-job override with 400", async () => {
    const res = await request(hosted.app, "PUT", "/tenants/current/config", {
      key: hosted.tenantAdminKey,
      body: {
        audit_retention_days: -1,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("PUT persists a valid config and records an audit entry", async () => {
    const config = {
      enforcement: { strict_mode: { types: ["core.note"] } },
      audit_retention_days: 45,
    };
    const res = await request(hosted.app, "PUT", "/tenants/current/config", {
      key: hosted.tenantAdminKey,
      body: config,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof config;
    expect(body.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(body.audit_retention_days).toBe(45);

    // Round-trip: GET must return the persisted value.
    const getRes = await request(hosted.app, "GET", "/tenants/current/config", {
      key: hosted.tenantAdminKey,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as typeof config;
    expect(getBody.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(getBody.audit_retention_days).toBe(45);

    // T-079: audit side effect is fire-and-forget — use the shared
    // poll helper instead of an inline retry.
    const auditResult = await waitForAudit(
      () =>
        hosted.storage.audit.list({
          action: "tenant.config.update",
          resource_id: hosted.tenantId,
        }),
      (r) => r.data.length >= 1,
    );
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.resource_type).toBe("tenant");
  });
});
