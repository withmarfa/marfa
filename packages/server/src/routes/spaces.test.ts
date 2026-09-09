import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
import { spaceRoutes } from "./spaces.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

const SALT = "test-salt";

// The default createTestContext() runs in `authMode: "keys"`, which does
// not wire up `storage.spaces`. The handler-level fallback paths are
// covered with that context; the happy-path space-scoped routes need a
// hosted-mode app, built inline below.
interface HostedContext {
  app: Hono<AppEnv>;
  storage: Storage;
  platformAdminKey: string;
  spaceAdminKey: string;
  spaceId: string;
  cleanup: () => Promise<void>;
}

async function createHostedContext(): Promise<HostedContext> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-spaces-test-"));
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
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: SALT,
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "hosted",
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
    seedStarterContent: false,
    authSecret: "test-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    mcpEnabled: false,
  });

  const suffix = Math.random().toString(36).slice(2, 10);
  const platformAdminKey = `marfa_k1_platform_quotas_${suffix}`;
  const spaceAdminKey = `marfa_k1_space_cfg_${suffix}`;

  // Create the space row first (required for FK under hosted-mode pg).
  const space = await storage.spaces!.create();
  const spaceId = space.id;

  await storage.keys.create(
    {
      label: "platform-quotas-admin",
      source: `platform-quotas-${suffix}`,
      is_operator: true,
      type_permissions: {},
      default_tier: "feed",
    },
    hashApiKey(platformAdminKey, SALT),
  );

  await storage.keys.create(
    {
      label: "space-cfg-admin",
      source: `space-cfg-${suffix}`,
      space_permissions: [...SPACE_PERMISSIONS],
      type_permissions: {},
      default_tier: "feed",
    },
    hashApiKey(spaceAdminKey, SALT),
    spaceId,
  );
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    platformAdminKey,
    spaceAdminKey,
    spaceId,
    cleanup: async () => {
      if (pgCleanup) {
        await pgCleanup();
      } else {
        await storage.close();
      }
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

describe("GET /spaces/me/config — keys-mode fallback", () => {
  it("requires admin — 401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/spaces/me/config");
    expect(res.status).toBe(401);
  });

  it("returns {} for a non-space-scoped admin (no space store)", async () => {
    // The bootstrap test admin has no space_id, and authMode is "keys"
    // so storage.spaces is undefined. The handler short-circuits to {}.
    const res = await request(ctx.app, "GET", "/spaces/me/config", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });
});

