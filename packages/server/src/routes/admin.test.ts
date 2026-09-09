/**
 * `/admin/*` operator route tests. Covers the auth gate, every
 * happy path, the suspend → write-rejected contract enforced by the
 * space-suspension middleware, the audit-trail on suspend/unsuspend,
 * and the cross-space operator read path (the core value
 * proposition: the operator key must be able to read space B's
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
import { SPACE_PERMISSIONS } from "@withmarfa/shared";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Mint a space-bound key in the named space. The CLI's normal
 * `my keys create` flow goes through `POST /keys`, but tests get a
 * direct storage call so they don't have to mint and authenticate a
 * second credential first.
 */
async function mintSpaceKey(
  spaceId: string,
  opts?: { is_operator?: boolean },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const raw = `marfa_k1_test_member_${suffix}`;
  const hash = hashApiKey(raw, TEST_API_KEY_SALT);
  await ctx.storage.keys.create(
    {
      label: `test-member-${suffix}`,
      source: `test-member-${suffix}`,
      type_permissions: { "core.note": "write" },
      default_tier: "library",
      is_operator: opts?.is_operator ?? false,
    },
    hash,
    spaceId,
  );
  return raw;
}

// ---------------------------------------------------------------------------
// Auth gates
// ---------------------------------------------------------------------------

