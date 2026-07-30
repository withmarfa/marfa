/**
 * Postgres RLS enforcement for the four previously-ungated space tables:
 * `users`, `space_quotas`, `outbound_webhook_deliveries`, and
 * `inbound_webhook_events` (migration 0067).
 *
 * For each table: seed two spaces on the owner connection (RLS-exempt),
 * then run an unscoped `SELECT` under `SET LOCAL ROLE marfa_app` +
 * `marfa.space_id = spaceA`. The policy must expose space A's rows and
 * hide space B's — proving RLS bites at the DB layer independent of any
 * application-layer WHERE clause. The two child tables (deliveries /
 * events) carry no `space_id` column; their policies join to the parent
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
  describe("cross-space isolation under SET LOCAL ROLE marfa_app", () => {
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
     * Run an unscoped SELECT as marfa_app with the space GUC pinned to
     * `space`, returning the set of `id`s the policy lets through.
     */
    async function visibleIdsForSpace(
      space: string,
      query: ReturnType<typeof sql>,
    ): Promise<Set<string>> {
      return pgDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('marfa.space_id', ${space}, true)`,
        );
        await tx.execute(sql`SET LOCAL ROLE marfa_app`);
        const rows = await tx.execute<{ id: string }>(query);
        return new Set(rows.map((r) => r.id));
      });
    }

    it("filters users cross-space", async () => {
      const spaceA = `users-a-${rand()}`;
      const spaceB = `users-b-${rand()}`;
      const now = new Date().toISOString();
      for (const t of [spaceA, spaceB]) {
        await owner(
          `INSERT INTO spaces (id, name, created_at) VALUES ($1, $2, $3)`,
          [t, `Space ${t}`, now],
        );
      }
      const userA = `u-a-${rand()}`;
      const userB = `u-b-${rand()}`;
      await owner(
        `INSERT INTO users (id, name, provider, provider_id, space_id, created_at, updated_at)
           VALUES ($1, 'A', 'test', $1, $2, $3, $3)`,
        [userA, spaceA, now],
      );
      await owner(
        `INSERT INTO users (id, name, provider, provider_id, space_id, created_at, updated_at)
           VALUES ($1, 'B', 'test', $1, $2, $3, $3)`,
        [userB, spaceB, now],
      );

      const usersQuery = sql`SELECT id FROM users WHERE id IN (${userA}, ${userB})`;
      const seenA = await visibleIdsForSpace(spaceA, usersQuery);
      expect(seenA.has(userA)).toBe(true);
      expect(seenA.has(userB)).toBe(false);

      const seenB = await visibleIdsForSpace(spaceB, usersQuery);
      expect(seenB.has(userB)).toBe(true);
      expect(seenB.has(userA)).toBe(false);
    });

    it("filters space_quotas cross-space", async () => {
      const spaceA = `quota-a-${rand()}`;
      const spaceB = `quota-b-${rand()}`;
      const now = new Date().toISOString();
      await owner(
        `INSERT INTO space_quotas (space_id, items_limit, updated_at) VALUES ($1, 10, $2)`,
        [spaceA, now],
      );
      await owner(
        `INSERT INTO space_quotas (space_id, items_limit, updated_at) VALUES ($1, 20, $2)`,
        [spaceB, now],
      );

      // PK is space_id, so the visible "id" is the space_id itself.
      const quotaQuery = sql`SELECT space_id AS id FROM space_quotas WHERE space_id IN (${spaceA}, ${spaceB})`;
      const seenA = await visibleIdsForSpace(spaceA, quotaQuery);
      expect(seenA.has(spaceA)).toBe(true);
      expect(seenA.has(spaceB)).toBe(false);

      const seenB = await visibleIdsForSpace(spaceB, quotaQuery);
      expect(seenB.has(spaceB)).toBe(true);
      expect(seenB.has(spaceA)).toBe(false);
    });

    it("filters outbound_webhook_deliveries cross-space via the parent join", async () => {
      const spaceA = `owd-a-${rand()}`;
      const spaceB = `owd-b-${rand()}`;
      const now = new Date().toISOString();
      const hookA = `hook-a-${rand()}`;
      const hookB = `hook-b-${rand()}`;
      await owner(
        `INSERT INTO outbound_webhooks (id, space_id, url, secret, created_at, updated_at)
           VALUES ($1, $2, 'https://a.example/hook', 's', $3, $3)`,
        [hookA, spaceA, now],
      );
      await owner(
        `INSERT INTO outbound_webhooks (id, space_id, url, secret, created_at, updated_at)
           VALUES ($1, $2, 'https://b.example/hook', 's', $3, $3)`,
        [hookB, spaceB, now],
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
      const seenA = await visibleIdsForSpace(spaceA, delQuery);
      expect(seenA.has(delA)).toBe(true);
      expect(seenA.has(delB)).toBe(false);

      const seenB = await visibleIdsForSpace(spaceB, delQuery);
      expect(seenB.has(delB)).toBe(true);
      expect(seenB.has(delA)).toBe(false);
    });

    it("filters inbound_webhook_events cross-space via the parent join", async () => {
      const spaceA = `iwe-a-${rand()}`;
      const spaceB = `iwe-b-${rand()}`;
      const now = new Date().toISOString();
      const hookA = `inhook-a-${rand()}`;
      const hookB = `inhook-b-${rand()}`;
      await owner(
        `INSERT INTO inbound_webhooks
           (id, space_id, connection_id, secret_encrypted, verification_method, created_at, updated_at)
           VALUES ($1, $2, 'conn-a', 'enc', 'hmac-sha256', $3, $3)`,
        [hookA, spaceA, now],
      );
      await owner(
        `INSERT INTO inbound_webhooks
           (id, space_id, connection_id, secret_encrypted, verification_method, created_at, updated_at)
           VALUES ($1, $2, 'conn-b', 'enc', 'hmac-sha256', $3, $3)`,
        [hookB, spaceB, now],
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
      const seenA = await visibleIdsForSpace(spaceA, evtQuery);
      expect(seenA.has(evtA)).toBe(true);
      expect(seenA.has(evtB)).toBe(false);

      const seenB = await visibleIdsForSpace(spaceB, evtQuery);
      expect(seenB.has(evtB)).toBe(true);
      expect(seenB.has(evtA)).toBe(false);
    });
  });

  // The whole reason the migration uses plain ENABLE and never FORCE: the
  // owner-connection paths that touch `users` carry no `marfa.space_id`
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
        expect(row?.space_id).toBeTruthy();
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
        if (!ctx.storage.spaces) throw new Error("hosted storage expected");
        const space = await ctx.storage.spaces.create("proj-space");
        const { token } = await seedOauthBearer(ctx.storage, [], {
          spaceId: space.id,
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
