import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";
import { auth_user, spaceQuotas, spaces, users } from "./schema.js";

const isPg = process.env.DB_DIALECT === "pg";

describe.skipIf(!isPg)("PgSpaceQuotaStore space deletion serialization", () => {
  let ctx: TestContext;
  let pgDb: PgDb;

  beforeAll(async () => {
    ctx = await createTestContext({ authMode: "hosted" });
    pgDb = ctx.storage.pgDb as PgDb;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns null when deletion wins the space row lock", async () => {
    const space = await ctx.storage.spaces!.create("Quota race space");
    await ctx.storage.spaceQuotas.set(space.id, { items_limit: 5 });

    let releaseDeletion!: () => void;
    const deletionMayContinue = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let spaceLocked!: () => void;
    const deletionHasLock = new Promise<void>((resolve) => {
      spaceLocked = resolve;
    });

    const deletion = pgDb.transaction(async (tx) => {
      await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, space.id))
        .for("update");
      spaceLocked();
      await deletionMayContinue;
      await tx.delete(spaceQuotas).where(eq(spaceQuotas.space_id, space.id));
      await tx.delete(spaces).where(eq(spaces.id, space.id));
    });

    await deletionHasLock;
    const update = ctx.storage.spaceQuotas.setForExistingSpace(space.id, {
      items_limit: 10,
    });

    // The update is now contending for the row lock held by deletion. Once
    // deletion commits, its SELECT FOR UPDATE re-check observes no space and
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
    await expect(ctx.storage.spaceQuotas.get(space.id)).resolves.toBeNull();
  });

  it("reports an unknown space when deletion wins a quota read", async () => {
    const space = await ctx.storage.spaces!.create("Quota read race space");
    await ctx.storage.spaceQuotas.set(space.id, { items_limit: 5 });

    let releaseDeletion!: () => void;
    const deletionMayContinue = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let spaceLocked!: () => void;
    const deletionHasLock = new Promise<void>((resolve) => {
      spaceLocked = resolve;
    });

    const deletion = pgDb.transaction(async (tx) => {
      await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, space.id))
        .for("update");
      spaceLocked();
      await deletionMayContinue;
      await tx.delete(spaceQuotas).where(eq(spaceQuotas.space_id, space.id));
      await tx.delete(spaces).where(eq(spaces.id, space.id));
    });

    await deletionHasLock;
    const read = ctx.storage.spaceQuotas.getForExistingSpace(space.id);
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

  it("holds off a quota update while the real account cascade tears the space down", async () => {
    const space = await ctx.storage.spaces!.create("Cascade race space");
    await ctx.storage.spaceQuotas.set(space.id, { items_limit: 5 });
    // The cascade only reaches `items.bulkPurge` when the space owns at
    // least one item, and that call is this test's window into the
    // transaction.
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "cascade race" } },
      space.id,
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
      space_id: space.id,
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
    ctx.storage.items.bulkPurge = async (ids, spaceId) => {
      if (spaceId === space.id) {
        cascadeInsideTransaction();
        await cascadeMayContinue;
      }
      return originalBulkPurge(ids, spaceId);
    };

    try {
      const cutoffIso = new Date().toISOString();
      const cascade = ctx.storage.deleteAccountCascade(authUserId, cutoffIso);
      await cascadeReachedItems;

      // The cascade is mid-teardown and holds the space row lock. A quota
      // update must not be allowed to decide against a space that is being
      // deleted; without the lock it reads the row as live, writes, and
      // leaves quotas behind for a space that no longer exists.
      const update = ctx.storage.spaceQuotas.setForExistingSpace(space.id, {
        items_limit: 10,
      });
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
        .from(spaceQuotas)
        .where(eq(spaceQuotas.space_id, space.id));
      expect(residualQuotas).toEqual([]);
      const residualSpaces = await pgDb
        .select()
        .from(spaces)
        .where(eq(spaces.id, space.id));
      expect(residualSpaces).toEqual([]);
    } finally {
      releaseCascade();
      ctx.storage.items.bulkPurge = originalBulkPurge;
    }
  });

  it("returns a coherent space and quota snapshot when the reader wins", async () => {
    const space = await ctx.storage.spaces!.create("Quota read space");
    await ctx.storage.spaceQuotas.set(space.id, { items_limit: 7 });

    await expect(
      ctx.storage.spaceQuotas.getForExistingSpace(space.id),
    ).resolves.toMatchObject({
      exists: true,
      quota: { space_id: space.id, items_limit: 7 },
    });
  });
});