describe("admin auth gate", () => {
  it("GET /admin/spaces — 401 without credentials", async () => {
    const res = await request(ctx.app, "GET", "/admin/spaces");
    expect(res.status).toBe(401);
  });

  it("GET /admin/spaces — 403 with a non-platform key", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("space-non-platform");
    const memberKey = await mintSpaceKey(t.id);
    const res = await request(ctx.app, "GET", "/admin/spaces", {
      key: memberKey,
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/spaces/:id/suspend — 401 unauthenticated", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("space-suspend-401");
    const res = await request(ctx.app, "POST", `/admin/spaces/${t.id}/suspend`);
    expect(res.status).toBe(401);
  });

  it("POST /admin/spaces/:id/suspend — 403 non-platform", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("space-suspend-403");
    const memberKey = await mintSpaceKey(t.id);
    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${t.id}/suspend`,
      { key: memberKey },
    );
    expect(res.status).toBe(403);
  });

  it("POST /admin/spaces/:id/keys — 401 without credentials", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("space-key-401");
    const res = await request(ctx.app, "POST", `/admin/spaces/${t.id}/keys`, {
      body: { label: "blocked", source: "test" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /admin/spaces/:id/keys — 403 with a space credential", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("space-key-403");
    const memberKey = await mintSpaceKey(t.id);
    const res = await request(ctx.app, "POST", `/admin/spaces/${t.id}/keys`, {
      key: memberKey,
      body: { label: "blocked", source: "test" },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Happy paths + cross-space operator key
// ---------------------------------------------------------------------------

describe("admin happy paths", () => {
  it("includes the hosted space owner's email and verification status", async () => {
    const hosted = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    try {
      const signUp = await request(hosted.app, "POST", "/auth/sign-up/email", {
        body: {
          email: "owner@example.com",
          password: "correct horse battery",
          name: "Owner",
        },
        headers: { origin: "http://localhost:0" },
      });
      expect(signUp.status).toBe(200);
      const authUserId = ((await signUp.json()) as { user?: { id?: string } })
        .user?.id;
      const owner = await hosted.storage.users?.getByAuthUserId(
        authUserId ?? "",
      );
      expect(owner?.space_id).toBeTruthy();

      const res = await request(hosted.app, "GET", "/admin/spaces", {
        key: hosted.adminKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          id: string;
          owner_email: string | null;
          owner_email_verified: boolean | null;
        }[];
      };
      const space = body.data.find((row) => row.id === owner?.space_id);
      expect(space?.owner_email).toBe("owner@example.com");
      expect(space?.owner_email_verified).toBe(false);
    } finally {
      await hosted.cleanup();
    }
  });

  it("POST /admin/spaces creates a space a scoped key can then be minted for", async () => {
    // Every other operator verb on a space already existed. Without this one
    // a space could only come into being through a hosted sign-up, which left
    // an operator unable to provision a space and left anything needing a
    // space-scoped credential — a conformance suite, a test harness, a
    // self-hoster seeding an instance — with no supported path to one.
    if (!ctx.storage.spaces) return;

    const created = await request(ctx.app, "POST", "/admin/spaces", {
      key: ctx.adminKey,
      body: { name: "provisioned" },
    });
    expect(created.status).toBe(201);
    const space = (await created.json()) as {
      id: string;
      name: string | null;
      status: string;
    };
    expect(space.name).toBe("provisioned");
    expect(space.status).toBe("active");

    // The point of creating one: it can carry a credential. A space that
    // exists but cannot be issued a key would close nothing.
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${space.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: "provisioned key",
          source: "provisioned",
          // The rank this mint used to carry admitted the key past its own
          // map; the map now has to say what the rank granted silently.
          type_permissions: { "*": "write" },
        },
      },
    );
    expect(keyRes.status).toBe(201);
    const minted = (await keyRes.json()) as { key: string };

    // Both mint doors share one response declaration, and the declaration
    // carries no expiry because neither door can produce one: an expiry is
    // settable only through the runtime credential mint, which no route
    // reaches. The sibling assertion on `POST /keys` cannot see this door, and
    // the stored record does carry an optional expiry — so a handler here
    // spreading the record rather than projecting it would ship a field the
    // specification does not declare, with nothing red.
    expect(
      Object.hasOwn(minted, "expires_at"),
      "the administrative mint returned an expiry field, which its shared response declaration does not carry and no key this door can mint would ever have",
    ).toBe(false);

    // And the credential really is bounded to it, which is the property the
    // space-scoped surfaces depend on.
    const stored = (await ctx.storage.keys.list()).find(
      (k) => k.label === "provisioned key",
    );
    expect(stored?.space_id).toBe(space.id);
    expect(stored?.is_operator ?? false).toBe(false);

    const write = await request(ctx.app, "POST", "/items", {
      key: minted.key,
      body: { type: "core.note", properties: { body: "in my own space" } },
    });
    expect(write.status).toBe(201);
    const item = (await write.json()) as { item: { id: string } };
    expect(await ctx.storage.items.get(item.item.id, space.id)).toBeTruthy();
  });

  it("POST /admin/spaces creates an unnamed space when no name is given", async () => {
    if (!ctx.storage.spaces) return;
    const res = await request(ctx.app, "POST", "/admin/spaces", {
      key: ctx.adminKey,
      body: {},
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { id: string }).toHaveProperty("id");
  });

  it("POST /admin/spaces refuses a space-bound admin", async () => {
    // Creating a space is cross-space authority by definition, so the gate
    // has to be the operator key rather than a space credential, however much
    // that credential holds inside its own space.
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("bounded-admin");
    const keyRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${t.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: "bound admin",
          source: "bound-admin",
        },
      },
    );
    expect(keyRes.status).toBe(201);
    const bound = (await keyRes.json()) as { key: string };

    const res = await request(ctx.app, "POST", "/admin/spaces", {
      key: bound.key,
      body: { name: "should not happen" },
    });
    expect(res.status).toBe(403);
  });

  it("GET /admin/spaces lists every space with status", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("happy-list");
    const res = await request(ctx.app, "GET", "/admin/spaces", {
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

  it("GET /admin/spaces/:id returns row + quotas + recent activity", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("happy-show");
    await ctx.storage.spaceQuotas.set(t.id, { items_limit: 1234 });

    const res = await request(ctx.app, "GET", `/admin/spaces/${t.id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      space: { id: string; status: string };
      quotas: { items_limit: number | null } | null;
      recent_activity: unknown[];
    };
    expect(body.space.id).toBe(t.id);
    expect(body.space.status).toBe("active");
    expect(body.quotas?.items_limit).toBe(1234);
    expect(Array.isArray(body.recent_activity)).toBe(true);
  });

  it("the operator key mints a key bound to the requested space", async () => {
    if (!ctx.storage.spaces) return;
    const target = await ctx.storage.spaces.create("space-key-target");
    const other = await ctx.storage.spaces.create("space-key-other");
    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${target.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: "Raycast fallback",
          source: "raycast",
          type_permissions: { "core.note": "write" },
          edge_permissions: { "core.related": "read" },
          metadata_permissions: { types: "write" },
        },
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      key: string;
      source: string;
      space_permissions: string[];
      is_operator: boolean;
    };
    expect(body.key).toMatch(/^marfa_k1_/);
    expect(body.source).toBe("raycast");
    // A mint into a named space that asks for nothing takes everything in it:
    // the operator key holds no space permission to fence it with, so this is
    // the seed rule for a creation with no ceiling above it.
    expect(new Set(body.space_permissions)).toEqual(new Set(SPACE_PERMISSIONS));
    expect(body.is_operator).toBe(false);

    const stored = await ctx.storage.keys.get(body.id);
    expect(stored?.space_id).toBe(target.id);
    expect(stored?.space_id).not.toBe(other.id);
    expect(stored?.is_operator).toBe(false);
  });

  it("GET /admin/spaces/:id — 404 on unknown space", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/admin/spaces/01999999-9999-7999-8999-999999999999",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  /**
   * Verification #4 from the orchestrator. The core value proposition of
   * the operator key is cross-space authority — the tests above use
   * the seeded admin (space-less). This one creates a SECOND space and
   * confirms the operator key can read its metrics directly without
   * any session ownership of the target space.
   */
  it("the operator key reads another space's metrics + show + keys cross-space", async () => {
    if (!ctx.storage.spaces) return;
    const spaceB = await ctx.storage.spaces.create("cross-space-target");
    // Mint a non-platform key inside spaceB so listForSpace has a hit.
    await mintSpaceKey(spaceB.id);

    const showRes = await request(
      ctx.app,
      "GET",
      `/admin/spaces/${spaceB.id}`,
      { key: ctx.adminKey },
    );
    expect(showRes.status).toBe(200);

    const metricsRes = await request(
      ctx.app,
      "GET",
      `/admin/spaces/${spaceB.id}/metrics`,
      { key: ctx.adminKey },
    );
    expect(metricsRes.status).toBe(200);
    const metrics = (await metricsRes.json()) as {
      space_id: string;
      items: { total: number };
      blobs: { count: number; total_size: number };
    };
    expect(metrics.space_id).toBe(spaceB.id);
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
      `/admin/spaces/${spaceB.id}/keys`,
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

describe("space suspension", () => {
  it("suspend flips status, blocks subsequent writes, and emits an audit row", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("suspend-write-block");
    const memberKey = await mintSpaceKey(t.id);

    // Baseline — a space credential can write before suspension.
    const beforeWrite = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "pre-suspend" } },
    });
    expect(beforeWrite.status).toBe(201);

    // Suspend via the admin route. Returns the updated space row.
    const suspendRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${t.id}/suspend`,
      { key: ctx.adminKey },
    );
    expect(suspendRes.status).toBe(200);
    const suspended = (await suspendRes.json()) as {
      id: string;
      status: string;
    };
    expect(suspended.status).toBe("suspended");

    // Subsequent writes are rejected at the auth middleware. The suspend
    // route evicts the per-instance status cache for this space, so the
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
    expect(afterBody.error.code).toBe("space_suspended");

    // Reads still pass through.
    const readRes = await request(ctx.app, "GET", "/items", {
      key: memberKey,
    });
    expect(readRes.status).toBe(200);

    // Audit row landed.
    const audit = await waitForAudit(
      () =>
        ctx.storage.audit.list({
          action: "space.suspend",
          limit: 50,
        }),
      (page) => page.data.some((row) => row.resource_id === t.id),
    );
    expect(audit.data.some((row) => row.resource_id === t.id)).toBe(true);
  });

  it("unsuspend reverses status, restores writes, and emits an audit row", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("unsuspend-restore");

    await request(ctx.app, "POST", `/admin/spaces/${t.id}/suspend`, {
      key: ctx.adminKey,
    });
    const unsuspendRes = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${t.id}/unsuspend`,
      { key: ctx.adminKey },
    );
    expect(unsuspendRes.status).toBe(200);
    const restored = (await unsuspendRes.json()) as { status: string };
    expect(restored.status).toBe("active");

    // Cache was evicted by the unsuspend route — next write reads the
    // restored `active` row.
    const memberKey = await mintSpaceKey(t.id);
    const write = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "post-unsuspend" } },
    });
    expect(write.status).toBe(201);

    const audit = await waitForAudit(
      () => ctx.storage.audit.list({ action: "space.unsuspend", limit: 50 }),
      (page) => page.data.some((row) => row.resource_id === t.id),
    );
    expect(audit.data.some((row) => row.resource_id === t.id)).toBe(true);
  });

  it("suspend on unknown space — 404", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/admin/spaces/01999999-9999-7999-8999-999999999999/suspend",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  it("the operator key can still write to a suspended space (bypass)", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("platform-bypass");
    await request(ctx.app, "POST", `/admin/spaces/${t.id}/suspend`, {
      key: ctx.adminKey,
    });
    // The operator key operates without a `space_id`, but a real write
    // that targets the suspended space — e.g. flipping quotas — must
    // succeed. PUT /spaces/:id/quotas is the canonical operator write
    // surface.
    const quotaRes = await request(ctx.app, "PUT", `/spaces/${t.id}/quotas`, {
      key: ctx.adminKey,
      body: { items_limit: 9999 },
    });
    expect(quotaRes.status).toBe(200);
  });
});

// ===========================================================================
// POST /admin/account-deletion/purge-now
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
  const dialect = process.env.DB_DIALECT ?? "sqlite";
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

describe("POST /admin/account-deletion/purge-now", () => {
  it("401 without credentials", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/admin/account-deletion/purge-now",
    );
    expect(res.status).toBe(401);
  });

  it("403 with a non-platform key", async () => {
    if (!ctx.storage.spaces) return;
    const t = await ctx.storage.spaces.create("purge-now-403");
    const memberKey = await mintSpaceKey(t.id);
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
            row.space_id === null,
        ),
    );
    const row = audit.data.find(
      (r) => r.resource_id === "account-deletion-purger",
    );
    expect(row).toBeDefined();
    expect(row?.space_id).toBeNull();
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
// graceDays: 0 short-circuit (separate test context)
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
      await ctx0.cleanup();
    }
  });
});
