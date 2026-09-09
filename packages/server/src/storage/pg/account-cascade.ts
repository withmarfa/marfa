/* eslint-disable no-restricted-syntax -- Not yet on the shared space
 * fence. `storage/space-condition.ts` is the one spelling of it, and
 * this store predates it; the rule covers every store so a new file is
 * covered by default, which leaves the existing ones needing a line
 * that says so. Normalizing one is a change of its own: an absent space
 * has to be read call site by call site, and reading it wrong is the
 * defect the helper exists for. Delete this line when you do. */
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
 *      versions via FK; on Postgres the search vector is a column on the
 *      row, so deleting the row is the whole of that cleanup).
 *   5. Space-scoped blob rows.
 *   6. `api_keys` + outbound/inbound webhooks + `space_quotas`, the
 *      space's own type vocabulary, and its `event_log` rows.
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
 * flow through the store layer: the item purge and the audit writes are
 * the store's own bulk operations, and reimplementing either as raw SQL
 * here would duplicate the cascade rules they already encode. Both run
 * on this transaction, which costs an installed request context because
 * the stores hold a wrapped Drizzle instance and this helper does not.
 * Cross-table raw SQL is used only where bulk efficiency matters and no
 * store method exists (edges, blobs, api_keys, webhooks, space_quotas,
 * auth_verification).
 *
 * **The whole cascade announces nothing**, and that is the same decision
 * the retention sweeps take for the same reason and one more of its own:
 * the account whose rows these are is going, so there is no client left to
 * tell and no credential left to read the stream with. `TrashPurger`
 * carries the general argument.
 *
 * **`pgDeleteSpace` below is silent for a different reason, and the one
 * above does not reach it.** No account is going there — it removes a
 * space that never had one — so "the owner is leaving" is simply not the
 * argument. What holds instead is that the space's `api_keys` go in the
 * same transaction, so no credential scoped to that space survives the
 * commit to reconcile against; and that `TrashPurger`'s general point
 * applies unchanged, since a whole-space teardown is not a set of row
 * edits any replica repairs from.
 *
 * The one subscriber that does survive is the operator key, which
 * carries no `space_id` and therefore streams unfiltered. It would see
 * these rows go if they were published. It is deliberately not told: it
 * holds no per-space replica to repair, and the alternative is thousands
 * of per-row frames announcing the disappearance of a space the same
 * request has already removed.
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
  eventLog,
  inboundWebhooks,
  inboundWebhookEvents,
  items,
  outboundWebhooks,
  spaceQuotas,
  spaces,
  users,
} from "./schema.js";
import type { PgDb } from "./connection.js";
import { pgRequestContext } from "./request-context.js";
import type { PgTxContext } from "./request-context.js";

/**
 * Delete every row scoped to a space, leaving the `spaces` row itself and
 * the auth island alone.
 *
 * Steps 2 through 6 of the cascade above, extracted so a space deletion
 * that has no account behind it reaches the same teardown. Two copies of
 * this list would drift the first time a space-scoped table is added, and
 * the failure that produces is a stranded row nobody looks for.
 *
 * The caller owns the transaction, the `FOR UPDATE` lock on the space row,
 * and the decision about whether the space may be deleted at all. This
 * function only sweeps.
 *
 * `system.connection` items are not uninstalled through the route-layer
 * pipeline — it is not reachable from storage — so the minimal subset of
 * its effects is done directly here. The connection items themselves go
 * with the bulk purge.
 */
export async function pgPurgeSpaceScopedRows(
  tx: PgTxContext,
  storage: Storage,
  spaceId: string,
): Promise<void> {
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
  await tx.delete(inboundWebhooks).where(eq(inboundWebhooks.space_id, spaceId));

  await tx.delete(edges).where(eq(edges.space_id, spaceId));

  // Cascades metadata + versions via FK. On Postgres the search vector is a
  // column on the row and goes with it, so deleting the row is the whole of
  // the search-index cleanup rather than a separate step beside it.
  const spaceItems = await tx
    .select({ id: items.id })
    .from(items)
    .where(eq(items.space_id, spaceId));
  const ids = spaceItems.map((r) => r.id);
  if (ids.length > 0) {
    // The purge runs on this transaction rather than beside it.
    //
    // `storage.items` holds the request-context-wrapped Drizzle instance
    // while this helper runs on an unwrapped one and threads `tx` by hand.
    // With no context installed the wrapper falls straight through to the
    // pool, so `bulkPurge` opens a transaction on a second connection and
    // commits independently: a caller that rolls back afterwards has already
    // destroyed the items and still holds the account. It also holds a second
    // pool connection for the length of the purge, so concurrent cascades cost
    // two connections each out of the ten this pool carries.
    //
    // Installing the context resolves `bulkPurge`'s own `db.transaction` to
    // a savepoint on this connection, which is what it already resolves to
    // inside the bulk-action runner.
    await pgRequestContext.run({ tx }, async () => {
      await storage.items.bulkPurge(ids, spaceId);
    });
  }

  await tx.delete(blobs).where(eq(blobs.space_id, spaceId));

  await tx.delete(apiKeys).where(eq(apiKeys.space_id, spaceId));
  await tx
    .delete(outboundWebhooks)
    .where(eq(outboundWebhooks.space_id, spaceId));
  await tx.delete(spaceQuotas).where(eq(spaceQuotas.space_id, spaceId));
  // The space's own type vocabulary. Omitted until now, in both dialects, so
  // every space deletion left its registrations behind — addressable only
  // through a credential scoped to a space that no longer exists, and
  // re-registered into the in-memory overlay on every subsequent boot.
  //
  // Both tables, because both are space-scoped registrations and a teardown
  // that took one would leave the other in exactly the state this fixes.
  //
  // Platform rows are untouched by construction: they carry `space_id = ''`,
  // which no real space id matches, so the shipped vocabulary cannot be swept
  // by a space deletion.
  await tx.delete(customTypes).where(eq(customTypes.space_id, spaceId));
  await tx.delete(customEdgeTypes).where(eq(customEdgeTypes.space_id, spaceId));
  // The space's own event stream. The retention sweep ages these rows out on
  // its own, so stranding them leaked nothing permanently — but this list is
  // otherwise exhaustive, and one table missing from it reads as an oversight
  // to whoever extends it next. A hole already in the list is what makes the
  // next space-scoped table likelier to be missed too.
  //
  // Instance-wide rows carry a NULL `space_id`, which no equality matches, so
  // a space deletion cannot reach them.
  await tx.delete(eventLog).where(eq(eventLog.space_id, spaceId));
}

