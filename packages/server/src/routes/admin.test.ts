/**
 * T-117 — `/admin/*` operator route tests. Covers the auth gate, every
 * happy path, the suspend → write-rejected contract enforced by the
 * tenant-suspension middleware, the audit-trail on suspend/unsuspend,
 * and the cross-tenant platform-admin read path (the core value
 * proposition: a platform admin must be able to read tenant B's
 * resources from any session).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

/**
 * Mint a non-platform member key in the named tenant. The CLI's normal
 * `my keys create` flow goes through `POST /keys`, but tests get a
 * direct storage call so they don't have to mint and authenticate a
 * second admin first.
 */
async function mintTenantKey(
  tenantId: string,
  opts?: { is_platform?: boolean },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const raw = `myme_k1_test_member_${suffix}`;
  const hash = hashApiKey(raw, TEST_API_KEY_SALT);
  await ctx.storage.keys.create(
    {
      label: `test-member-${suffix}`,
      source: `test-member-${suffix}`,
      role: "member",
      type_permissions: { "core.note": "write" },
      default_tier: "library",
      is_platform: opts?.is_platform ?? false,
    },
    hash,
    tenantId,
  );
  return raw;
}

// ---------------------------------------------------------------------------
// Auth gates
// ---------------------------------------------------------------------------

