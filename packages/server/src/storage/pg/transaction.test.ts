/**
 * T-160 — proves `runInTransaction` is genuinely transactional on
 * Postgres AND doesn't double-consume pool slots.
 *
 * Pre-T-160 PG's `runInTransaction` used `client.begin(async () => fn())`
 * which discarded the transaction-scoped query interface. Storage calls
 * inside `fn` fell through to the unwrapped base instance and acquired
 * SECOND pool connections per query, while the `begin` connection sat
 * `idle in transaction` waiting for queries that never came. Under
 * concurrent load the pool saturated, every `runInTransaction` callback
 * blocked acquiring an inner connection, and the server wedged. Now uses
 * the same `db.transaction` + ALS pattern as SQLite (T-071) so the inner
 * work flows through the transaction's reserved connection — one pool
 * slot per `runInTransaction`, not two.
 *
 * Three tests cover the contract:
 *   1. Throw mid-tx → both writes roll back.
 *   2. Successful tx → both writes persist.
 *   3. Concurrent runInTransaction calls don't deadlock at pool=10.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "../../test-utils.js";

const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

describe.skipIf(!isPg)("PgStorage.runInTransaction (T-160)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("rolls back every write inside an async transaction body when the body throws", async () => {
    const idA = "019d3333-3333-7333-a333-333333333331";
    const idB = "019d3333-3333-7333-a333-333333333332";

    await expect(
      ctx.storage.runInTransaction(async () => {
        await ctx.storage.items.create(
          {
            id: idA,
            type: "core.note",
            properties: { body: "rollback-alpha" },
          },
          undefined,
        );
        await ctx.storage.items.create(
          {
            id: idB,
            type: "core.note",
            properties: { body: "rollback-bravo" },
          },
          undefined,
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow(/force rollback/);

    expect(await ctx.storage.items.get(idA)).toBeNull();
    expect(await ctx.storage.items.get(idB)).toBeNull();
  });

  it("commits every write when the transaction body resolves", async () => {
    const idA = "019d4444-4444-7444-a444-444444444441";
    const idB = "019d4444-4444-7444-a444-444444444442";

    await ctx.storage.runInTransaction(async () => {
      await ctx.storage.items.create(
        {
          id: idA,
          type: "core.note",
          properties: { body: "commit-alpha" },
        },
        undefined,
      );
      await ctx.storage.items.create(
        {
          id: idB,
          type: "core.note",
          properties: { body: "commit-bravo" },
        },
        undefined,
      );
    });

    const a = await ctx.storage.items.get(idA);
    const b = await ctx.storage.items.get(idB);
    expect(a?.properties.body).toBe("commit-alpha");
    expect(b?.properties.body).toBe("commit-bravo");
  });

  it("supports concurrent runInTransaction calls without pool deadlock", async () => {
    // Pool size is 10 (`pg/connection.ts`). Pre-T-160, each
    // `runInTransaction` consumed two pool slots (one for the
    // discarded `client.begin` and one for each inner query via the
    // unwrapped baseDb), so >5 concurrent calls deadlocked. Post-fix,
    // each call holds one slot via the proxy + ALS routing. 12 parallel
    // writes here exceed the pool size on the old shape and pass on the
    // new shape.
    const concurrency = 12;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        ctx.storage.runInTransaction(async () => {
          return ctx.storage.items.create(
            {
              type: "core.note",
              properties: { body: `concurrent-${i.toString()}` },
            },
            undefined,
          );
        }),
      ),
    );

    expect(results).toHaveLength(concurrency);
    for (const item of results) {
      const fetched = await ctx.storage.items.get(item.id);
      expect(fetched).not.toBeNull();
    }
  });
});
