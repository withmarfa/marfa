import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPgTestStorage,
  createTestContext,
  request,
  seedOauthBearer,
  waitForAudit,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Storage } from "../storage/interface.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createKey(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  key: string;
  source: string;
}> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: `subject-${suffix}`,
      source: `subject-${suffix}`,
      role: "member",
      default_tier: "feed",
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      ...overrides,
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    id: string;
    key: string;
    source: string;
  };
  return body;
}

describe("PATCH /keys/{id}", () => {
  it("updates label, permissions, and defaults in place", async () => {
    const { id, source } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: {
        label: "renamed",
        default_tier: "library",
        type_permissions: { "core.note": "write" },
        extension_permissions: { "my-app.prefs": "read" },
        edge_permissions: { "parent-of": "write" },
      },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.id).toBe(id);
    expect(updated.label).toBe("renamed");
    // source is immutable — it must not have changed
    expect(updated.source).toBe(source);
    expect(updated.role).toBe("member");
    expect(updated.default_tier).toBe("library");
    expect(updated.type_permissions).toEqual({ "core.note": "write" });
    expect(updated.extension_permissions).toEqual({ "my-app.prefs": "read" });
    expect(updated.edge_permissions).toEqual({ "parent-of": "write" });
  });

  it("leaves untouched fields alone on a partial patch", async () => {
    const { id } = await createKey({
      label: "before",
      default_tier: "feed",
      type_permissions: { "core.note": "read" },
    });

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: { label: "after" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.label).toBe("after");
    expect(updated.default_tier).toBe("feed");
    expect(updated.type_permissions).toEqual({ "core.note": "read" });
  });

  it("returns 403 for a non-admin caller", async () => {
    const { id } = await createKey();
    const { key: memberKey } = await createKey({
      label: "patcher-member",
      type_permissions: { "*": "read" },
    });

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: memberKey,
      body: { label: "nope" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when attempting to change the immutable `source`", async () => {
    const { id } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: { source: "something-else" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/source.*immutable/i);
  });

  it("returns 400 when attempting to change the immutable `role`", async () => {
    const { id } = await createKey();

    const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.adminKey,
      body: { role: "admin" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/role.*immutable/i);
  });

  it("returns 404 for an unknown key id", async () => {
    // Valid UUIDv7 shape, guaranteed not to exist in the store.
    const ghostId = "00000000-0000-7000-8000-000000000000";
    const res = await request(ctx.app, "PATCH", `/keys/${ghostId}`, {
      key: ctx.adminKey,
      body: { label: "ghost" },
    });
    expect(res.status).toBe(404);
  });
});