describe("admin auth gate", () => {
  it("GET /admin/tenants — 401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/admin/tenants");
    expect(res.status).toBe(401);
  });

  it("GET /admin/tenants — 403 with a non-platform key", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("tenant-non-platform");
    const memberKey = await mintTenantKey(t.id);
    const res = await request(ctx.app, "GET", "/admin/tenants", {
      key: memberKey,
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/tenants/:id/suspend — 401 unauthenticated", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("tenant-suspend-401");
    const res = await request(
      ctx.app,
      "POST",
      `/admin/tenants/${t.id}/suspend`,
    );
    expect(res.status).toBe(401);
  });

  it("POST /admin/tenants/:id/suspend — 403 non-platform", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("tenant-suspend-403");
    const memberKey = await mintTenantKey(t.id);
    const res = await request(
      ctx.app,
      "POST",
      `/admin/tenants/${t.id}/suspend`,
      { key: memberKey },
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Happy paths + cross-tenant platform-admin
// ---------------------------------------------------------------------------

describe("admin happy paths", () => {
  it("GET /admin/tenants lists every tenant with status", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("happy-list");
    const res = await request(ctx.app, "GET", "/admin/tenants", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; name: string | null; status: string }[];
    };
    const row = body.data.find((r) => r.id === t.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe("active");
  });

  it("GET /admin/tenants/:id returns row + quotas + recent activity", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("happy-show");
    await ctx.storage.tenantQuotas.set(t.id, { items_limit: 1234 });

    const res = await request(ctx.app, "GET", `/admin/tenants/${t.id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { id: string; status: string };
      quotas: { items_limit: number | null } | null;
      recent_activity: unknown[];
    };
    expect(body.tenant.id).toBe(t.id);
    expect(body.tenant.status).toBe("active");
    expect(body.quotas?.items_limit).toBe(1234);
    expect(Array.isArray(body.recent_activity)).toBe(true);
  });

  it("GET /admin/tenants/:id — 404 on unknown tenant", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/admin/tenants/01999999-9999-7999-8999-999999999999",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  /**
   * Verification #4 from the orchestrator. The core value proposition of
   * a platform-admin key is cross-tenant authority — the tests above use
   * the seeded admin (tenant-less). This one creates a SECOND tenant and
   * confirms the platform admin can read its metrics directly without
   * any session ownership of the target tenant.
   */
  it("platform-admin reads another tenant's metrics + show + keys cross-tenant", async () => {
    if (!ctx.storage.tenants) return;
    const tenantB = await ctx.storage.tenants.create("cross-tenant-target");
    // Mint a non-platform key inside tenantB so listForTenant has a hit.
    await mintTenantKey(tenantB.id);

    const showRes = await request(
      ctx.app,
      "GET",
      `/admin/tenants/${tenantB.id}`,
      { key: ctx.adminKey },
    );
    expect(showRes.status).toBe(200);

    const metricsRes = await request(
      ctx.app,
      "GET",
      `/admin/tenants/${tenantB.id}/metrics`,
      { key: ctx.adminKey },
    );
    expect(metricsRes.status).toBe(200);
    const metrics = (await metricsRes.json()) as {
      tenant_id: string;
      items: { total: number };
      blobs: { count: number; total_size: number };
    };
    expect(metrics.tenant_id).toBe(tenantB.id);
    // Type-parity check. Both dialects must return a JS number for
    // blobs.total_size, not a JSON string. Pre-fix the PG path
    // returned the raw bigint as a string and the `??` operator
    // passed it through unchanged — `typeof` here would have been
    // "string". Non-zero arithmetic coverage lives in
    // middleware/quota.test.ts (storage_bytes regression).
    expect(typeof metrics.blobs.total_size).toBe("number");
    expect(metrics.blobs.total_size).toBe(0);

    const keysRes = await request(
      ctx.app,
      "GET",
      `/admin/tenants/${tenantB.id}/keys`,
      { key: ctx.adminKey },
    );
    expect(keysRes.status).toBe(200);
    const keysBody = (await keysRes.json()) as {
      data: { id: string }[];
    };
    expect(keysBody.data.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Suspend / unsuspend + write-rejected contract + audit trail
// ---------------------------------------------------------------------------

describe("tenant suspension", () => {
  it("suspend flips status, blocks subsequent writes, and emits an audit row", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("suspend-write-block");
    const memberKey = await mintTenantKey(t.id);

    // Baseline — member can write before suspension.
    const beforeWrite = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "pre-suspend" } },
    });
    expect(beforeWrite.status).toBe(201);

    // Suspend via the admin route. Returns the updated tenant row.
    const suspendRes = await request(
      ctx.app,
      "POST",
      `/admin/tenants/${t.id}/suspend`,
      { key: ctx.adminKey },
    );
    expect(suspendRes.status).toBe(200);
    const suspended = (await suspendRes.json()) as {
      id: string;
      status: string;
    };
    expect(suspended.status).toBe("suspended");

    // Subsequent writes are rejected at the auth middleware. The suspend
    // route evicts the per-instance status cache for this tenant, so the
    // next write reads the fresh `suspended` row without waiting out the
    // 5s TTL.
    const afterWrite = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "post-suspend" } },
    });
    expect(afterWrite.status).toBe(403);
    const afterBody = (await afterWrite.json()) as {
      error: { code: string };
    };
    expect(afterBody.error.code).toBe("tenant_suspended");

    // Reads still pass through.
    const readRes = await request(ctx.app, "GET", "/items", {
      key: memberKey,
    });
    expect(readRes.status).toBe(200);

    // Audit row landed.
    const audit = await waitForAudit(
      () =>
        ctx.storage.audit.list({
          action: "tenant.suspend",
          limit: 50,
        }),
      (page) => page.data.some((row) => row.resource_id === t.id),
    );
    expect(audit.data.some((row) => row.resource_id === t.id)).toBe(true);
  });

  it("unsuspend reverses status, restores writes, and emits an audit row", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("unsuspend-restore");

    await request(ctx.app, "POST", `/admin/tenants/${t.id}/suspend`, {
      key: ctx.adminKey,
    });
    const unsuspendRes = await request(
      ctx.app,
      "POST",
      `/admin/tenants/${t.id}/unsuspend`,
      { key: ctx.adminKey },
    );
    expect(unsuspendRes.status).toBe(200);
    const restored = (await unsuspendRes.json()) as { status: string };
    expect(restored.status).toBe("active");

    // Cache was evicted by the unsuspend route — next write reads the
    // restored `active` row.
    const memberKey = await mintTenantKey(t.id);
    const write = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "post-unsuspend" } },
    });
    expect(write.status).toBe(201);

    const audit = await waitForAudit(
      () => ctx.storage.audit.list({ action: "tenant.unsuspend", limit: 50 }),
      (page) => page.data.some((row) => row.resource_id === t.id),
    );
    expect(audit.data.some((row) => row.resource_id === t.id)).toBe(true);
  });

  it("suspend on unknown tenant — 404", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/admin/tenants/01999999-9999-7999-8999-999999999999/suspend",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  it("platform-admin can still write to a suspended tenant (bypass)", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("platform-bypass");
    await request(ctx.app, "POST", `/admin/tenants/${t.id}/suspend`, {
      key: ctx.adminKey,
    });
    // Platform admin operates without a `tenant_id`, but a real
    // platform write that targets the suspended tenant — e.g. flipping
    // quotas — must succeed. PUT /tenants/:id/quotas is the canonical
    // platform-admin write surface.
    const quotaRes = await request(ctx.app, "PUT", `/tenants/${t.id}/quotas`, {
      key: ctx.adminKey,
      body: { items_limit: 9999 },
    });
    expect(quotaRes.status).toBe(200);
  });
});

// ===========================================================================
// T-124 — POST /admin/account-deletion/purge-now
// ===========================================================================

/**
 * Helper: seed an `auth_user` row with `pending_deletion_at` set to `iso`.
 * Bypasses the full account-deletion flow (sign-up + verify + initiate +
 * confirm) and writes the lifecycle state directly. Returns the new
 * `auth_user_id`. Tests that need the cascade exercised through the route
 * use this to set up the eligible-for-purge precondition.
 */
async function seedPendingDeletionUser(
  c: TestContext,
  email: string,
  pendingDeletionAtIso: string,
): Promise<string> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const userId = `test-pd-user-${Math.random().toString(36).slice(2, 12)}`;
  // PG `auth_user.created_at`/`updated_at` are TIMESTAMP — accept ISO
  // strings via the driver. SQLite same columns are integer({mode:
  // "timestamp"}) so Drizzle stores unix-epoch *seconds* as INTEGER —
  // the raw __sqliteRun bypass needs the numeric form, otherwise SQLite's
  // loose typing accepts the string but downstream Drizzle reads parse
  // it as an invalid Date. `pending_deletion_at` stays text/ISO in both
  // dialects per the schema note in sqlite/schema.ts.
  const nowIso = new Date().toISOString();
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  if (dialect === "pg") {
    const pg = c.storage as unknown as {
      __pgClient: (q: string, p?: unknown[]) => Promise<unknown[]>;
    };
    await pg.__pgClient(
      `INSERT INTO auth_user (id, email, name, email_verified, created_at,
                              updated_at, deletion_state, pending_deletion_at)
       VALUES ($1, $2, $3, TRUE, $4, $4, 'pending_deletion', $5)`,
      [userId, email, email.split("@")[0], nowIso, pendingDeletionAtIso],
    );
  } else {
    const sqlite = c.storage as unknown as {
      __sqliteRun: (q: string, p: unknown[]) => Promise<{ changes: number }>;
    };
    await sqlite.__sqliteRun(
      `INSERT INTO auth_user (id, email, name, email_verified, created_at,
                              updated_at, deletion_state, pending_deletion_at)
       VALUES (?, ?, ?, 1, ?, ?, 'pending_deletion', ?)`,
      [
        userId,
        email,
        email.split("@")[0],
        nowEpochSeconds,
        nowEpochSeconds,
        pendingDeletionAtIso,
      ],
    );
  }
  return userId;
}

describe("POST /admin/account-deletion/purge-now (T-124)", () => {
  it("401 without credentials", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
    );
    expect(res.status).toBe(401);
  });

  it("403 with a non-platform key", async () => {
    if (!ctx.storage.tenants) return;
    const t = await ctx.storage.tenants.create("purge-now-403");
    const memberKey = await mintTenantKey(t.id);
    const res = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
      { key: memberKey },
    );
    expect(res.status).toBe(403);
  });

  it("happy path with no pending rows returns purged_count: 0 + audit row", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged_count: number; run_at: string };
    expect(body.purged_count).toBe(0);
    expect(typeof body.run_at).toBe("string");
    expect(new Date(body.run_at).toString()).not.toBe("Invalid Date");

    const audit = await waitForAudit(
      () =>
        ctx.storage.audit.list({
          action: "admin.account_deletion.purge_now",
          limit: 50,
        }),
      (page) =>
        page.data.some(
          (row) =>
            row.resource_id === "account-deletion-purger" &&
            row.tenant_id === null,
        ),
    );
    const row = audit.data.find(
      (r) => r.resource_id === "account-deletion-purger",
    );
    expect(row).toBeDefined();
    expect(row?.tenant_id).toBeNull();
    const details = row?.details as { purged_count: number; run_at: string };
    expect(details.purged_count).toBe(0);
  });

  it("purges a row whose pending_deletion_at is past the grace window", async () => {
    if (!ctx.storage.accountLifecycle) return;
    // Seed an auth_user with pending_deletion_at set 31 days ago — past
    // the default 30-day grace window. Route should sweep it on the
    // next call.
    const cutoffPast = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const seededId = await seedPendingDeletionUser(
      ctx,
      `purge-eligible-${Math.random().toString(36).slice(2, 8)}@example.com`,
      cutoffPast,
    );
    const before =
      await ctx.storage.accountLifecycle.getAccountLifecycle(seededId);
    expect(before?.deletion_state).toBe("pending_deletion");

    const res = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged_count: number };
    expect(body.purged_count).toBeGreaterThanOrEqual(1);

    // Row is gone.
    const after =
      await ctx.storage.accountLifecycle.getAccountLifecycle(seededId);
    expect(after).toBeNull();
  });

  it("does NOT purge a row inside the grace window (pending_deletion_at is yesterday)", async () => {
    if (!ctx.storage.accountLifecycle) return;
    const cutoffRecent = new Date(Date.now() - 86_400_000).toISOString();
    const seededId = await seedPendingDeletionUser(
      ctx,
      `purge-too-recent-${Math.random().toString(36).slice(2, 8)}@example.com`,
      cutoffRecent,
    );
    const res = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged_count: number };
    // The route may sweep other test-residue rows alongside ours; the
    // contract here is that OUR row is still present (the test-residue
    // rows should also be gone if any were past-grace, which is fine).
    const after =
      await ctx.storage.accountLifecycle.getAccountLifecycle(seededId);
    expect(after?.deletion_state).toBe("pending_deletion");
    expect(body.purged_count).toBeGreaterThanOrEqual(0);
  });

  it("idempotent — calling twice with no pending rows returns 0 both times", async () => {
    // Drain anything residual from prior tests first.
    await request(ctx.app, "POST", "/admin/account-deletion/purge-now", {
      key: ctx.adminKey,
    });
    const r1 = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
      { key: ctx.adminKey },
    );
    const r2 = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
      { key: ctx.adminKey },
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r1.json()) as { purged_count: number }).purged_count).toBe(
      0,
    );
    expect(((await r2.json()) as { purged_count: number }).purged_count).toBe(
      0,
    );
  });
});

// ===========================================================================
// T-124 — graceDays: 0 short-circuit (separate test context)
// ===========================================================================

describe("POST /admin/account-deletion/purge-now — graceDays=0 short-circuit", () => {
  it("returns 0 cleanly when accountDeletionGraceDays is 0 (purger disabled)", async () => {
    const ctx0 = await createTestContext({ accountDeletionGraceDays: 0 });
    try {
      // Seed a row that would be eligible under any positive grace
      // window — purger early-returns 0 because graceDays is disabled.
      if (ctx0.storage.accountLifecycle) {
        await seedPendingDeletionUser(
          ctx0,
          "would-be-eligible@example.com",
          new Date(Date.now() - 365 * 86_400_000).toISOString(),
        );
      }
      const res = await request(
        ctx0.app,
        "POST",
        "/admin/account-deletion/purge-now",
        { key: ctx0.adminKey },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { purged_count: number };
      expect(body.purged_count).toBe(0);
    } finally {
      ctx0.cleanup();
    }
  });
});
