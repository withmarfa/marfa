/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
/**
 * SQLite account hard-delete cascade.
 *
 * Mirrors pg/account-cascade.ts step-for-step. See that file for the
 * full design notes including the race-safety re-check at step 0.
 * The libsql adapter exposes the same Drizzle
 * `db.transaction(async tx => …)` shape as postgres-js, so the
 * end-to-end transactional guarantee is real.
 *
 * **Concurrency note for SQLite:** there is no `FOR UPDATE` — libsql
 * serializes all writes via the database file lock, so any concurrent
 * `cancelPendingDeletion` UPDATE on `auth_user` waits behind the
 * cascade transaction (or vice versa). The in-transaction re-check
 * still gates: if the cancel commits first, the cascade reads the
 * fresh `deletion_state = 'active'` row and short-circuits cleanly.
 */
import { eq, sql } from "drizzle-orm";
import type { Storage } from "../interface.js";
import {
  customTypes,
  customEdgeTypes,
  apiKeys,
  auth_user,
  auth_verification,
  blobs,
  connectionLeasedTokens,
  connectionOauthTokens,
  edges,
  inboundWebhooks,
  inboundWebhookEvents,
  items,
  outboundWebhooks,
  spaceQuotas,
  spaces,
  users,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";

type SqliteTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

/**
 * Delete every row scoped to a space, leaving the `spaces` row and the
 * auth island alone. The SQLite half of the pair; see the PG copy in
 * `storage/pg/account-cascade.ts` for the reasoning.
 *
 * The caller owns the transaction and the decision about whether the
 * space may go at all.
 */
export async function sqlitePurgeSpaceScopedRows(
  tx: SqliteTx,
  storage: Storage,
  spaceId: string,
): Promise<void> {
  await tx
    .delete(connectionOauthTokens)
    .where(eq(connectionOauthTokens.space_id, spaceId))
    .run();
  await tx
    .delete(connectionLeasedTokens)
    .where(eq(connectionLeasedTokens.space_id, spaceId))
    .run();
  await tx
    .delete(inboundWebhookEvents)
    .where(
      sql`${inboundWebhookEvents.inbound_webhook_id} IN (
            SELECT ${inboundWebhooks.id} FROM ${inboundWebhooks}
            WHERE ${inboundWebhooks.space_id} = ${spaceId}
          )`,
    )
    .run();
  await tx
    .delete(inboundWebhooks)
    .where(eq(inboundWebhooks.space_id, spaceId))
    .run();
  await tx.delete(edges).where(eq(edges.space_id, spaceId)).run();

  const spaceItems = await tx
    .select({ id: items.id })
    .from(items)
    .where(eq(items.space_id, spaceId))
    .all();
  const ids = spaceItems.map((r) => r.id);
  if (ids.length > 0) {
    await storage.items.bulkPurge(ids, spaceId);
  }

  await tx.delete(blobs).where(eq(blobs.space_id, spaceId)).run();
  await tx.delete(apiKeys).where(eq(apiKeys.space_id, spaceId)).run();
  await tx
    .delete(outboundWebhooks)
    .where(eq(outboundWebhooks.space_id, spaceId))
    .run();
  await tx.delete(spaceQuotas).where(eq(spaceQuotas.space_id, spaceId)).run();
  // The PG copy carries the reasoning: the space's own type vocabulary was
  // omitted from both dialects, so every space deletion left its
  // registrations behind. Both tables, because both are space-scoped, and
  // platform rows are untouched by construction since they carry
  // `space_id = ''`.
  await tx.delete(customTypes).where(eq(customTypes.space_id, spaceId)).run();
  await tx
    .delete(customEdgeTypes)
    .where(eq(customEdgeTypes.space_id, spaceId))
    .run();
}

/**
 * Hard-delete a space that no account owns. SQLite half; the PG copy
 * carries the reasoning, including why a space with users is refused
 * rather than deleted here and why this path's silence rests on a
 * different argument from the account cascade's.
 */
export async function sqliteDeleteSpace(
  db: DrizzleDb,
  storage: Storage,
  spaceId: string,
): Promise<"deleted" | "not_found" | "has_users"> {
  return db.transaction(async (tx) => {
    const row = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .get();
    if (!row) return "not_found";

    const owners = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.space_id, spaceId))
      .all();
    if (owners.length > 0) return "has_users";

    await sqlitePurgeSpaceScopedRows(tx, storage, spaceId);
    await tx.delete(spaces).where(eq(spaces.id, spaceId)).run();
    return "deleted";
  });
}

export async function sqliteDeleteAccountCascade(
  db: DrizzleDb,
  storage: Storage,
  authUserId: string,
  cutoffIso: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // ---- 0. Race-safety re-check. -----------------------------------------
    const lifecycleRow = await tx
      .select({
        deletion_state: auth_user.deletion_state,
        pending_deletion_at: auth_user.pending_deletion_at,
      })
      .from(auth_user)
      .where(eq(auth_user.id, authUserId))
      .get();
    if (
      lifecycleRow?.deletion_state !== "pending_deletion" ||
      !lifecycleRow.pending_deletion_at ||
      lifecycleRow.pending_deletion_at >= cutoffIso
    ) {
      return false;
    }

    const userRow = await tx
      .select({ space_id: users.space_id })
      .from(users)
      .where(eq(users.auth_user_id, authUserId))
      .get();
    const spaceId = userRow?.space_id ?? null;

    if (spaceId) {
      await sqlitePurgeSpaceScopedRows(tx, storage, spaceId);
    }

    await tx
      .delete(auth_verification)
      .where(eq(auth_verification.value, authUserId))
      .run();

    if (spaceId) {
      await tx.delete(users).where(eq(users.auth_user_id, authUserId)).run();
      // Drop the space only when no other users reference it (the
      // deleted row is already gone, so this counts genuinely-other
      // users). Mirrors pg/account-cascade.ts.
      const remaining = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.space_id, spaceId))
        .all();
      if (remaining.length === 0) {
        await tx.delete(spaces).where(eq(spaces.id, spaceId)).run();
      }
    }

    await storage.audit.redactForUser(authUserId);

    // Written AFTER the sweep — the sweep matches on resource_id, so a row
    // written before it is rewritten to the sentinel like any other. Order
    // is what makes this the one row that keeps its details payload.
    //
    // The propagating writer, because a hard delete nothing recorded must
    // not report success. `log` cannot reject, so it would answer success
    // whatever happened; the swallow is the difference between the two
    // writers, not where the write lands.
    //
    // The row is on this transaction, so a rollback takes it with it. That
    // is the wrapper's doing rather than this file's: the SQLite proxy
    // intercepts `transaction` and installs the active tx on its ALS, and
    // the audit store holds the wrapped instance. Postgres has no such
    // trap and its cascade installs the context by hand.
    await storage.audit.logOrThrow({
      action: "auth.account.hard_deleted",
      resource_type: "auth_account",
      resource_id: authUserId,
      details: { space_id: spaceId, redacted: false },
    });

    await tx.delete(auth_user).where(eq(auth_user.id, authUserId)).run();

    return true;
  });
}
