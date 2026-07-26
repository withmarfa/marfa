import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";
import { tenantQuotas, tenants } from "./schema.js";

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
  },
);
