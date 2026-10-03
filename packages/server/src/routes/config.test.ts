import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { createApp } from "../app.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createBlobLayer } from "../storage/blob-layer.js";
import { Housekeeping } from "../housekeeping/scheduler.js";
import { hashApiKey } from "../middleware/auth.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { PERMISSIONS } from "@withmarfa/shared";
import {
  readInstanceConfig,
  writeInstanceConfig,
} from "../storage/instance-config.js";

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
  const instanceId = await ensureInstanceId(storage.settings);

  const blobs = await createBlobLayer(storage, {
    blobPath: blobPath,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
  });
  const app = createApp(
    storage,
    blobs,
    new Housekeeping(storage.housekeeping, { pollIntervalMs: 1_000 }),
    {
      port: 0,
      sqlitePath: "",
      blobPath,
      maxRequestBytes: 1_048_576,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      apiKeySalt: SALT,
      corsOrigins: [],
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

  const suffix = Math.random().toString(36).slice(2, 10);
  const operatorKey = `marfa_k1_operator_cfg_${suffix}`;
  const workingKey = `marfa_k1_working_cfg_${suffix}`;

  await storage.keys.create(
    {
      label: "operator-cfg",
      source: `operator-cfg-${suffix}`,
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

// ----- The shared context: the door's defaults when nothing is set -----
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /config", () => {
  it("401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/config");
    expect(res.status).toBe(401);
  });

  it("carries the identity alone when the config was never set", async () => {
    // An unset config reads as an object carrying only the instance's
    // identity, rather than as null, so a client can merge into what it gets
    // back without a null check.
    const res = await request(ctx.app, "GET", "/config", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["instance_id"]);
    expect(typeof body.instance_id).toBe("string");
  });
});

describe("PUT /config", () => {
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

  it("PUT persists the retention overrides rather than discarding them", async () => {
    // The housekeeping jobs read these fields, so a value the route accepts
    // and drops is worse than one it refuses: PUT is a full replacement, so
    // following the documentation un-sets the neighbors.
    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { audit_retention_days: 30, trash_retention_days: 7 },
    });
    expect(res.status).toBe(200);

    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      audit_retention_days?: number;
      trash_retention_days?: number;
    };
    expect(getBody.audit_retention_days).toBe(30);
    expect(getBody.trash_retention_days).toBe(7);
  });

  // The destructive shape, and the reason the schema is strict. PUT is a
  // full replacement, so a key the schema does not know, dropped rather than
  // refused, answers 200 having erased everything the instance had set. A
  // round trip of a well-formed body passes either way, which is why the
  // case below sends a misspelling instead.
  it("PUT refuses a mistyped key instead of dropping it", async () => {
    const good = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { audit_retention_days: 30, trash_retention_days: 7 },
    });
    expect(good.status).toBe(200);

    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { audit_retention_day: 30 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");

    // And the refusal left the instance's config alone, which is the whole
    // point: a refused body must not have been applied.
    const getRes = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    const getBody = (await getRes.json()) as {
      audit_retention_days?: number;
      trash_retention_days?: number;
    };
    expect(getBody.audit_retention_days).toBe(30);
    expect(getBody.trash_retention_days).toBe(7);
  });

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

    // instead of an inline retry.
    const auditResult = await configCtx.storage.audit.list({
      action: "config.update",
    });
    expect(auditResult.data.length >= 1).toBe(true);
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.resource_type).toBe("config");
  });

  it("takes back the body GET handed over, identity and all", async () => {
    // The use a full-replacement door is actually put to. `instance_id` is
    // in every read, so a client that reads, edits one lever and sends the
    // object back would be refused by the strict write schema if the field
    // were merely unknown to it — and the refusal would look like a typo.
    const read = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    const body = (await read.json()) as Record<string, unknown>;
    expect(typeof body.instance_id).toBe("string");

    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: { ...body, audit_retention_days: 31 },
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as Record<string, unknown>;
    expect(echoed.instance_id).toBe(body.instance_id);
    expect(echoed.audit_retention_days).toBe(31);

    // Read from the store, not from the door. `GET /config` spreads the
    // identity over whatever the configuration holds, so a copy persisted
    // into `instance_config` carrying the same value would be invisible on
    // the wire — and would then leave with the next body that omitted it,
    // which is the whole reason the identity lives elsewhere.
    expect(
      await readInstanceConfig(configCtx.storage.settings),
    ).not.toHaveProperty("instance_id");
  });

  it("refuses a body addressed to a different instance", async () => {
    // Dropping the field instead would answer 200 to a write meant for
    // somewhere else, which is what a backup script pointed at the wrong
    // host sends. The identity is not persisted either way, so the refusal
    // is the only thing that can carry the news.
    const before = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    const body = (await before.json()) as Record<string, unknown>;

    const res = await request(configCtx.app, "PUT", "/config", {
      key: configCtx.workingKey,
      body: {
        instance_id: "019537a0-7b80-7000-8000-000000000000",
        audit_retention_days: 7,
      },
    });
    expect(res.status).toBe(400);
    const error = (await res.json()) as {
      error: { code: string; details?: { errors?: { path: string }[] } };
    };
    expect(error.error.code).toBe("validation_error");
    expect(error.error.details?.errors?.[0]?.path).toBe("instance_id");

    // And it changed nothing, which is the half a status code cannot state.
    const after = await request(configCtx.app, "GET", "/config", {
      key: configCtx.workingKey,
    });
    expect(await after.json()).toEqual(body);
  });
});

