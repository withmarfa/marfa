import { sql } from "drizzle-orm";
import type { PgDb } from "./connection.js";
import { pgRequestContext } from "./request-context.js";

/**
 * Run `fn` with the connection's role forced to the database owner (the
 * connection's login role) for the duration of one transaction.
 *
 * `SET LOCAL ROLE NONE` resets to the session's authenticated role and is
 * transaction-scoped, so it is safe over a transaction-mode pooler — unlike a
 * session-level `SET ROLE`, which can strand on a shared backend. This is
 * defense-in-depth for writes that MUST bypass RLS (auth provisioning): even
 * if a session-level `SET ROLE marfa_app` ever stranded on this connection,
 * the writes inside `fn` still execute as the RLS-bypassing owner.
 *
 * Goes through the wrapped `db` (same as `runInTransaction`): the storage
 * proxy resolves nested calls against the installed transaction via the
 * request-context ALS, so storage methods invoked inside `fn` run on this
 * connection with the owner role applied.
 */
export async function withOwnerRole<T>(
  db: PgDb,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Transaction-scoped reset to the login (owner) role. Pooler-safe.
    await tx.execute(sql`SET LOCAL ROLE NONE`);
    return pgRequestContext.run({ tx }, fn);
  });
}
