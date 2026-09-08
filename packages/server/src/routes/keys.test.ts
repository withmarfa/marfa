import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { mkdtempSync, rmSync } from "node:fs";
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
import { KeyResponseSchema } from "./_schemas.js";
import { extensionLabelOf } from "../auth/extension-label.js";

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

describe("the key a create route returns", () => {
  // Two tests, because the defect has two halves and one assertion cannot
  // reach both. This one pins the HANDLER: an expiry is settable only through
  // `createRuntimeCredential`, which no route reaches, so a key minted through
  // a door has none by construction and the response must not carry the field.
  //
  // It says nothing about the declaration. Re-adding `expires_at` to the
  // shared schema leaves this green, because a declaration does not put a
  // field into a response — which is the whole reason the two drifted apart
  // in the first place. The declaration is pinned separately, below.
  it("carries no expiry, because a create route cannot mint one", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `expiry-${suffix}`,
        source: `expiry-${suffix}`,
        role: "member",
        default_tier: "feed",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // The field itself, not a falsy value: a response sending `null` would
    // satisfy an optional-chained read and still contradict the declaration.
    expect(
      Object.hasOwn(body, "expires_at"),
      "a create response carried an expiry field, so the declaration and the handler disagree about what a minted key can have",
    ).toBe(false);
    // A control, so the assertion above cannot pass on an empty body.
    expect(body.id).toBeTruthy();
    expect(body.key).toBeTruthy();
  });
});

