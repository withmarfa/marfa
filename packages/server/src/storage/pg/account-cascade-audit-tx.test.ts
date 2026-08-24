/**
 * The hard-delete audit row rides the cascade's transaction, on Postgres.
 *
 * The propagating writer guarantees that a failed audit write fails the
 * operation. It does not, on its own, put the write on the caller's
 * transaction: the audit store holds the request-context-wrapped Drizzle
 * instance, and with no context installed that wrapper falls through to the
 * pool. The PG cascade runs on the unwrapped base instance and threads `tx`
 * by hand, so nothing would have installed one — the row would commit on a
 * second connection, and a cascade that rolled back afterwards would leave a
 * permanent record of a hard delete that never happened.
 *
 * The second case pins that premise rather than only the guard. Without it
 * the first proves nothing: a mechanism that was never needed passes a test
 * that never distinguished it.
 *
 * SQLite skips the suite, and does not need it. Its proxy intercepts
 * `transaction` and installs the active tx on the ALS itself, so a store
 * holding the wrapped instance is already on the caller's transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";
import { pgRequestContext } from "./request-context.js";

const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

describe.skipIf(!isPg)("audit writes inside a cascade transaction", () => {
  let ctx: TestContext;
  let pgDb: PgDb;

  beforeAll(async () => {
    ctx = await createTestContext();
    pgDb = (ctx.storage as unknown as { pgDb: PgDb }).pgDb;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function rowsFor(action: string): Promise<number> {
    const { data } = await ctx.storage.audit.list({ action, limit: 5 });
    return data.length;
  }

  it("rolls the row back with the transaction when the context carries it", async () => {
    const action = `test.cascade.enrolled.${Math.random().toString(36).slice(2, 10)}`;

    await expect(
      pgDb.transaction(async (tx) => {
        await pgRequestContext.run({ tx }, () =>
          ctx.storage.audit.logOrThrow({
            action,
            resource_type: "auth_account",
            resource_id: "usr_rollback",
          }),
        );
        // Stands in for a later step of the cascade failing, or for the
        // commit itself failing. Either leaves the row claiming a deletion
        // that did not happen.
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow(/forced rollback/);

    expect(await rowsFor(action)).toBe(0);
  });

  it("survives the rollback when no context is installed, which is why the cascade installs one", async () => {
    const action = `test.cascade.escaped.${Math.random().toString(36).slice(2, 10)}`;

    await expect(
      pgDb.transaction(async () => {
        await ctx.storage.audit.logOrThrow({
          action,
          resource_type: "auth_account",
          resource_id: "usr_orphan",
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow(/forced rollback/);

    // The orphan. Awaiting the write and having it reject on failure buys
    // nothing here: it succeeded, on a connection of its own, and outlived
    // the transaction whose outcome it describes.
    expect(await rowsFor(action)).toBe(1);
  });
});
