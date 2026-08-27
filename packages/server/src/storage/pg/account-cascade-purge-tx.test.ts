/**
 * The item purge rides the cascade's transaction, on Postgres.
 *
 * `storage.items` holds the request-context-wrapped Drizzle instance. The PG
 * cascade runs on the unwrapped base instance and threads `tx` by hand, so
 * unless something installs a context, `bulkPurge` falls through the wrapper
 * to the pool: it opens a transaction on a second connection and commits
 * independently of the cascade around it. A cascade that failed afterwards
 * would leave the items destroyed and the account alive.
 *
 * The second case pins that premise rather than only the guard. Without it
 * the first proves nothing: a mechanism that was never needed passes a test
 * that never distinguished it.
 *
 * The first case drives the real cascade rather than the mechanism, because
 * the mechanism working says nothing about whether the cascade uses it. It
 * also counts the purge call, since a cascade over a space owning no items
 * never reaches `bulkPurge` at all and would pass this test with the fix
 * reverted.
 *
 * SQLite skips the suite and does not need it. Its proxy intercepts
 * `transaction` and installs the active tx on the ALS itself, so a store
 * holding the wrapped instance is already on the caller's transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";
import { auth_user, users } from "./schema.js";

const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

describe.skipIf(!isPg)("the item purge inside a cascade transaction", () => {
  let ctx: TestContext;
  let pgDb: PgDb;

  beforeAll(async () => {
    ctx = await createTestContext();
    pgDb = (ctx.storage as unknown as { pgDb: PgDb }).pgDb;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  /** A space owning one item, and an account pending deletion that owns it. */
  async function accountOwningOneItem(label: string): Promise<{
    authUserId: string;
    spaceId: string;
    itemId: string;
  }> {
    const space = await ctx.storage.spaces!.create(label);
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: label } },
      space.id,
    );

    const authUserId = `auth_${randomUUID()}`;
    const stampedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await pgDb.insert(auth_user).values({
      id: authUserId,
      name: label,
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

    return { authUserId, spaceId: space.id, itemId: item.id };
  }

  it("leaves the items intact when the cascade rolls back after purging them", async () => {
    const { authUserId, spaceId, itemId } = await accountOwningOneItem(
      "Cascade purge rollback",
    );

    // A pass-through count, not a stub. The assertion below is only about
    // the purge if the purge actually ran.
    const originalBulkPurge = ctx.storage.items.bulkPurge.bind(
      ctx.storage.items,
    );
    let purgesForSpace = 0;
    ctx.storage.items.bulkPurge = async (ids, forSpace) => {
      if (forSpace === spaceId) purgesForSpace += 1;
      return originalBulkPurge(ids, forSpace);
    };

    // Fail six steps past the purge, where the cascade writes its audit
    // trail. Stands in for any later step failing, or for the commit itself.
    const originalLogOrThrow = ctx.storage.audit.logOrThrow.bind(
      ctx.storage.audit,
    );
    ctx.storage.audit.logOrThrow = () =>
      Promise.reject(new Error("forced cascade failure"));

    try {
      await expect(
        ctx.storage.deleteAccountCascade(authUserId, new Date().toISOString()),
      ).rejects.toThrow(/forced cascade failure/);
    } finally {
      ctx.storage.items.bulkPurge = originalBulkPurge;
      ctx.storage.audit.logOrThrow = originalLogOrThrow;
    }

    // The cascade reached the purge, so the next assertion is about it.
    expect(purgesForSpace).toBe(1);

    // And the purge went back with the transaction that failed around it.
    expect(await ctx.storage.items.get(itemId, spaceId)).not.toBeNull();
  });

  // If the Postgres proxy ever gains the transaction trap the SQLite one
  // already has, installing the active tx on the ALS itself, this case will
  // fail — because the escape it pins will no longer be possible. That is the
  // systemic fix and it makes this whole bug class unrepresentable. Delete
  // this case then rather than working around it: a test that has to be
  // defended against the fix for the thing it describes is measuring the
  // workaround instead of the behavior.
  it("commits despite the rollback when no context is installed, which is why the purge installs one", async () => {
    const { spaceId, itemId } = await accountOwningOneItem(
      "Cascade purge escape",
    );

    await expect(
      pgDb.transaction(async () => {
        await ctx.storage.items.bulkPurge([itemId], spaceId);
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow(/forced rollback/);

    // The orphan. The purge succeeded on a connection of its own and
    // outlived the transaction whose outcome should have decided it.
    expect(await ctx.storage.items.get(itemId, spaceId)).toBeNull();
  });
});
