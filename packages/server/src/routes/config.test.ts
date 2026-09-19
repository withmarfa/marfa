import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { createTestContext, request, waitForAudit } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { hashApiKey } from "../middleware/auth.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { PERMISSIONS } from "@withmarfa/shared";
import { writeInstanceConfig } from "../storage/instance-config.js";

const SALT = "test-salt";

// A second app built inline, so the config round trips run on a database
// the shared context does not share.
interface ConfigContext {
  app: Hono<AppEnv>;
  storage: Storage;
  operatorKey: string;
  workingKey: string;
  cleanup: () => Promise<void>;
}

async function createConfigContext(): Promise<ConfigContext> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-config-test-"));
  const blobPath = join(tmpDir, "blobs");

  const dbPath = join(tmpDir, "test.db");
  const storage = await createSqliteStorage(dbPath);

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const app = createApp(storage, blobBackend, {
    port: 0,
    sqlitePath: "",
    blobPath,
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: SALT,
    corsOrigins: [],
    cdnBaseUrl: "",
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
  });

  const suffix = Math.random().toString(36).slice(2, 10);
  const operatorKey = `marfa_k1_operator_quotas_${suffix}`;
  const workingKey = `marfa_k1_working_cfg_${suffix}`;

  await storage.keys.create(
    {
      label: "operator-quotas",
      source: `operator-quotas-${suffix}`,
      is_operator: true,
      type_permissions: {},
      default_tier: "feed",
    },
    hashApiKey(operatorKey, SALT),
  );

  await storage.keys.create(
    {
      label: "config-key",
      source: `config-key-${suffix}`,
      permissions: [...PERMISSIONS],
      type_permissions: {},
      default_tier: "feed",
    },
    hashApiKey(workingKey, SALT),
  );
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    operatorKey,
    workingKey,
    cleanup: async () => {
      await storage.close();
      // The directory holds this file's sqlite database and blob
      // root; nothing else removes it.
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ----- Keys-mode context (default): validates fallback behavior ---------
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /config — keys-mode fallback", () => {
  it("401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/config");
    expect(res.status).toBe(401);
  });

  it("returns {} when the config was never set", async () => {
    // An unset config reads as an empty object rather than as null, so a
    // client can merge into what it gets back without a null check.
    const res = await request(ctx.app, "GET", "/config", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });
});

describe("PUT /config — keys-mode fallback", () => {
  it("401 without credentials", async () => {
    const res = await request(ctx.app, "PUT", "/config", {
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("rejects the operator key", async () => {
    // The operator key is refused at the permission gate, because the
    // instance tier holds no permissions at all — running the
    // instance sits outside the permission model rather than above it.
    const res = await request(ctx.app, "PUT", "/config", {
      key: ctx.operatorKey,
      body: {},
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details?: { required_scope?: string } };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details?.required_scope).toBe("config.manage");
  });
});

// ----- A second context: the settings-backed round trips -------
describe("Instance config — round trips", () => {
  let configCtx: ConfigContext;

  beforeAll(async () => {
    configCtx = await createConfigContext();
  });

  afterAll(async () => {
    await configCtx.cleanup();
  });

  it("GET returns stored config for a caller holding config.manage", async () => {
    await writeInstanceConfig(configCtx.storage.settings, {
      enforcement: { strict_mode: { types: ["core.note"] } },
    });

    const res = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enforcement?: { strict_mode?: { types: string[] } };
    };
    expect(body.enforcement?.strict_mode?.types).toEqual(["core.note"]);
  });

  it("PUT rejects a negative cleanup-job override with 400", async () => {
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: {
        audit_retention_days: -1,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("PUT persists the activity retention override rather than discarding it", async () => {
    // The purger already reads this field, so a value the route accepts and
    // drops is worse than one it refuses: PUT is a full replacement, so
    // following the documentation un-sets the neighbours.
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { activity_retention_days: 30, trash_retention_days: 7 },
    });
    expect(res.status).toBe(200);

    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      activity_retention_days?: number;
      trash_retention_days?: number;
    };
    expect(getBody.activity_retention_days).toBe(30);
    expect(getBody.trash_retention_days).toBe(7);
  });

  it("PUT rejects a negative activity retention override with 400", async () => {
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { activity_retention_days: -1 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  // The destructive shape, and the reason the schema is strict. PUT is a
  // full replacement, so a key the schema does not know, dropped rather than
  // refused, answers 200 having erased everything the instance had set. A
  // round trip of a well-formed body passes either way, which is why the
  // case below sends a misspelling instead.
  it("PUT refuses a mistyped key instead of dropping it", async () => {
    const good = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { activity_retention_days: 30, trash_retention_days: 7 },
    });
    expect(good.status).toBe(200);

    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { activity_retention_day: 30 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");

    // And the refusal left the instance's config alone, which is the whole
    // point: the old behavior returned 200 with this now empty.
    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    const getBody = (await getRes.json()) as {
      activity_retention_days?: number;
      trash_retention_days?: number;
    };
    expect(getBody.activity_retention_days).toBe(30);
    expect(getBody.trash_retention_days).toBe(7);
  });

  // Documented in the shared type as writable through this route, read
  // by the publish path, and absent from the route's schema until now, so the
  // one way it was documented to be set was the one way it could not be.
  // The outer object refusing an unknown key while the nested one accepts it
  // is the same defect one level down, and `.strict()` does not recurse.
  it("PUT refuses a mistyped key inside enforcement too", async () => {
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { enforcement: { strict_modes: { types: ["core.note"] } } },
    });
    expect(res.status).toBe(400);

    // And one level deeper again, inside a block that does exist.
    const deeper = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { enforcement: { strict_mode: { types: [], typo: 1 } } },
    });
    expect(deeper.status).toBe(400);
  });

  it("PUT persists a valid config and records an audit entry", async () => {
    const config = {
      enforcement: { strict_mode: { types: ["core.note"] } },
      audit_retention_days: 45,
    };
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: config,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof config;
    expect(body.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(body.audit_retention_days).toBe(45);

    // Round-trip: GET must return the persisted value.
    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as typeof config;
    expect(getBody.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(getBody.audit_retention_days).toBe(45);

    // Audit write is fire-and-forget — use the shared poll helper
    // instead of an inline retry.
    const auditResult = await waitForAudit(
      () =>
        configCtx.storage.audit.list({
          action: "config.update",
        }),
      (r) => r.data.length >= 1,
    );
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.resource_type).toBe("config");
  });
});
