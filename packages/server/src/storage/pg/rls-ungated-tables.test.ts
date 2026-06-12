/**
 * Postgres RLS enforcement for the four previously-ungated tenant tables:
 * `users`, `tenant_quotas`, `outbound_webhook_deliveries`, and
 * `inbound_webhook_events` (migration 0067).
 *
 * For each table: seed two tenants on the owner connection (RLS-exempt),
 * then run an unscoped `SELECT` under `SET LOCAL ROLE marfa_app` +
 * `marfa.tenant_id = tenantA`. The policy must expose tenant A's rows and
 * hide tenant B's — proving RLS bites at the DB layer independent of any
 * application-layer WHERE clause. The two child tables (deliveries /
 * events) carry no `tenant_id` column; their policies join to the parent
 * webhook, so the test also proves the join predicate filters correctly.
 *
 * Plus the load-bearing NO-FORCE invariant: with RLS enabled on `users`,
 * an owner-connection sign-up still provisions a `users` row, and the
 * bearer-middleware role projection (also an owner-connection read) still
 * resolves the user's role. A `FORCE ROW LEVEL SECURITY` on `users` would
 * break both — this suite is the regression guard that keeps the migration
 * on plain `ENABLE`.
 *
 * SQLite skips the entire suite — RLS is a Postgres-only concern.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestContext,
  request,
  seedOauthBearer,
  type TestContext,
} from "../../test-utils.js";
import type { PgDb } from "./connection.js";

const dialect = process.env.DB_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe.skipIf(!isPg)("Postgres RLS — ungated tables (0067)", () => {
  describe("cross-tenant isolation under SET LOCAL ROLE marfa_app", () => {
    let ctx: TestContext;
    let owner: (q: string, p?: unknown[]) => Promise<unknown>;
    let pgDb: PgDb;

    beforeAll(async () => {
      ctx = await createTestContext({ rlsEnforce: true });
      const s = ctx.storage as unknown as {
        __pgClient: (q: string, p?: unknown[]) => Promise<unknown>;
        pgDb: PgDb;
      };
      owner = s.__pgClient;
      pgDb = s.pgDb;
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    /**
     * Run an unscoped SELECT as marfa_app with the tenant GUC pinned to
     * `tenant`, returning the set of `id`s the policy lets through.
     */
    async function visibleIdsForTenant(
      tenant: string,
      query: ReturnType<typeof sql>,
    ): Promise<Set<string>> {
      return pgDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('marfa.tenant_id', ${tenant}, true)`,
        );
        await tx.execute(sql`SET LOCAL ROLE marfa_app`);
        const rows = await tx.execute<{ id: string }>(query);
        return new Set(rows.map((r) => r.id));
      });
    }

    it("filters users cross-tenant", async () => {
      const tenantA = `users-a-${rand()}`;
      const tenantB = `users-b-${rand()}`;
      const now = new Date().toISOString();
      for (const t of [tenantA, tenantB]) {
        await owner(
          `INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3)`,
          [t, `Tenant ${t}`, now],
        );
      }
      const userA = `u-a-${rand()}`;
      const userB = `u-b-${rand()}`;
      await owner(
        `INSERT INTO users (id, name, provider, provider_id, tenant_id, created_at, updated_at)
           VALUES ($1, 'A', 'test', $1, $2, $3, $3)`,
        [userA, tenantA, now],
      );
      await owner(
        `INSERT INTO users (id, name, provider, provider_id, tenant_id, created_at, updated_at)
           VALUES ($1, 'B', 'test', $1, $2, $3, $3)`,
        [userB, tenantB, now],
      );

      const usersQuery = sql`SELECT id FROM users WHERE id IN (${userA}, ${userB})`;
      const seenA = await visibleIdsForTenant(tenantA, usersQuery);
      expect(seenA.has(userA)).toBe(true);
      expect(seenA.has(userB)).toBe(false);

      const seenB = await visibleIdsForTenant(tenantB, usersQuery);
      expect(seenB.has(userB)).toBe(true);
      expect(seenB.has(userA)).toBe(false);
    });

    it("filters tenant_quotas cross-tenant", async () => {
      const tenantA = `quota-a-${rand()}`;
      const tenantB = `quota-b-${rand()}`;
      const now = new Date().toISOString();
      await owner(
        `INSERT INTO tenant_quotas (tenant_id, items_limit, updated_at) VALUES ($1, 10, $2)`,
        [tenantA, now],
      );
      await owner(
        `INSERT INTO tenant_quotas (tenant_id, items_limit, updated_at) VALUES ($1, 20, $2)`,
        [tenantB, now],
      );

      // PK is tenant_id, so the visible "id" is the tenant_id itself.
      const quotaQuery = sql`SELECT tenant_id AS id FROM tenant_quotas WHERE tenant_id IN (${tenantA}, ${tenantB})`;
      const seenA = await visibleIdsForTenant(tenantA, quotaQuery);
      expect(seenA.has(tenantA)).toBe(true);
      expect(seenA.has(tenantB)).toBe(false);

      const seenB = await visibleIdsForTenant(tenantB, quotaQuery);
      expect(seenB.has(tenantB)).toBe(true);
      expect(seenB.has(tenantA)).toBe(false);
    });

    it("filters outbound_webhook_deliveries cross-tenant via the parent join", async () => {
      const tenantA = `owd-a-${rand()}`;
      const tenantB = `owd-b-${rand()}`;
      const now = new Date().toISOString();
      const hookA = `hook-a-${rand()}`;
      const hookB = `hook-b-${rand()}`;
      await owner(
        `INSERT INTO outbound_webhooks (id, tenant_id, url, secret, created_at, updated_at)
           VALUES ($1, $2, 'https://a.example/hook', 's', $3, $3)`,
        [hookA, tenantA, now],
      );
      await owner(
        `INSERT INTO outbound_webhooks (id, tenant_id, url, secret, created_at, updated_at)
           VALUES ($1, $2, 'https://b.example/hook', 's', $3, $3)`,
        [hookB, tenantB, now],
      );
      const delA = `del-a-${rand()}`;
      const delB = `del-b-${rand()}`;
      await owner(
        `INSERT INTO outbound_webhook_deliveries (id, webhook_id, event, attempt, created_at)
           VALUES ($1, $2, 'item.created', 1, $3)`,
        [delA, hookA, now],
      );
      await owner(
        `INSERT INTO outbound_webhook_deliveries (id, webhook_id, event, attempt, created_at)
           VALUES ($1, $2, 'item.created', 1, $3)`,
        [delB, hookB, now],
      );

      const delQuery = sql`SELECT id FROM outbound_webhook_deliveries WHERE id IN (${delA}, ${delB})`;
      const seenA = await visibleIdsForTenant(tenantA, delQuery);
      expect(seenA.has(delA)).toBe(true);
      expect(seenA.has(delB)).toBe(false);

      const seenB = await visibleIdsForTenant(tenantB, delQuery);
      expect(seenB.has(delB)).toBe(true);
      expect(seenB.has(delA)).toBe(false);
    });

    it("filters inbound_webhook_events cross-tenant via the parent join", async () => {
      const tenantA = `iwe-a-${rand()}`;
      const tenantB = `iwe-b-${rand()}`;
      const now = new Date().toISOString();
      const hookA = `inhook-a-${rand()}`;
      const hookB = `inhook-b-${rand()}`;
      await owner(
        `INSERT INTO inbound_webhooks
           (id, tenant_id, connection_id, secret_encrypted, verification_method, created_at, updated_at)
           VALUES ($1, $2, 'conn-a', 'enc', 'hmac-sha256', $3, $3)`,
        [hookA, tenantA, now],
      );
      await owner(
        `INSERT INTO inbound_webhooks
           (id, tenant_id, connection_id, secret_encrypted, verification_method, created_at, updated_at)
           VALUES ($1, $2, 'conn-b', 'enc', 'hmac-sha256', $3, $3)`,
        [hookB, tenantB, now],
      );
      const evtA = `evt-a-${rand()}`;
      const evtB = `evt-b-${rand()}`;
      await owner(
        `INSERT INTO inbound_webhook_events
           (id, inbound_webhook_id, external_delivery_id, received_at, payload, verified)
           VALUES ($1, $2, $1, $3, '{}', 1)`,
        [evtA, hookA, now],
      );
      await owner(
        `INSERT INTO inbound_webhook_events
           (id, inbound_webhook_id, external_delivery_id, received_at, payload, verified)
           VALUES ($1, $2, $1, $3, '{}', 1)`,
        [evtB, hookB, now],
      );

      const evtQuery = sql`SELECT id FROM inbound_webhook_events WHERE id IN (${evtA}, ${evtB})`;
      const seenA = await visibleIdsForTenant(tenantA, evtQuery);
      expect(seenA.has(evtA)).toBe(true);
      expect(seenA.has(evtB)).toBe(false);

      const seenB = await visibleIdsForTenant(tenantB, evtQuery);
      expect(seenB.has(evtB)).toBe(true);
      expect(seenB.has(evtA)).toBe(false);
    });
  });

  // The whole reason the migration uses plain ENABLE and never FORCE: the
  // owner-connection paths that touch `users` carry no `marfa.tenant_id`
  // GUC. A FORCE would policy-check them against an empty GUC and fail.
  describe("NO-FORCE invariant on users (owner-connection paths)", () => {
    const ORIGIN = "http://localhost:0";

    it("sign-up still provisions a users row with RLS enabled", async () => {
      const ctx = await createTestContext({
        rlsEnforce: true,
        authMode: "hosted",
        authAllowSignup: true,
      });
      try {
        const res = await request(ctx.app, "POST", "/auth/sign-up/email", {
          body: {
            email: `signup-${rand()}@example.com`,
            password: "correct horse battery staple",
            name: "Sign Up",
          },
          headers: { origin: ORIGIN },
        });
        expect(res.status).toBe(200);
        const authUserId = ((await res.json()) as { user?: { id?: string } })
          .user?.id;
        expect(authUserId).toBeTruthy();

        // The provisioning hook wrote a `users` row on the OWNER connection
        // (no GUC). If `users` carried FORCE RLS, this INSERT would have
        // failed and the sign-up would have 500'd above.
        const row = await ctx.storage.users?.getByAuthUserId(authUserId ?? "");
        expect(row?.tenant_id).toBeTruthy();
      } finally {
        await ctx.cleanup();
      }
    });

    it("bearer-middleware role projection still resolves users.role with RLS enabled", async () => {
      const ctx = await createTestContext({
        rlsEnforce: true,
        authMode: "hosted",
      });
      try {
        if (!ctx.storage.tenants) throw new Error("hosted storage expected");
        const tenant = await ctx.storage.tenants.create("proj-tenant");
        const { token } = await seedOauthBearer(ctx.storage, [], {
          tenantId: tenant.id,
          userRole: "admin",
        });

        // GET /keys is admin-role-gated. It resolves only if the bearer
        // middleware's `users.getByAuthUserId` lookup (owner connection,
        // no GUC) projected the role — which a FORCE on `users` would
        // have broken.
        const res = await request(ctx.app, "GET", "/keys", { key: token });
        expect(res.status).toBe(200);
      } finally {
        await ctx.cleanup();
      }
    });
  });
});
