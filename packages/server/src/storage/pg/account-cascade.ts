/**
 * PG account hard-delete cascade.
 *
 * Tears down every artifact tied to an `auth_user.id` in a single
 * transaction. Order is chosen so each step's preconditions are
 * satisfied by the previous step's writes; rollback on any failure
 * leaves the account in `pending_deletion` for the next purger tick.
 *
 * **Race-safety re-check (step 0).** Before any writes, the cascade does
 * `SELECT ... FOR UPDATE` on the `auth_user` row and verifies
 * `deletion_state === 'pending_deletion'` AND
 * `pending_deletion_at < cutoffIso`. If either predicate fails — the user
 * cancelled between the purger's `listPendingDeletionDue` and this
 * transaction acquiring the row lock, or a fresh requestDelete landed but
 * hasn't yet aged into the grace cutoff — the cascade returns `false`
 * without touching anything. The `FOR UPDATE` lock blocks any concurrent
 * `cancelPendingDeletion` UPDATE on the same row until this transaction
 * either commits the cascade or rolls back. Returns `true` when the
 * cascade actually ran.
 *
 * Step ordering (after the step-0 re-check):
 *   1. Resolve `users.space_id`. If no row, only the auth_user
 *      cleanup runs (the user never had a space — a single-space
 *      self-host shape, or a sign-up that bailed before space
 *      provisioning).
 *   2. Per-space teardown of connection-related artifacts. The full
 *      `performUninstall` pipeline isn't reachable from storage
 *      (route-layer concern), so we do the minimal subset of its
 *      effects directly: revoke `connection_oauth_tokens`, revoke
 *      `connection_leased_tokens`, drop `inbound_webhooks` /
 *      `inbound_webhook_events`. The user's items themselves are
 *      bulk-purged in step 4 so the `system.connection` rows go too.
 *   3. Teardown of edges (`deleteBySource` / `deleteByTarget` would
 *      be N queries; do a single `DELETE FROM edges WHERE space_id`).
 *   4. Bulk-purge every item under the space (cascades metadata +
 *      versions via FK; search index needs explicit cleanup which
 *      `ItemStore.bulkPurge` already wires).
 *   5. Space-scoped blob rows.
 *   6. `api_keys` + outbound/inbound webhooks + `space_quotas`.
 *   7. `auth_verification` rows referencing this user (the cancel
 *      token + any in-flight reset/verify tokens — all keyed by
 *      `value = authUserId`).
 *   8. `users` row, `spaces` row.
 *   9. `audit.redactForUser(authUserId)` to scrub PII.
 *  10. `auth.account.hard_deleted` audit row (AFTER the sweep, so it
 *      is the one row that keeps its details payload).
 *   11. `auth_user` row — FK cascades drop `auth_session`,
 *      `auth_account`, `auth_passkey`.
 *
 * The function takes the full `Storage` so step 4 / step 9 / step 10
 * flow through the store layer (search-index cleanup; audit log
 * insertion; sub-store delete methods). Cross-table raw SQL is used
 * only where bulk efficiency matters (edges, blobs, api_keys,
 * webhooks, space_quotas, auth_verification).
 */
