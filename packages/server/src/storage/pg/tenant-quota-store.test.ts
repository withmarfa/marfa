import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";
import { auth_user, tenantQuotas, tenants, users } from "./schema.js";

const isPg = process.env.DB_DIALECT === "pg";

describe.skipIf(!isPg)(
  "PgTenantQuotaStore tenant deletion serialization",
  () => {
    let ctx: TestContext;
    let pgDb: PgDb;

    beforeAll(async () => {
      ctx = await createTestContext({ authMode: "hosted" });
      pgDb = ctx.storage.pgDb as PgDb;
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("returns null when deletion wins the tenant row lock", async () => {
      const tenant = await ctx.storage.tenants!.create("Quota race tenant");
      await ctx.storage.tenantQuotas.set(tenant.id, { items_limit: 5 });

      let releaseDeletion!: () => void;
      const deletionMayContinue = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      let tenantLocked!: () => void;
      const deletionHasLock = new Promise<void>((resolve) => {
        tenantLocked = resolve;
      });

      const deletion = pgDb.transaction(async (tx) => {
        await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenant.id))
          .for("update");
        tenantLocked();
        await deletionMayContinue;
        await tx
          .delete(tenantQuotas)
          .where(eq(tenantQuotas.tenant_id, tenant.id));
        await tx.delete(tenants).where(eq(tenants.id, tenant.id));
      });

      await deletionHasLock;
      const update = ctx.storage.tenantQuotas.setForExistingTenant(tenant.id, {
        items_limit: 10,
      });

      // The update is now contending for the row lock held by deletion. Once
      // deletion commits, its SELECT FOR UPDATE re-check observes no tenant and
      // returns null instead of upserting an orphan or surfacing a DB error.
      const settledWhileLocked = await Promise.race([
        update.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => {
            resolve(false);
          }, 100),
        ),
      ]);
      expect(settledWhileLocked).toBe(false);

      releaseDeletion();
      await deletion;

      await expect(update).resolves.toBeNull();
      await expect(ctx.storage.tenantQuotas.get(tenant.id)).resolves.toBeNull();
    });

    it("reports an unknown tenant when deletion wins a quota read", async () => {
      const tenant = await ctx.storage.tenants!.create(
        "Quota read race tenant",
      );
      await ctx.storage.tenantQuotas.set(tenant.id, { items_limit: 5 });

      let releaseDeletion!: () => void;
      const deletionMayContinue = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      let tenantLocked!: () => void;
      const deletionHasLock = new Promise<void>((resolve) => {
        tenantLocked = resolve;
      });

      const deletion = pgDb.transaction(async (tx) => {
        await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenant.id))
          .for("update");
        tenantLocked();
        await deletionMayContinue;
        await tx
          .delete(tenantQuotas)
          .where(eq(tenantQuotas.tenant_id, tenant.id));
        await tx.delete(tenants).where(eq(tenants.id, tenant.id));
      });

      await deletionHasLock;
      const read = ctx.storage.tenantQuotas.getForExistingTenant(tenant.id);
      const settledWhileLocked = await Promise.race([
        read.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => {
            resolve(false);
          }, 100),
        ),
      ]);
      expect(settledWhileLocked).toBe(false);

      releaseDeletion();
      await deletion;
      await expect(read).resolves.toEqual({ exists: false, quota: null });
    });

    it("holds off a quota update while the real account cascade tears the tenant down", async () => {
      const tenant = await ctx.storage.tenants!.create("Cascade race tenant");
      await ctx.storage.tenantQuotas.set(tenant.id, { items_limit: 5 });
      // The cascade only reaches `items.bulkPurge` when the tenant owns at
      // least one item, and that call is this test's window into the
      // transaction.
      await ctx.storage.items.create(
        { type: "core.note", properties: { body: "cascade race" } },
        tenant.id,
      );

      const authUserId = `auth_${randomUUID()}`;
      const stampedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await pgDb.insert(auth_user).values({
        id: authUserId,
        name: "Cascade race user",
        email: `${authUserId}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletion_state: "pending_deletion",
        pending_deletion_at: stampedAt,
      });
      await pgDb.insert(users).values({
        id: `usr_${randomUUID()}`,
        provider: "test",
        provider_id: authUserId,
        tenant_id: tenant.id,
        auth_user_id: authUserId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const originalBulkPurge = ctx.storage.items.bulkPurge.bind(
        ctx.storage.items,
      );
      let cascadeInsideTransaction!: () => void;
      const cascadeReachedItems = new Promise<void>((resolve) => {
        cascadeInsideTransaction = resolve;
      });
      let releaseCascade!: () => void;
      const cascadeMayContinue = new Promise<void>((resolve) => {
        releaseCascade = resolve;
      });
      ctx.storage.items.bulkPurge = async (ids, tenantId) => {
        if (tenantId === tenant.id) {
          cascadeInsideTransaction();
          await cascadeMayContinue;
        }
        return originalBulkPurge(ids, tenantId);
      };

      try {
        const cutoffIso = new Date().toISOString();
        const cascade = ctx.storage.deleteAccountCascade(authUserId, cutoffIso);
        await cascadeReachedItems;

        // The cascade is mid-teardown and holds the tenant row lock. A quota
        // update must not be allowed to decide against a tenant that is being
        // deleted; without the lock it reads the row as live, writes, and
        // leaves quotas behind for a tenant that no longer exists.
        const update = ctx.storage.tenantQuotas.setForExistingTenant(
          tenant.id,
          { items_limit: 10 },
        );
        const settledWhileLocked = await Promise.race([
          update.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => {
              resolve(false);
            }, 100),
          ),
        ]);
        expect(settledWhileLocked).toBe(false);

        releaseCascade();
        await expect(cascade).resolves.toBe(true);
        await expect(update).resolves.toBeNull();

        const residualQuotas = await pgDb
          .select()
          .from(tenantQuotas)
          .where(eq(tenantQuotas.tenant_id, tenant.id));
        expect(residualQuotas).toEqual([]);
        const residualTenants = await pgDb
          .select()
          .from(tenants)
          .where(eq(tenants.id, tenant.id));
        expect(residualTenants).toEqual([]);
      } finally {
        releaseCascade();
        ctx.storage.items.bulkPurge = originalBulkPurge;
      }
    });

    it("returns a coherent tenant and quota snapshot when the reader wins", async () => {
      const tenant = await ctx.storage.tenants!.create("Quota read tenant");
      await ctx.storage.tenantQuotas.set(tenant.id, { items_limit: 7 });

      await expect(
        ctx.storage.tenantQuotas.getForExistingTenant(tenant.id),
      ).resolves.toMatchObject({
        exists: true,
        quota: { tenant_id: tenant.id, items_limit: 7 },
      });
    });
  },
);