describe("bootstrap sentinel", () => {
  // Builds a fresh app with NO existing key and NO sentinel set —
  // mirrors a brand-new installation. Dialect-aware: under
  // PG: cloned from the test-template, so tables are empty and the
  // `bootstrapped` sentinel isn't set — bootstrap path can fire cleanly.
  // SQLite: fresh tmp DB. Cannot use `createTestContext` because that
  // pre-creates an admin key and stamps the bootstrapped sentinel.
  async function freshApp(): Promise<{
    app: ReturnType<typeof createApp>;
    storage: Storage;
  }> {
    const dialect = process.env.DB_DIALECT ?? "sqlite";
    let storage: Storage;
    let blobPath: string;
    if (dialect === "pg") {
      const pg = await createPgTestStorage();
      storage = pg.storage;
      // pg.cleanup leaks here intentionally — `freshApp` doesn't have
      // a returned-cleanup contract with its callers; the leaked clone
      // is mopped up by the next test-run's dropStaleClones pass.
      const tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-pg-"));
      blobPath = join(tmpDir, "blobs");
    } else {
      const tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-"));
      storage = await createSqliteStorage(join(tmpDir, "test.db"));
      blobPath = join(tmpDir, "blobs");
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
      apiKeySalt: "test-salt",
      corsOrigins: [],
      cdnBaseUrl: "",
      authMode: "keys",
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
      seedStarterContent: false,
      authSecret: "test-auth-secret",
      oidcProviders: [],
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
      oauthRedirectAllowlist: [],
    });
    return { app, storage };
  }

  it("admits the first unauthenticated POST /keys as bootstrap", async () => {
    const { app, storage } = await freshApp();
    try {
      const res = await request(app, "POST", "/keys", {
        body: {
          label: "first-admin",
          source: "first-admin",
          role: "member",
          default_tier: "feed",
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { role: string; id: string };
      // Bootstrap key is coerced to admin regardless of requested role.
      expect(body.role).toBe("admin");
      // Sentinel must now be stamped.
      const stamped = await storage.settings.get("bootstrapped");
      expect(stamped).toBe("true");

      // Bootstrap mint emits the distinct `key.bootstrap` action, not
      // `key.create`, so operators can identify the first-mint event
      // in audit logs without ambiguity.
      const audits = await waitForAudit(
        () => storage.audit.list({ action: "key.bootstrap" }),
        (r) => r.data.some((row) => row.resource_id === body.id),
      );
      const row = audits.data.find((r) => r.resource_id === body.id);
      expect(row).toBeTruthy();
      expect(row?.action).toBe("key.bootstrap");
      expect(row?.resource_type).toBe("key");
      // Bootstrap mint has no calling credential — `key_id` is null.
      expect(row?.key_id).toBeNull();

      // Negative: no `key.create` row for this id.
      const createRows = await storage.audit.list({ action: "key.create" });
      expect(createRows.data.some((r) => r.resource_id === body.id)).toBe(
        false,
      );
    } finally {
      await storage.close();
    }
  });

  it("a rejected body does not burn the one-shot bootstrap claim", async () => {
    // The sentinel claim is irreversible. If a request that can never
    // mint consumed it, a single stray field would lock a brand-new
    // instance out of bootstrap permanently.
    const { app, storage } = await freshApp();
    try {
      const rejected = await request(app, "POST", "/keys", {
        body: {
          label: "stray-field",
          source: "stray-field",
          tenant_id: "some-tenant",
        },
      });
      expect(rejected.status).toBe(400);
      expect(await storage.settings.get("bootstrapped")).toBeNull();

      // Bootstrap still available to the corrected request.
      const retry = await request(app, "POST", "/keys", {
        body: { label: "first-admin", source: "first-admin" },
      });
      expect(retry.status).toBe(201);
      expect(await storage.settings.get("bootstrapped")).toBe("true");
    } finally {
      await storage.close();
    }
  });

  it("admin-issued POST /keys emits `key.create`, not `key.bootstrap`", async () => {
    // Self-contained — bootstrap a fresh app, then use the bootstrap
    // admin to mint a second key on the now-closed (non-bootstrap)
    // branch. Avoids depending on the shared `ctx` because freshApp()
    // tests under PG truncate the shared container, which would wipe
    // the ctx's admin key and sentinel between tests.
    const { app, storage } = await freshApp();
    try {
      const bootstrapRes = await request(app, "POST", "/keys", {
        body: {
          label: "bootstrap-admin",
          source: "bootstrap-admin",
          type_permissions: { "*": "write" },
        },
      });
      expect(bootstrapRes.status).toBe(201);
      const bootstrap = (await bootstrapRes.json()) as {
        id: string;
        key: string;
      };

      // Second POST authenticated as the bootstrap admin — this is the
      // non-bootstrap branch (sentinel is now stamped).
      const followUpRes = await request(app, "POST", "/keys", {
        key: bootstrap.key,
        body: {
          label: "routine-admin-mint",
          source: "routine-admin-mint",
          role: "member",
          default_tier: "feed",
          type_permissions: { "core.note": "read" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(followUpRes.status).toBe(201);
      const followUp = (await followUpRes.json()) as { id: string };

      const audits = await waitForAudit(
        () => storage.audit.list({ action: "key.create" }),
        (r) => r.data.some((row) => row.resource_id === followUp.id),
      );
      const row = audits.data.find((r) => r.resource_id === followUp.id);
      expect(row).toBeTruthy();
      expect(row?.action).toBe("key.create");
      expect(row?.resource_type).toBe("key");
      // Caller is the bootstrap admin — `key_id` is its id.
      expect(row?.key_id).toBe(bootstrap.id);

      // Negative: no `key.bootstrap` row for the second-mint id.
      const bootstrapRows = await storage.audit.list({
        action: "key.bootstrap",
      });
      expect(
        bootstrapRows.data.some((r) => r.resource_id === followUp.id),
      ).toBe(false);
    } finally {
      await storage.close();
    }
  });

  it("does NOT re-open bootstrap after every key is revoked", async () => {
    const { app, storage } = await freshApp();
    try {
      // First unauthenticated POST succeeds as bootstrap.
      const firstRes = await request(app, "POST", "/keys", {
        body: {
          label: "first-admin",
          source: "first-admin",
          role: "member",
          default_tier: "feed",
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(firstRes.status).toBe(201);
      const { id: firstId } = (await firstRes.json()) as { id: string };

      // Revoke every key.
      await storage.keys.revoke(firstId);

      // Next unauthenticated POST must be rejected — this is the
      // regression the persistent sentinel prevents.
      const secondRes = await request(app, "POST", "/keys", {
        body: {
          label: "takeover",
          source: "takeover",
          role: "member",
          default_tier: "feed",
          type_permissions: { "*": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(secondRes.status).toBe(401);
    } finally {
      await storage.close();
    }
  });

  it("concurrent unauthenticated POST /keys mints exactly one admin key", async () => {
    const { app, storage } = await freshApp();
    try {
      const N = 8;
      const bodies = Array.from({ length: N }, (_, i) => ({
        label: `race-${String(i)}`,
        source: `race-${String(i)}`,
        type_permissions: { "*": "write" },
      }));
      const results = await Promise.all(
        bodies.map((body) => request(app, "POST", "/keys", { body })),
      );
      const statuses = results.map((r) => r.status);
      const successes = statuses.filter((s) => s === 201).length;
      const unauthorized = statuses.filter((s) => s === 401).length;
      expect(successes).toBe(1);
      expect(unauthorized).toBe(N - 1);

      // Sentinel must be stamped exactly once.
      const stamped = await storage.settings.get("bootstrapped");
      expect(stamped).toBe("true");

      // Only one key persisted in the store.
      const keys = await storage.keys.list();
      expect(keys.length).toBe(1);
      expect(keys[0]?.role).toBe("admin");
    } finally {
      await storage.close();
    }
  });

  // The following assertions exercise SQLite-specific introspection
  // (`__sqliteAll`, `runSqliteMigrations`). The PG side is exercised by
  // the production server boot path under `DB_DIALECT=pg` and by the
  // SCHEMA_SQL diff itself; running these on PG would require parallel
  // PG-flavored queries for marginal additional coverage.
  const SKIP_SQLITE_ONLY = (process.env.DB_DIALECT ?? "sqlite") !== "sqlite";

  it.skipIf(SKIP_SQLITE_ONLY)(
    "bootstrap stamps __drizzle_migrations so a follow-up migrate is a no-op (sqlite)",
    async () => {
      const { storage } = (await freshApp()) as unknown as {
        storage: Awaited<ReturnType<typeof createSqliteStorage>>;
      };
      try {
        const rows = (await storage.__sqliteAll(
          "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC",
        )) as { hash: string; created_at: number }[];
        // At least one stamped row exists, hashes are non-empty, timestamps
        // are positive — the row shape Drizzle's migrator writes after each
        // applied migration. Drizzle's skip-decision is "if any row's
        // created_at >= migration.folderMillis, skip", so a single row with
        // the latest timestamp would suffice; we stamp every entry to keep
        // the table identical to a normally-migrated DB.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
        expect(rows.every((r) => r.created_at > 0)).toBe(true);
      } finally {
        await storage.close();
      }
    },
  );

  it.skipIf(SKIP_SQLITE_ONLY)(
    "bootstrap then `pnpm migrate` is a no-op — no DROP errors (sqlite)",
    async () => {
      // Bootstrap a fresh DB at a known path, close it, then drive Drizzle's
      // migrate runner against the same path. Pre-fix, the runner replays
      // 0000 → latest and several DROP/ALTER migrations error against
      // tables / objects the bootstrap shape never had. Post-fix the runner
      // sees stamped rows and short-circuits.
      const tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-migrate-"));
      const dbPath = join(tmpDir, "bootstrap-then-migrate.db");
      const storage = await createSqliteStorage(dbPath);
      const before = (await storage.__sqliteAll(
        "SELECT COUNT(*) AS n FROM __drizzle_migrations",
      )) as { n: number }[];
      const beforeCount = before[0]?.n ?? 0;
      expect(beforeCount).toBeGreaterThan(0);
      await storage.close();

      const { runSqliteMigrations } = await import("../storage/migrate.js");
      await expect(runSqliteMigrations(dbPath)).resolves.toBeUndefined();

      const reopened = await createSqliteStorage(dbPath);
      try {
        const after = (await reopened.__sqliteAll(
          "SELECT COUNT(*) AS n FROM __drizzle_migrations",
        )) as { n: number }[];
        expect(after[0]?.n ?? 0).toBe(beforeCount);
      } finally {
        await reopened.close();
      }
    },
  );

  it.skipIf(SKIP_SQLITE_ONLY)(
    "bootstrap creates idx_api_keys_connection_id (sqlite)",
    async () => {
      const { storage } = (await freshApp()) as unknown as {
        storage: Awaited<ReturnType<typeof createSqliteStorage>>;
      };
      try {
        const indexes = (await storage.__sqliteAll(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_api_keys_connection_id'",
        )) as { name: string }[];
        expect(indexes.length).toBe(1);

        // EXPLAIN must show the index is consulted on the runtime-credential
        // lookup path. SQLite's planner reports `USING INDEX <name>` when it
        // chooses an index; partial indexes need the WHERE predicate to match
        // for the planner to pick them.
        const plan = (await storage.__sqliteAll(
          "EXPLAIN QUERY PLAN SELECT * FROM api_keys WHERE connection_id = 'x'",
        )) as { detail: string }[];
        const usesIndex = plan.some((row) =>
          row.detail.includes("idx_api_keys_connection_id"),
        );
        expect(usesIndex).toBe(true);
      } finally {
        await storage.close();
      }
    },
  );
});

describe("POST /keys — OAuth caller block (T-344)", () => {
  // An OAuth app granted only `openid` but whose user is a tenant_admin
  // must NOT be able to mint a full, non-scope-enforced API key — that
  // would escalate a narrow grant past the consent/scope model. Read and
  // management reach via the role projection stays intact.
  let hostedCtx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    hostedCtx = await createTestContext({ authMode: "hosted" });
    const tenant = await hostedCtx.storage.tenants!.create("oauth-keys-space");
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await hostedCtx.cleanup();
  });

  it("rejects an OAuth token (tenant_admin user) from minting a key", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, ["openid"], {
      userRole: "tenant_admin",
      tenantId,
    });
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "exfil",
        source: "exfil",
        role: "tenant_admin",
        type_permissions: { "*": "write" },
      },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("forbidden");
  });

  it("rejects an OAuth token (admin user) from minting a key", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, ["openid"], {
      userRole: "admin",
      tenantId,
    });
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "x", source: "x", role: "tenant_admin" },
    });
    expect(res.status).toBe(403);
  });

  it("still lets an OAuth tenant_admin token READ keys (intended reach preserved)", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, ["openid"], {
      userRole: "tenant_admin",
      tenantId,
    });
    const res = await request(hostedCtx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(200);
  });

  it("still lets an API-key tenant_admin mint a key (block keys on authType, not role)", async () => {
    const raw = "marfa_k1_ta_" + Math.random().toString(36).slice(2);
    await hostedCtx.storage.keys.create(
      {
        label: "ta-key",
        source: "ta-key",
        role: "tenant_admin",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      tenantId,
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: raw,
      body: { label: "minted", source: "minted", role: "member" },
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /keys — tenant binding", () => {
  // `POST /keys` mints into the caller's tenant. A platform admin has no
  // tenant, so a `tenant_admin` / `member` key minted from one lands
  // tenant-less: NULL tenant is the universal "platform tier / all
  // tenants" signal to the RLS policies and to the storage layer's tenant
  // predicate, while those two roles skip or narrow the permission maps.
  // Composed, the credential reads and writes across every tenant while
  // looking tenant-scoped. The mint has to refuse.
  let hostedCtx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    hostedCtx = await createTestContext({ authMode: "hosted" });
    const tenant = await hostedCtx.storage.tenants!.create("tenant-binding");
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await hostedCtx.cleanup();
  });

  it("rejects a tenant_admin mint from a platform admin with no tenant", async () => {
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: "null-tenant-admin",
        source: "null-tenant-admin",
        role: "tenant_admin",
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("validation_error");
    // The message must name the route that does the tenant-scoped mint,
    // otherwise the caller's only recourse is to guess.
    expect(err.error.message).toMatch(/POST \/admin\/tenants\/\{id\}\/keys/);
  });

  it("rejects a member mint from a platform admin with no tenant", async () => {
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: "null-tenant-member",
        source: "null-tenant-member",
        role: "member",
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("validation_error");
  });

  it("still lets a platform admin mint a platform-tier admin key", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `platform-${suffix}`,
        source: `platform-${suffix}`,
        role: "admin",
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.role).toBe("admin");
    expect(stored?.tenant_id ?? null).toBeNull();
  });

  it("still lets a tenant-bound admin mint into its own tenant", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `marfa_k1_bound_admin_${suffix}`;
    await hostedCtx.storage.keys.create(
      {
        label: `bound-admin-${suffix}`,
        source: `bound-admin-${suffix}`,
        role: "tenant_admin",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      tenantId,
    );

    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: raw,
      body: {
        label: `child-${suffix}`,
        source: `child-${suffix}`,
        role: "member",
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.tenant_id).toBe(tenantId);
  });

  it("rejects a body `tenant_id` instead of silently dropping it", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `body-tenant-${suffix}`,
        source: `body-tenant-${suffix}`,
        role: "admin",
        tenant_id: tenantId,
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("validation_error");
    expect(err.error.message).toMatch(/tenant_id/);
  });
});

describe("POST /keys — single-tenant deployments keep minting tenant-less keys", () => {
  // The tenant-binding guard is scoped to multi-tenant deployments. A
  // single-tenant self-host has no tenant rows at all, so every key it
  // mints is legitimately tenant-less and there is no boundary to cross.
  it("mints a tenant-less member key in keys mode", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `self-host-${suffix}`,
        source: `self-host-${suffix}`,
        role: "member",
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.tenant_id ?? null).toBeNull();
  });

  it("still rejects a body `tenant_id` in keys mode", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `self-host-body-${suffix}`,
        source: `self-host-body-${suffix}`,
        role: "member",
        tenant_id: "some-tenant",
      },
    });
    expect(res.status).toBe(400);
  });
});