describe("the declaration a create route publishes", () => {
  // The other half. This one reddens when the schema regains a field the
  // handler cannot fill, which is the regression the consolidation exists to
  // prevent and which the response-body test above cannot see.
  //
  // Asserted against the schema rather than the generated specification so it
  // fails at the declaration rather than three steps downstream of it, where
  // the message would be about a large JSON artifact instead of about a line
  // somebody wrote.
  it("does not promise an expiry the handler cannot send", () => {
    const shape = Object.keys(KeyResponseSchema.shape);
    expect(
      shape,
      "the create response declares an expiry, which no key a create route can mint will ever carry, so the published specification promises generated clients a property that cannot arrive",
    ).not.toContain("expires_at");
    // A control: a wrong import or an emptied schema would otherwise satisfy
    // the assertion above by containing nothing at all.
    expect(shape).toContain("created_at");
    expect(shape).toContain("last_used_at");
  });
});

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
      body: { role: "instance_admin" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/role.*immutable/i);
  });

  // The one response here that can carry an expiry, and it declared the field
  // without ever sending it. Any key is patchable, a runtime credential
  // included, and those always carry a hard lifetime bound — so a caller
  // updating a credential's permissions got the credential back with the one
  // field saying when it stops working missing from it.
  //
  // Minted through the store, because `createRuntimeCredential` is the only
  // mint that can stamp an expiry and no route reaches it. A key made through
  // a create door has none by construction, so patching one of those would
  // leave this green whatever the handler did.
  it("returns the expiry the stored row carries", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const minted = await ctx.storage.keys.createRuntimeCredential(
      {
        label: `runtime-${suffix}`,
        source: `runtime-${suffix}`,
        role: "member",
        type_permissions: {},
        connection_id: `conn-${suffix}`,
        expires_at: expiresAt,
        item_source: null,
      },
      hashApiKey(`marfa_k1_runtime_${suffix}`, TEST_API_KEY_SALT),
      undefined,
    );
    expect(minted.expires_at).toBe(expiresAt);

    const res = await request(ctx.app, "PATCH", `/keys/${minted.id}`, {
      key: ctx.adminKey,
      body: { label: "renamed runtime" },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;

    expect(updated.label).toBe("renamed runtime");
    // Against the stored row rather than against the literal alone, so the
    // assertion is that the response says what the key says.
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.expires_at).toBe(expiresAt);
    expect(updated.expires_at).toBe(stored?.expires_at);
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
    /** Removed by the caller alongside `storage.close()`; nothing else
     *  removes it. */
    tmpDir: string;
  }> {
    const dialect = process.env.DB_DIALECT ?? "sqlite";
    let storage: Storage;
    let blobPath: string;
    let tmpDir: string;
    if (dialect === "pg") {
      const pg = await createPgTestStorage();
      storage = pg.storage;
      // pg.cleanup leaks here intentionally — `freshApp` doesn't have
      // a returned-cleanup contract with its callers; the leaked clone
      // is mopped up by the next test-run's dropStaleClones pass.
      tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-pg-"));
      blobPath = join(tmpDir, "blobs");
    } else {
      tmpDir = mkdtempSync(join(tmpdir(), "marfa-bootstrap-"));
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
    return { app, storage, tmpDir };
  }

  it("admits the first unauthenticated POST /keys as bootstrap", async () => {
    const { app, storage, tmpDir } = await freshApp();
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
      expect(body.role).toBe("instance_admin");
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
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("a rejected body does not burn the one-shot bootstrap claim", async () => {
    // The sentinel claim is irreversible. If a request that can never
    // mint consumed it, a single stray field would lock a brand-new
    // instance out of bootstrap permanently.
    const { app, storage, tmpDir } = await freshApp();
    try {
      const rejected = await request(app, "POST", "/keys", {
        body: {
          label: "stray-field",
          source: "stray-field",
          space_id: "some-space",
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
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("admin-issued POST /keys emits `key.create`, not `key.bootstrap`", async () => {
    // Self-contained — bootstrap a fresh app, then use the bootstrap
    // admin to mint a second key on the now-closed (non-bootstrap)
    // branch. Avoids depending on the shared `ctx` because freshApp()
    // tests under PG truncate the shared container, which would wipe
    // the ctx's admin key and sentinel between tests.
    const { app, storage, tmpDir } = await freshApp();
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
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT re-open bootstrap after every key is revoked", async () => {
    const { app, storage, tmpDir } = await freshApp();
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
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("concurrent unauthenticated POST /keys mints exactly one admin key", async () => {
    const { app, storage, tmpDir } = await freshApp();
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
      expect(keys[0]?.role).toBe("instance_admin");
    } finally {
      await storage.close();
      rmSync(tmpDir, { recursive: true, force: true });
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
      const { storage, tmpDir } = (await freshApp()) as unknown as {
        storage: Awaited<ReturnType<typeof createSqliteStorage>>;
        tmpDir: string;
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
        rmSync(tmpDir, { recursive: true, force: true });
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
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(SKIP_SQLITE_ONLY)(
    "bootstrap creates idx_api_keys_connection_id (sqlite)",
    async () => {
      const { storage, tmpDir } = (await freshApp()) as unknown as {
        storage: Awaited<ReturnType<typeof createSqliteStorage>>;
        tmpDir: string;
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
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

describe("POST /keys — a session mints, clamped to its own grant", () => {
  // The blanket refusal that used to stand here did two jobs: it withheld the
  // permission, and it prevented the escalation a mint makes possible. Both
  // still hold, through three things that can fail independently — the
  // capability gate, the breadth clamp, and `scope_enforced` — so each gets
  // its own case rather than one test standing for all three.
  let hostedCtx: TestContext;
  let spaceId: string;

  const KEYS = "space.keys";
  const grantScopes = (...extra: string[]) => ["openid", KEYS, ...extra];

  beforeAll(async () => {
    hostedCtx = await createTestContext({ authMode: "hosted" });
    const space = await hostedCtx.storage.spaces!.create("oauth-keys-space");
    spaceId = space.id;
  });

  afterAll(async () => {
    await hostedCtx.cleanup();
  });

  it("refuses every keys door to a session that was not granted the capability", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, ["openid"], {
      userRole: "space_admin",
      spaceId,
    });
    const doors: [string, string, unknown?][] = [
      ["GET", "/keys"],
      ["POST", "/keys", { label: "x", source: "x", role: "member" }],
      ["DELETE", "/keys/key_whatever"],
      ["PATCH", "/keys/key_whatever", { label: "renamed" }],
    ];
    for (const [method, path, body] of doors) {
      const res = await request(hostedCtx.app, method, path, {
        key: token,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      const err = (await res.json()) as {
        error: { code: string; details?: { required_scope?: string } };
      };
      expect(err.error.code).toBe("forbidden");
      // The refusal names the literal. A client told only "forbidden" on an
      // administrative surface reads it as the role, which is not what
      // refused it, and cannot narrow toward a scope nobody named.
      expect(err.error.details?.required_scope).toBe(KEYS);
    }
  });

  it("lets a granted session mint, and the key matches the session's own reach", async () => {
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { userRole: "space_admin", spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "like me", source: "like-me", role: "member" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      scope_enforced?: boolean;
      type_permissions: Record<string, string>;
    };
    // The no-input case is "a key like this session". The alternative default
    // is `{}`, which on a scope-enforced key reads nothing at all.
    expect(created.type_permissions["core.note"]).toBe("read");
    // **On the response, not only in storage.** The schema documents the flag
    // on every key shape, and a handler that builds its response object field
    // by field can satisfy the schema's type while never sending it — which is
    // exactly what happened, and what a storage-only assertion cannot see.
    expect(created.scope_enforced).toBe(true);

    const stored = await hostedCtx.storage.keys.get(created.id);
    expect(stored?.scope_enforced).toBe(true);
    expect(stored?.space_id).toBe(spaceId);
    expect(stored?.is_platform).toBe(false);
  });

  it("refuses reach the grant does not cover, and names the literal", async () => {
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { userRole: "space_admin", spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "wider",
        source: "wider",
        role: "member",
        type_permissions: { "core.note": "write" },
      },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as {
      error: { details?: { required_scope?: string } };
    };
    // `core.note:read` does not cover `core.note:write`: the verb ranks.
    expect(err.error.details?.required_scope).toBe("core.note:write");
  });

  it("accepts reach a wildcard in the grant covers", async () => {
    // The clamp asks `grantCoversScope`, not a string comparison. Five earlier
    // hand-rolled versions of this question disagreed with the real rule, so
    // the case that would pass a naive membership test is the one worth
    // pinning.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.*:write"),
      { userRole: "space_admin", spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "under a wildcard",
        source: "under-wildcard",
        role: "member",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(res.status).toBe(201);
  });

  it("still refuses a role above the session's own", async () => {
    // Role is a separate axis and the capability does not touch it: a granted
    // session may spend its role, never exceed it.
    const { token } = await seedOauthBearer(hostedCtx.storage, grantScopes(), {
      userRole: "member",
      spaceId,
    });
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "up", source: "up", role: "space_admin" },
    });
    expect(res.status).toBe(403);
  });

  it("never mints a platform key from a session, whatever the body asks", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, grantScopes(), {
      userRole: "instance_admin",
      spaceId,
    });
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "platform",
        source: "platform",
        role: "member",
        is_platform: true,
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(created.id);
    // `is_platform` is an operator-tier flag exclusive to API keys; the
    // synthetic OAuth principal never carries it, so the escalation clamp
    // above it coerces the request to false.
    expect(stored?.is_platform).toBe(false);
  });

  it("records the grant on the audit row, so a revoked app leads to its keys", async () => {
    const { token, clientId } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { userRole: "space_admin", spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "audited", source: "audited", role: "member" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const audits = await waitForAudit(
      () => hostedCtx.storage.audit.list({ action: "key.create" }),
      (r) => r.data.some((row) => row.resource_id === created.id),
    );
    const row = audits.data.find((r) => r.resource_id === created.id);
    expect(row).toBeTruthy();
    const details = row?.details;
    // The key outlives the token that minted it, and `key_id` names the
    // synthetic principal — whose id is the access token's. These are the
    // identifiers still resolvable an hour later.
    expect(details?.client_id).toBe(clientId);
    expect(details?.user_id).toBeTruthy();
    expect("grant_item_id" in (details ?? {})).toBe(true);
  });

  it("lets a granted session read, revoke and rename", async () => {
    const { token } = await seedOauthBearer(hostedCtx.storage, grantScopes(), {
      userRole: "space_admin",
      spaceId,
    });
    const raw = "marfa_k1_sess_" + Math.random().toString(36).slice(2);
    const target = await hostedCtx.storage.keys.create(
      {
        label: "target",
        source: "target-" + Math.random().toString(36).slice(2),
        role: "member",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );

    const list = await request(hostedCtx.app, "GET", "/keys", { key: token });
    expect(list.status).toBe(200);

    const renamed = await request(
      hostedCtx.app,
      "PATCH",
      `/keys/${target.id}`,
      { key: token, body: { label: "renamed" } },
    );
    expect(renamed.status).toBe(200);
    // The update response builds its own object too, and had the same gap.
    expect(
      Object.keys((await renamed.json()) as Record<string, unknown>),
    ).toContain("scope_enforced");

    const revoked = await request(
      hostedCtx.app,
      "DELETE",
      `/keys/${target.id}`,
      { key: token },
    );
    expect(revoked.status).toBe(200);
  });

  it("refuses a session a role above member, which no scope can measure", async () => {
    // `canGrantRole` permits this: a space_admin user's app asking for
    // space_admin travels sideways, not up. The axis it does not measure is
    // the one that matters — the session's own principal is scope-enforced, so
    // its effective authority is its maps, while a key carrying rank opens
    // audit, credentials, connections and the schema doors on rank alone.
    const { token } = await seedOauthBearer(hostedCtx.storage, grantScopes(), {
      userRole: "space_admin",
      spaceId,
    });
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "ranked", source: "ranked", role: "space_admin" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a key minted from a session when it tries to mint again", async () => {
    // **The second half of the two-step escalation, kept even though the first
    // half is now refused above.** The two defences are independent: the role
    // refusal stops a session asking for rank, and this stops any
    // scope-enforced credential reaching a capability door at all. If the role
    // rule were ever relaxed — a deployment wanting session-minted admin keys,
    // say — this is what would still be standing between that key and an
    // unclamped, unstamped second key with full reach.
    const raw = "marfa_k1_enf_" + Math.random().toString(36).slice(2);
    const enforced = await hostedCtx.storage.keys.create(
      {
        label: "as if minted from a session",
        source: "enforced-" + Math.random().toString(36).slice(2),
        role: "space_admin",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
        scope_enforced: true,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );
    expect(
      (await hostedCtx.storage.keys.get(enforced.id))?.scope_enforced,
    ).toBe(true);

    // Its rank would open every one of these doors. The stamp closes them.
    for (const [method, path, body] of [
      ["GET", "/keys", undefined],
      [
        "POST",
        "/keys",
        {
          label: "step two",
          source: "step-two",
          role: "space_admin",
          type_permissions: { "*": "write" },
        },
      ],
      ["DELETE", `/keys/${enforced.id}`, undefined],
      ["PATCH", `/keys/${enforced.id}`, { label: "renamed" }],
    ] as [string, string, unknown][]) {
      const res = await request(hostedCtx.app, method, path, {
        key: raw,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("clamps the update door, which reaches keys the session never minted", async () => {
    // A clamp at the mint alone is not a clamp: the maps are writable a moment
    // later, and this door addresses every key in the space.
    const raw = "marfa_k1_victim_" + Math.random().toString(36).slice(2);
    const victim = await hostedCtx.storage.keys.create(
      {
        label: "someone else's key",
        source: "victim-" + Math.random().toString(36).slice(2),
        role: "member",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );

    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { userRole: "space_admin", spaceId },
    );
    const widen = await request(hostedCtx.app, "PATCH", `/keys/${victim.id}`, {
      key: token,
      body: { type_permissions: { "*": "write" } },
    });
    expect(widen.status).toBe(403);

    // At the ceiling, the same door still works.
    const within = await request(hostedCtx.app, "PATCH", `/keys/${victim.id}`, {
      key: token,
      body: { type_permissions: { "core.note": "read" } },
    });
    expect(within.status).toBe(200);
  });

  it("refuses an extension map from a session, at both doors", async () => {
    // Nothing can measure one: no scope names an extension namespace, so the
    // only answers are refuse and let-through-unchecked. Unchecked is real
    // reach — the extension read door consults this map alone, with no
    // type-permission check beside it.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { userRole: "space_admin", spaceId },
    );
    const minted = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "ext",
        source: "ext",
        role: "member",
        type_permissions: {},
        extension_permissions: { "*": "write" },
      },
    });
    expect(minted.status).toBe(403);

    const raw = "marfa_k1_extt_" + Math.random().toString(36).slice(2);
    const target = await hostedCtx.storage.keys.create(
      {
        label: "ext target",
        source: "ext-target-" + Math.random().toString(36).slice(2),
        role: "member",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );
    const patched = await request(
      hostedCtx.app,
      "PATCH",
      `/keys/${target.id}`,
      {
        key: token,
        body: { extension_permissions: { "*": "write" } },
      },
    );
    expect(patched.status).toBe(403);
  });

  it("names one family and still gets none of the other three for free", async () => {
    // `namesNoReach` reads all four families. The grant below projects a
    // non-empty edge map as well as a type map, so the derive path has
    // something to hand over — without which this assertion would pass
    // whether or not the condition were right, which is what the first
    // version of it did.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read", "edge.about:read"),
      { userRole: "space_admin", spaceId },
    );

    // The derive path does hand the edge map over when nothing is named.
    const derived = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: { label: "derived", source: "derived-edges", role: "member" },
    });
    expect(derived.status).toBe(201);
    const derivedKey = await hostedCtx.storage.keys.get(
      ((await derived.json()) as { id: string }).id,
    );
    expect(derivedKey?.edge_permissions?.about).toBe("read");

    // Naming one family takes the derive path off for all of them.
    const partial = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "partial",
        source: "partial",
        role: "member",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(partial.status).toBe(201);
    const partialKey = await hostedCtx.storage.keys.get(
      ((await partial.json()) as { id: string }).id,
    );
    expect(partialKey?.type_permissions["core.note"]).toBe("read");
    expect(partialKey?.edge_permissions ?? {}).toEqual({});
    expect(partialKey?.metadata_permissions ?? {}).toEqual({});
    expect(partialKey?.extension_permissions ?? {}).toEqual({});
  });

  it("takes the derive path off whichever family is named", async () => {
    // Symmetric to the case above, and it is the one that catches a term
    // going missing from `namesNoReach`: naming only the edge family must
    // stop the type map deriving too, or a caller asking for a narrow key
    // silently receives the session's own reach instead.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read", "edge.about:read"),
      { userRole: "space_admin", spaceId },
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "edges only",
        source: "edges-only",
        role: "member",
        edge_permissions: {},
      },
    });
    expect(res.status).toBe(201);
    const stored = await hostedCtx.storage.keys.get(
      ((await res.json()) as { id: string }).id,
    );
    expect(stored?.type_permissions ?? {}).toEqual({});
    expect(stored?.edge_permissions ?? {}).toEqual({});
  });

  it("does not let a session-minted key claim a namespace by its label", async () => {
    // `label` is read as identity, the same way `source` is: a namespace
    // equal to the key's label is granted write implicitly. A session chooses
    // its key's label, so without the stamp being consulted an app could name
    // another vendor's namespace and read it on every item in the space,
    // durably and after the app was revoked.
    const { token } = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("core.note:read"),
      { userRole: "space_admin", spaceId },
    );
    const minted = await request(hostedCtx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "com.othervendor.sync",
        source: "vendor-probe",
        role: "member",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(minted.status).toBe(201);
    const key = await hostedCtx.storage.keys.get(
      ((await minted.json()) as { id: string }).id,
    );
    expect(key?.scope_enforced).toBe(true);
    // The stored map is empty, and the label must not stand in for one.
    expect(key?.extension_permissions ?? {}).toEqual({});
    expect(extensionLabelOf(key ?? undefined)).toBe("");
    // A key minted the ordinary way still claims its own namespace.
    expect(
      extensionLabelOf({
        label: "com.othervendor.sync",
        scope_enforced: false,
      }),
    ).toBe("com.othervendor.sync");
  });

  it("measures a metadata wildcard on the metadata axis, not the type axis", async () => {
    // `metadata.*:write` is well-formed on the WRONG axis: it misses the
    // sub-resource matcher, clears `isValidTypePattern` because `metadata` is
    // a valid root, and parses as an item-type grant. A plain content grant
    // then covers it, so this case is a fail-open unless the bare form is
    // used — and `"*"` is the ordinary key, since it is what a bare
    // `metadata:<verb>` grant projects to.
    const contentOnly = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("content:write"),
      { userRole: "space_admin", spaceId },
    );
    const refused = await request(hostedCtx.app, "POST", "/keys", {
      key: contentOnly.token,
      body: {
        label: "meta up",
        source: "meta-up",
        role: "member",
        metadata_permissions: { "*": "write" },
      },
    });
    expect(refused.status).toBe(403);
    const err = (await refused.json()) as {
      error: { details?: { required_scope?: string } };
    };
    expect(err.error.details?.required_scope).toBe("metadata:write");

    // And the honest holder is not refused, which the broken literal also got
    // wrong — in the other direction.
    const metaHolder = await seedOauthBearer(
      hostedCtx.storage,
      grantScopes("metadata:write"),
      { userRole: "space_admin", spaceId },
    );
    const allowed = await request(hostedCtx.app, "POST", "/keys", {
      key: metaHolder.token,
      body: {
        label: "meta ok",
        source: "meta-ok",
        role: "member",
        metadata_permissions: { "*": "write" },
      },
    });
    expect(allowed.status).toBe(201);
  });

  it("still lets an API-key space_admin mint, with no capability anywhere", async () => {
    // The gate returns immediately for a non-OAuth caller, so nothing about a
    // keys-mode or API-key deployment changes. This is the case that says so.
    const raw = "marfa_k1_ta_" + Math.random().toString(36).slice(2);
    await hostedCtx.storage.keys.create(
      {
        label: "ta-key",
        source: "ta-key",
        role: "space_admin",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
    );
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: raw,
      body: { label: "minted", source: "minted", role: "member" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(created.id);
    // And its key is not scope-enforced: an API-key mint keeps `{}` and its
    // role decides, exactly as before.
    expect(stored?.scope_enforced).toBe(false);
    expect(stored?.type_permissions).toEqual({});
  });
});

describe("POST /keys — space binding", () => {
  // `POST /keys` mints into the caller's space. A platform admin has no
  // space, so a `space_admin` key minted from one lands space-less:
  // NULL space is the universal "platform tier / all spaces" signal to
  // the RLS policies and to the storage layer's space predicate, while
  // the role itself skips the permission maps. Composed, the credential
  // reads and writes across every space behind a name that promises a
  // boundary, so the mint refuses.
  //
  // `member` is not refused: it is this route's default role, the only
  // way to express "platform reach, narrowed by type_permissions", and a
  // caller denied it can ask for `role: "instance_admin"` here for strictly more
  // authority. The tests below pin both halves of that split.
  let hostedCtx: TestContext;
  let spaceId: string;

  beforeAll(async () => {
    hostedCtx = await createTestContext({ authMode: "hosted" });
    const space = await hostedCtx.storage.spaces!.create("space-binding");
    spaceId = space.id;
  });

  afterAll(async () => {
    await hostedCtx.cleanup();
  });

  it("refuses the role name this rename retired", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);

    // Precondition: the same shape with the current word is accepted, so the
    // 400 below is the enum refusing the retired value and not the request
    // failing for an unrelated reason.
    const permitted = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `retired-ok-${suffix}`,
        source: `retired-ok-${suffix}`,
        role: "instance_admin",
      },
    });
    expect(permitted.status).toBe(201);

    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `retired-${suffix}`,
        source: `retired-${suffix}`,
        role: "admin",
      },
    });

    // Accepted for one release while the clients that mint credentials caught
    // up, then removed with the migration. A request still sending it is a
    // client nobody updated, and telling it so is the point.
    expect(res.status).toBe(400);
  });

  it("rejects a space_admin mint from a platform admin with no space", async () => {
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: "null-space-admin",
        source: "null-space-admin",
        role: "space_admin",
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("validation_error");
    // The message must name the route that does the space-scoped mint,
    // otherwise the caller's only recourse is to guess.
    expect(err.error.message).toMatch(/POST \/admin\/spaces\/\{id\}\/keys/);
  });

  it("still lets a platform admin mint a space-less member key", async () => {
    // Refusing this would push the caller to `role: "instance_admin"`, the only
    // other thing a space-less credential can mint here, which reads
    // everything a member key would and ignores `type_permissions` on top.
    // A guard that trades a narrow credential for a wide one is not a
    // guard, so the mint stands and the audit row carries the tier.
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `null-space-member-${suffix}`,
        source: `null-space-member-${suffix}`,
        role: "member",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.role).toBe("member");
    expect(stored?.space_id ?? null).toBeNull();

    const audits = await waitForAudit(
      () => hostedCtx.storage.audit.list({ action: "key.create" }),
      (r) => r.data.some((row) => row.resource_id === minted.id),
    );
    const row = audits.data.find((r) => r.resource_id === minted.id);
    expect(row?.details).toMatchObject({ platform_tier: true });
  });

  it("mints the two-hop credential chain a black-box client relies on", async () => {
    // The conformance suite authenticates as a space-less platform admin,
    // mints a per-file `admin` key from it, then mints scoped `member`
    // keys from that. Both hops land space-less. Pinned here because the
    // suite runs against a deployed server, so a regression would only
    // surface after release.
    const suffix = Math.random().toString(36).slice(2, 10);
    const firstHop = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `harness-${suffix}`,
        source: `harness-${suffix}`,
        role: "instance_admin",
        is_platform: true,
        type_permissions: { "*": "write" },
      },
    });
    expect(firstHop.status).toBe(201);
    const harness = (await firstHop.json()) as { key: string };

    const secondHop = await request(hostedCtx.app, "POST", "/keys", {
      key: harness.key,
      body: {
        label: `scoped-${suffix}`,
        source: `scoped-${suffix}`,
        type_permissions: { "core.note": "read" },
      },
    });
    expect(secondHop.status).toBe(201);
    const scoped = (await secondHop.json()) as { id: string; role: string };
    // No `role` in the body, so the server default applies.
    expect(scoped.role).toBe("member");
    const stored = await hostedCtx.storage.keys.get(scoped.id);
    expect(stored?.space_id ?? null).toBeNull();
  });

  it("still lets a platform admin mint a platform-tier admin key", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `platform-${suffix}`,
        source: `platform-${suffix}`,
        role: "instance_admin",
      },
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await hostedCtx.storage.keys.get(minted.id);
    expect(stored?.role).toBe("instance_admin");
    expect(stored?.space_id ?? null).toBeNull();
  });

  it("still lets a space-bound admin mint into its own space", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = `marfa_k1_bound_admin_${suffix}`;
    await hostedCtx.storage.keys.create(
      {
        label: `bound-admin-${suffix}`,
        source: `bound-admin-${suffix}`,
        role: "space_admin",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      spaceId,
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
    expect(stored?.space_id).toBe(spaceId);
  });

  it("rejects a body `space_id` instead of silently dropping it", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(hostedCtx.app, "POST", "/keys", {
      key: hostedCtx.adminKey,
      body: {
        label: `body-space-${suffix}`,
        source: `body-space-${suffix}`,
        role: "instance_admin",
        space_id: spaceId,
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("validation_error");
    expect(err.error.message).toMatch(/space_id/);
  });
});

describe("POST /keys — single-space deployments keep minting space-less keys", () => {
  // A single-space self-host has no space rows at all (they are only
  // ever created by the hosted sign-up flow), so every key it mints is
  // legitimately space-less. The `space_admin` refusal still applies:
  // the role has no coherent meaning where no space can exist, and
  // keying a security rule on the deployment's auth mode would leave it
  // one env-var typo away from off.
  it("mints a space-less member key in keys mode", async () => {
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
    expect(stored?.space_id ?? null).toBeNull();
  });

  it("refuses a space_admin mint here too, where no space can exist", async () => {
    // Not conditioned on the deployment's auth mode: the rule holds
    // everywhere so it cannot be switched off by an env var going stale.
    // On a single-space instance `space_admin` names a boundary that
    // cannot be created in the first place.
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `self-host-ta-${suffix}`,
        source: `self-host-ta-${suffix}`,
        role: "space_admin",
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("validation_error");
  });

  it("still rejects a body `space_id` in keys mode", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `self-host-body-${suffix}`,
        source: `self-host-body-${suffix}`,
        role: "member",
        space_id: "some-space",
      },
    });
    expect(res.status).toBe(400);
  });
});