describe("PUT /spaces/me/config — keys-mode fallback", () => {
  it("requires admin — 401 without credentials", async () => {
    const res = await request(ctx.app, "PUT", "/spaces/me/config", {
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-space-scoped credential with 400 VALIDATION_ERROR", async () => {
    const res = await request(ctx.app, "PUT", "/spaces/me/config", {
      key: ctx.spaceKey,
      body: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});

// ----- Hosted-mode context: exercises the space store happy paths -------
describe("Space config — hosted mode", () => {
  let hosted: HostedContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  it("GET returns stored config for a space-scoped admin", async () => {
    expect(hosted.storage.spaces).toBeDefined();
    await hosted.storage.spaces!.updateConfig(hosted.spaceId, {
      enforcement: { strict_mode: { types: ["core.note"] } },
    });

    const res = await request(hosted.app, "GET", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enforcement?: { strict_mode?: { types: string[] } };
    };
    expect(body.enforcement?.strict_mode?.types).toEqual(["core.note"]);
  });

  it("PUT rejects a negative cleanup-job override with 400", async () => {
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: {
        audit_retention_days: -1,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("PUT persists the activity retention override rather than discarding it", async () => {
    // The purger already fans out per space on this field, so a value the
    // route accepts and drops is worse than one it refuses: PUT is a full
    // replacement, so following the documentation un-sets the neighbours.
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { activity_retention_days: 30, trash_retention_days: 7 },
    });
    expect(res.status).toBe(200);

    const getRes = await request(hosted.app, "GET", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
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
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { activity_retention_days: -1 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  // The destructive shape. PUT is a full replacement, so a key the schema
  // did not know used to be dropped and the request answered 200 having
  // erased everything the space had set. The test that existed round-tripped
  // a well-formed body and would pass either way.
  it("PUT refuses a mistyped key instead of dropping it", async () => {
    const good = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { activity_retention_days: 30, trash_retention_days: 7 },
    });
    expect(good.status).toBe(200);

    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { activity_retention_day: 30 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");

    // And the refusal left the space's config alone, which is the whole
    // point: the old behavior returned 200 with this now empty.
    const getRes = await request(hosted.app, "GET", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
    });
    const getBody = (await getRes.json()) as {
      activity_retention_days?: number;
      trash_retention_days?: number;
    };
    expect(getBody.activity_retention_days).toBe(30);
    expect(getBody.trash_retention_days).toBe(7);
  });

  // Documented in the shared type as admin-writable through this route, read
  // by the publish path, and absent from the route's schema until now, so the
  // one way it was documented to be set was the one way it could not be.
  // The outer object refusing an unknown key while the nested one accepts it
  // is the same defect one level down, and `.strict()` does not recurse.
  it("PUT refuses a mistyped key inside enforcement too", async () => {
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { enforcement: { strict_modes: { types: ["core.note"] } } },
    });
    expect(res.status).toBe(400);

    // And one level deeper again, inside a block that does exist.
    const deeper = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { enforcement: { strict_mode: { types: [], typo: 1 } } },
    });
    expect(deeper.status).toBe(400);
  });

  it("PUT refuses a hop budget past the ceiling", async () => {
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { max_event_hop_budget: 101 },
    });
    expect(res.status).toBe(400);

    // At the ceiling is fine. A bound nobody can reach is not a bound.
    const ok = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { max_event_hop_budget: 100 },
    });
    expect(ok.status).toBe(200);
  });

  it("PUT accepts the hop budget the event pipeline reads", async () => {
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { max_event_hop_budget: 9 },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { max_event_hop_budget?: number }).toEqual({
      max_event_hop_budget: 9,
    });

    const getRes = await request(hosted.app, "GET", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
    });
    expect(
      ((await getRes.json()) as { max_event_hop_budget?: number })
        .max_event_hop_budget,
    ).toBe(9);
  });

  it("PUT rejects a negative hop budget with 400", async () => {
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: { max_event_hop_budget: -1 },
    });
    expect(res.status).toBe(400);
  });

  it("PUT persists a valid config and records an audit entry", async () => {
    const config = {
      enforcement: { strict_mode: { types: ["core.note"] } },
      audit_retention_days: 45,
    };
    const res = await request(hosted.app, "PUT", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
      body: config,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof config;
    expect(body.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(body.audit_retention_days).toBe(45);

    // Round-trip: GET must return the persisted value.
    const getRes = await request(hosted.app, "GET", "/spaces/me/config", {
      key: hosted.spaceAdminKey,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as typeof config;
    expect(getBody.enforcement.strict_mode.types).toEqual(["core.note"]);
    expect(getBody.audit_retention_days).toBe(45);

    // Audit write is fire-and-forget — use the shared poll helper
    // instead of an inline retry.
    const auditResult = await waitForAudit(
      () =>
        hosted.storage.audit.list({
          action: "space.config.update",
          resource_id: hosted.spaceId,
        }),
      (r) => r.data.length >= 1,
    );
    expect(auditResult.data.length).toBeGreaterThanOrEqual(1);
    expect(auditResult.data[0]?.resource_type).toBe("space");
  });

  it("GET /spaces/:id/quotas returns not_found for an unknown space", async () => {
    const unknownSpaceId = "space_unknown_get";
    const res = await request(
      hosted.app,
      "GET",
      `/spaces/${unknownSpaceId}/quotas`,
      { key: hosted.platformAdminKey },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("PUT /spaces/:id/quotas returns not_found without creating an orphan quota row", async () => {
    const unknownSpaceId = "space_unknown_put";
    const res = await request(
      hosted.app,
      "PUT",
      `/spaces/${unknownSpaceId}/quotas`,
      {
        key: hosted.platformAdminKey,
        body: { items_limit: 10 },
      },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect(await hosted.storage.spaceQuotas.get(unknownSpaceId)).toBeNull();
  });

  it("PUT and GET /spaces/:id/quotas preserve the known-space happy path", async () => {
    const putRes = await request(
      hosted.app,
      "PUT",
      `/spaces/${hosted.spaceId}/quotas`,
      {
        key: hosted.platformAdminKey,
        body: { items_limit: 25 },
      },
    );
    expect(putRes.status).toBe(200);

    const getRes = await request(
      hosted.app,
      "GET",
      `/spaces/${hosted.spaceId}/quotas`,
      { key: hosted.platformAdminKey },
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { items_limit: number | null };
    expect(body.items_limit).toBe(25);
  });

  it("documents not_found on both explicit quota operations", () => {
    // The published and live specs intentionally filter platform-internal
    // operations, so inspect this route group's pre-finalization document.
    const spec = spaceRoutes(hosted.storage).getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "Space route test", version: "1" },
    });
    const quotaPath = spec.paths["/{id}/quotas"];
    if (!quotaPath) throw new Error("quota path missing from route document");

    expect(quotaPath.get?.responses).toHaveProperty("404");
    expect(quotaPath.put?.responses).toHaveProperty("404");
  });
});