import { eq, sql } from "drizzle-orm";
import type { Storage } from "../interface.js";
import {
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
import type { PgDb } from "./connection.js";

export async function pgDeleteAccountCascade(
  db: PgDb,
  storage: Storage,
  authUserId: string,
  cutoffIso: string,
): Promise<boolean> {
  // Runs as the connection owner (no ALS space context installed by the purger),
  // bypassing per-space RLS. Search-index cleanup inside bulkPurge is best-effort
  // with respect to this transaction — residual FTS rows are self-healing.
  return db.transaction(async (tx) => {
    // ---- 0. Race-safety re-check. ----------------------------------------
    // SELECT ... FOR UPDATE on the auth_user row. The lock blocks any
    // concurrent cancelPendingDeletion UPDATE until this transaction
    // commits or rolls back. If state is no longer pending_deletion OR
    // pending_deletion_at >= cutoffIso (cancelled, or a fresh
    // requestDelete that hasn't aged into grace), short-circuit.
    const [lifecycleRow] = await tx
      .select({
        deletion_state: auth_user.deletion_state,
        pending_deletion_at: auth_user.pending_deletion_at,
      })
      .from(auth_user)
      .where(eq(auth_user.id, authUserId))
      .for("update");
    if (
      lifecycleRow?.deletion_state !== "pending_deletion" ||
      !lifecycleRow.pending_deletion_at ||
      lifecycleRow.pending_deletion_at >= cutoffIso
    ) {
      return false;
    }

    // ---- 1. Space resolution. -------------------------------------------
    const [userRow] = await tx
      .select({ space_id: users.space_id })
      .from(users)
      .where(eq(users.auth_user_id, authUserId));
    const spaceId = userRow?.space_id ?? null;

    if (spaceId) {
      // Serialize space-scoped teardown against quota updates that require
      // the space to exist. This lock must come before deleting the quota
      // row; taking it only at the final space DELETE would allow an update
      // to reinsert quotas after step 6 and strand an orphan row.
      await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .for("update");

      // ---- 2. Connection-tied artifacts. --------------------------------
      // The full uninstall pipeline isn't reachable from storage; do the
      // minimal subset. system.connection items themselves drop in step 4.
      await tx
        .delete(connectionOauthTokens)
        .where(eq(connectionOauthTokens.space_id, spaceId));
      await tx
        .delete(connectionLeasedTokens)
        .where(eq(connectionLeasedTokens.space_id, spaceId));
      await tx.delete(inboundWebhookEvents).where(
        sql`${inboundWebhookEvents.inbound_webhook_id} IN (
            SELECT ${inboundWebhooks.id} FROM ${inboundWebhooks}
            WHERE ${inboundWebhooks.space_id} = ${spaceId}
          )`,
      );
      await tx
        .delete(inboundWebhooks)
        .where(eq(inboundWebhooks.space_id, spaceId));

      // ---- 3. Edges teardown. -------------------------------------------
      await tx.delete(edges).where(eq(edges.space_id, spaceId));

      // ---- 4. Items bulk-purge (cascades metadata + versions). ----------
      const spaceItems = await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.space_id, spaceId));
      const ids = spaceItems.map((r) => r.id);
      if (ids.length > 0) {
        await storage.items.bulkPurge(ids, spaceId);
      }

      // ---- 5. Space blobs. ---------------------------------------------
      await tx.delete(blobs).where(eq(blobs.space_id, spaceId));

      // ---- 6. api_keys, webhooks, quotas. -------------------------------
      await tx.delete(apiKeys).where(eq(apiKeys.space_id, spaceId));
      await tx
        .delete(outboundWebhooks)
        .where(eq(outboundWebhooks.space_id, spaceId));
      await tx.delete(spaceQuotas).where(eq(spaceQuotas.space_id, spaceId));
    }

    // ---- 7. auth_verification rows (cancel token + any in-flight reset/verify tokens). --
    await tx
      .delete(auth_verification)
      .where(eq(auth_verification.value, authUserId));

    // ---- 8. users row + spaces row. --------------------------------------
    if (spaceId) {
      await tx.delete(users).where(eq(users.auth_user_id, authUserId));
      // Belt + braces — guard against space rows shared by another
      // user (multi-user-per-space is not the deployed shape today,
      // but the schema permits it). Only drop the space when no other
      // user rows reference it. The deleted row is already gone by
      // this point, so this counts genuinely-other users.
      const remaining = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.space_id, spaceId));
      if (remaining.length === 0) {
        await tx.delete(spaces).where(eq(spaces.id, spaceId));
      }
    }

    // ---- 9. Redact the existing audit trail. -----------------------------
    await storage.audit.redactForUser(authUserId);

    // ---- 10. Hard-delete audit row, written AFTER the sweep — the sweep
    // matches on resource_id, so a row written before it is rewritten to
    // the sentinel like any other. Writing it after is what makes this the
    // one row in the chain that keeps its details payload. --------------
    await storage.audit.log({
      action: "auth.account.hard_deleted",
      resource_type: "auth_account",
      resource_id: authUserId,
      details: { space_id: spaceId, redacted: false },
    });

    // ---- 11. Delete auth_user (cascades sessions / accounts / passkeys). -
    await tx.delete(auth_user).where(eq(auth_user.id, authUserId));

    return true;
  });
}