/**
 * Hard-delete a space that no account owns.
 *
 * The counterpart to `pgDeleteAccountCascade` for the case it cannot
 * serve: a space provisioned by the operator key rather than by
 * sign-up has no `auth_user` to cascade from, and until this existed
 * there was no way to remove one at all. Conformance is the standing
 * example — it creates a space per run and its own comments record that
 * nothing can delete them.
 *
 * **Refuses a space that still has users.** The account cascade owns the
 * auth island (`auth_verification`, `users`, `auth_user`, and the audit
 * redaction that goes with it), and a second path deleting the space out
 * from under an account would leave that island referencing a space that
 * no longer exists. One cascade stays authoritative; this one reports
 * `has_users` and the caller is directed at it.
 */
export async function pgDeleteSpace(
  db: PgDb,
  storage: Storage,
  spaceId: string,
): Promise<"deleted" | "not_found" | "has_users"> {
  return db.transaction(async (tx) => {
    // Same lock and the same reason as the cascade: it must be taken
    // before the quota row is deleted, or a concurrent quota update can
    // reinsert one after the sweep and strand it.
    const [row] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .for("update");
    if (!row) return "not_found";

    const owners = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.space_id, spaceId));
    if (owners.length > 0) return "has_users";

    await pgPurgeSpaceScopedRows(tx, storage, spaceId);
    await tx.delete(spaces).where(eq(spaces.id, spaceId));
    return "deleted";
  });
}

export async function pgDeleteAccountCascade(
  db: PgDb,
  storage: Storage,
  authUserId: string,
  cutoffIso: string,
): Promise<boolean> {
  // Runs as the connection owner (no ALS space context installed by the purger),
  // bypassing per-space RLS. Every step reaching storage runs on this
  // transaction, so a rollback leaves the account and its items as they were.
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

      // ---- 2-6. Everything scoped to the space. -------------------------
      await pgPurgeSpaceScopedRows(tx, storage, spaceId);
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

    // ---- 9-10. The audit trail, on this transaction's own connection.
    //
    // `pgRequestContext.run` is what puts it there, and without it neither
    // write is part of this transaction at all. The audit store holds the
    // request-context-wrapped Drizzle instance, this cascade runs on the
    // unwrapped base instance and threads `tx` by hand, and the wrapper
    // with no context installed falls straight through to the pool. Both
    // writes would therefore take a second connection and commit on their
    // own. The visible failure is the inverse of the one the propagating
    // writer guards: the row lands, the delete below fails, the
    // transaction rolls back, and a permanent record survives of a hard
    // delete that never happened.
    //
    // It also gives back a pool connection acquired while this transaction
    // is held. The severe form of that shape recorded elsewhere here is a
    // self-deadlock, which this path cannot reach because it holds no row
    // lock the second connection would wait on. What it costs is one extra
    // connection per concurrent cascade out of the ten this pool carries.
    //
    // Scoped to these two calls rather than to the whole cascade. The one
    // other call reaching storage — `storage.items.bulkPurge` inside the
    // space-scoped teardown — installs the context at its own call site,
    // for the same reason and with the same effect.
    await pgRequestContext.run({ tx }, async () => {
      // Redact the existing audit trail.
      await storage.audit.redactForUser(authUserId);

      // The hard-delete row, written AFTER the sweep — the sweep matches on
      // resource_id, so a row written before it is rewritten to the
      // sentinel like any other. Writing it after is what makes this the
      // one row in the chain that keeps its details payload.
      //
      // The propagating writer, because a hard delete nothing recorded must
      // not report success. `log` cannot reject, so it would answer success
      // whatever happened; the swallow is the difference between the two
      // writers, not where the write lands.
      await storage.audit.logOrThrow({
        action: "auth.account.hard_deleted",
        resource_type: "auth_account",
        resource_id: authUserId,
        details: { space_id: spaceId, redacted: false },
      });
    });

    // ---- 11. Delete auth_user (cascades sessions / accounts / passkeys). -
    await tx.delete(auth_user).where(eq(auth_user.id, authUserId));

    return true;
  });
}