it("rejects unsupported inbound horizons before saving and restarts at the supported boundaries", async () => {
  const ctx = await createTestContext();
  const scheduler = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 1000,
  });
  try {
    const accepted = await request(ctx.app, "PUT", "/config", {
      key: ctx.workingKey,
      body: {
        inbound_handled_retention_days: 36500,
        inbound_pending_retention_days: 36500,
      },
    });
    expect(accepted.status).toBe(200);
    for (const field of [
      "inbound_handled_retention_days",
      "inbound_pending_retention_days",
    ]) {
      const denied = await request(ctx.app, "PUT", "/config", {
        key: ctx.workingKey,
        body: { [field]: 36501 },
      });
      expect(denied.status).toBe(400);
    }
    const saved = (await (
      await request(ctx.app, "GET", "/config", { key: ctx.workingKey })
    ).json()) as {
      inbound_handled_retention_days: number;
      inbound_pending_retention_days: number;
    };
    expect(saved.inbound_handled_retention_days).toBe(36500);
    expect(saved.inbound_pending_retention_days).toBe(36500);
    await expect(
      ctx.storage.inbound.cleanup({ handledDays: 36500, pendingDays: 36500 }),
    ).resolves.toEqual({ deleted: 0, remaining: false });
    await expect(
      ctx.storage.inbound.cleanup({ handledDays: 0, pendingDays: 0 }),
    ).resolves.toEqual({ deleted: 0, remaining: false });
    const stamp = new Date().toISOString();
    await ctx.storage.housekeeping.upsert(
      "owned-boundary",
      2147483647,
      new Date(Date.parse(stamp) + 2147483647).toISOString(),
    );
    await (
      ctx.storage as Storage & {
        __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
      }
    ).__sqliteRun(
      "UPDATE housekeeping SET last_finished_at = ? WHERE name = ?",
      [stamp, "owned-boundary"],
    );
    scheduler.register({
      name: "owned-boundary",
      intervalMs: 2147483647,
      firstRunDelayMs: 0,
      run: () => Promise.resolve({ deleted: 0 }),
    });
    await expect(scheduler.start()).resolves.toBeUndefined();
    const row = (await ctx.storage.housekeeping.list()).find(
      (r) => r.name === "owned-boundary",
    );
    expect(row?.next_run_at).toBe(
      new Date(Date.parse(stamp) + 2147483647).toISOString(),
    );
  } finally {
    await scheduler.stop();
    await ctx.cleanup();
  }
});
