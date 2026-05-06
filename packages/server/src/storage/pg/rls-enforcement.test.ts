/**
 * T-025 part 2 — Postgres RLS connection-pool enforcement.
 *
 * Verifies the request-level wiring actually filters cross-tenant
 * data via DB-layer RLS, not just the application-layer scoping.
 *
 * Two test surfaces:
 *
 *   1. **Direct DB-layer.** Open a Drizzle transaction, run `SET
 *      LOCAL ROLE myme_app; SELECT set_config('myme.tenant_id',
 *      tenantA, true)`, then issue an *unscoped* `SELECT * FROM
 *      items` (no WHERE clause). RLS must filter to tenant A's rows.
 *      This proves the policies bite the role even when the
 *      application layer would have leaked.
 *
 *   2. **End-to-end via the middleware.** Boot the test context
 *      with `rlsEnforce: true`, mint a tenant-bound key, request
 *      `/items/<other-tenant-item>` as tenant A → 404 (RLS denies
 *      the row, the route's `get(id, tenantId)` returns nothing).
 *      The middleware activates the role-switch wrapper.
 *
 * SQLite skips — RLS is Postgres-only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestContext,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../../test-utils.js";
import { hashApiKey } from "../../middleware/auth.js";
import type { PgDb } from "./connection.js";

const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

describe.skipIf(!isPg)("Postgres RLS enforcement (T-025 part 2)", () => {
  describe("direct DB-layer", () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestContext({ rlsEnforce: true });
    });

    afterAll(() => {
      ctx.cleanup();
    });

    it("filters cross-tenant SELECT under SET LOCAL ROLE myme_app", async () => {
      const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 8)}`;
      const tenantB = `tenant-b-${Math.random().toString(36).slice(2, 8)}`;

      // Create one item per tenant via the storage interface (running
      // as owner so RLS is bypassed; plain insert).
      const itemA = await ctx.storage.items.create(
        { type: "core.note", properties: { body: "tenant A item" } },
        tenantA,
      );
      const itemB = await ctx.storage.items.create(
        { type: "core.note", properties: { body: "tenant B item" } },
        tenantB,
      );

      // Now run as myme_app inside a transaction with tenant_id =
      // tenantA. The unscoped SELECT must return only tenant A's rows
      // — proving RLS filters at the DB layer, independent of the
      // application's WHERE clauses.
      const pgDb = (ctx.storage as unknown as { pgDb: PgDb }).pgDb;
      const seenIdsForA = await pgDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('myme.tenant_id', ${tenantA}, true)`,
        );
        await tx.execute(sql`SET LOCAL ROLE myme_app`);
        // Use the row-level helper so we hit the policy.
        const rows = await tx.execute<{ id: string; tenant_id: string }>(
          sql`SELECT id, tenant_id FROM items WHERE id IN (${itemA.id}, ${itemB.id})`,
        );
        return new Set(rows.map((r) => r.id));
      });

      expect(seenIdsForA.has(itemA.id)).toBe(true);
      expect(seenIdsForA.has(itemB.id)).toBe(false);

      // And the symmetric case for tenant B.
      const seenIdsForB = await pgDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('myme.tenant_id', ${tenantB}, true)`,
        );
        await tx.execute(sql`SET LOCAL ROLE myme_app`);
        const rows = await tx.execute<{ id: string; tenant_id: string }>(
          sql`SELECT id, tenant_id FROM items WHERE id IN (${itemA.id}, ${itemB.id})`,
        );
        return new Set(rows.map((r) => r.id));
      });

      expect(seenIdsForB.has(itemA.id)).toBe(false);
      expect(seenIdsForB.has(itemB.id)).toBe(true);
    });

    it("returns to owner role after the transaction commits", async () => {
      const pgDb = (ctx.storage as unknown as { pgDb: PgDb }).pgDb;

      await pgDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('myme.tenant_id', 'x', true)`);
        await tx.execute(sql`SET LOCAL ROLE myme_app`);
      });

      // After the transaction commits, subsequent queries use the
      // owner role. A bare SELECT current_setting reads the setting
      // — empty string after `SET LOCAL` is cleared.
      const rows = await pgDb.execute<{ role: string; tenant: string }>(
        sql`SELECT current_user::text AS role, current_setting('myme.tenant_id', true) AS tenant`,
      );
      expect(rows[0]?.role).not.toBe("myme_app");
      // current_setting('myme.tenant_id', true) is per-session for
      // anything outside a SET LOCAL, but inside the txn we set
      // LOCAL — at this point the setting is cleared.
      expect(rows[0]?.tenant ?? "").toBe("");
    });
  });

  describe("end-to-end via the RLS middleware", () => {
    let ctx: TestContext;
    let tenantAKey: string;
    let tenantBKey: string;
    const tenantA = `tenant-e2e-a-${Math.random().toString(36).slice(2, 8)}`;
    const tenantB = `tenant-e2e-b-${Math.random().toString(36).slice(2, 8)}`;

    beforeAll(async () => {
      ctx = await createTestContext({ rlsEnforce: true });

      const mintKey = async (tenant: string) => {
        const suffix = Math.random().toString(36).slice(2, 10);
        const raw = `myme_k1_${tenant}_${suffix}`;
        await ctx.storage.keys.create(
          {
            label: `${tenant}-admin`,
            source: `${tenant}-source-${suffix}`,
            role: "admin",
            // workspace_admin would also pass; admin (with tenant_id
            // set) is the simplest path.
            type_permissions: { "*": "write" },
            default_tier: "library",
          },
          hashApiKey(raw, TEST_API_KEY_SALT),
          tenant,
        );
        return raw;
      };

      tenantAKey = await mintKey(tenantA);
      tenantBKey = await mintKey(tenantB);
    });

    afterAll(() => {
      ctx.cleanup();
    });

    it("denies cross-tenant GET /items/:id at the route level (404)", async () => {
      // Create an item as tenant B.
      const createRes = await ctx.app.request("/items", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenantBKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "core.note",
          properties: { body: "tenant B secret" },
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string };

      // Tenant A asks for tenant B's item id directly. Application
      // layer would have rejected via the tenant-scoped store; RLS
      // blocks the row at the DB even if the application layer is
      // bypassed.
      const probeRes = await ctx.app.request(`/items/${created.id}`, {
        headers: { authorization: `Bearer ${tenantAKey}` },
      });
      expect(probeRes.status).toBe(404);

      // And tenant B can still see its own item.
      const ownRes = await ctx.app.request(`/items/${created.id}`, {
        headers: { authorization: `Bearer ${tenantBKey}` },
      });
      expect(ownRes.status).toBe(200);
    });
  });
});
