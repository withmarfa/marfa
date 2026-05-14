/**
 * T-116: PG account hard-delete cascade.
 *
 * Tears down every artefact tied to an `auth_user.id` in a single
 * transaction. Order is chosen so each step's preconditions are
 * satisfied by the previous step's writes; rollback on any failure
 * leaves the account in `pending_deletion` for the next purger tick.
 *
 * Step ordering:
 *   1. Resolve `users.tenant_id`. If no row, only the auth_user
 *      cleanup runs (the user never had a tenant — pre-T-074 legacy
 *      shape, or a sign-up that bailed before tenant provisioning).
 *   2. Per-tenant teardown of connection-related artefacts. The full
 *      `performUninstall` pipeline isn't reachable from storage
 *      (route-layer concern), so we do the minimal subset of its
 *      effects directly: revoke `connection_oauth_tokens`, revoke
 *      `connection_leased_tokens`, drop `inbound_webhooks` /
 *      `inbound_webhook_events`. The user's items themselves are
 *      bulk-purged in step 4 so the `system.connection` rows go too.
 *   3. Teardown of edges (`deleteBySource` / `deleteByTarget` would
 *      be N queries; do a single `DELETE FROM edges WHERE tenant_id`).
 *   4. Bulk-purge every item under the tenant (cascades metadata +
 *      versions via FK; search index needs explicit cleanup which
 *      `ItemStore.bulkPurge` already wires).
 *   5. Tenant-scoped blob rows.
 *   6. `api_keys` + outbound/inbound webhooks + `tenant_quotas`.
 *   7. `auth_verification` rows referencing this user (the cancel
 *      token + any in-flight reset/verify tokens — all keyed by
 *      `value = authUserId`).
 *   8. `users` row, `tenants` row.
 *   9. `auth.account.hard_deleted` audit row (BEFORE redactForUser
 *      so it survives the sweep).
 *   10. `audit.redactForUser(authUserId)` to scrub PII.
 *   11. `auth_user` row — FK cascades drop `auth_session`,
 *      `auth_account`, `auth_passkey`.
 *
 * The function takes the full `Storage` so step 4 / step 9 / step 10
 * flow through the store layer (search-index cleanup; audit log
 * insertion; sub-store delete methods). Cross-table raw SQL is used
 * only where bulk efficiency matters (edges, blobs, api_keys,
 * webhooks, tenant_quotas, auth_verification).
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
  tenantQuotas,
  tenants,
  users,
} from "./schema.js";
import type { PgDb } from "./connection.js";

export async function pgDeleteAccountCascade(
  db: PgDb,
  storage: Storage,
  authUserId: string,
): Promise<void> {
  // The cascade is conceptually one transaction. PG's runInTransaction
  // wraps the outer `postgres-js` BEGIN; we drive it via `db.transaction`
  // here so every Drizzle call in this block uses the same `tx`. (The
  // search-index cleanup inside `ItemStore.bulkPurge` runs on its own
  // db handle and is best-effort with respect to this transaction; on
  // rollback the affected items still exist so a residual FTS row is
  // self-healing on the next purger tick.)
  //
  // T-025 RLS bypass: this is a privileged operation that crosses
  // tenant boundaries (auth_user is in the auth_* island; the user's
  // tenant data lives behind the per-tenant RLS policies). The store
  // calls run on the wrapped instance which falls through to the base
  // when no ALS context is installed; the purger doesn't install
  // one, so the cascade runs as the connection owner and is not
  // policy-gated. Documented.
  await db.transaction(async (tx) => {
    // ---- 1. Tenant resolution. -------------------------------------------
    const [userRow] = await tx
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.auth_user_id, authUserId));
    const tenantId = userRow?.tenant_id ?? null;

    if (tenantId) {
      // ---- 2. Connection-tied artefacts. --------------------------------
      // The full per-connection uninstall pipeline isn't reachable from
      // here; do the minimal subset (token revocation + inbound webhook
      // teardown). The `system.connection` items themselves are
      // dropped in step 4 along with everything else tenant-scoped.
      await tx
        .delete(connectionOauthTokens)
        .where(eq(connectionOauthTokens.tenant_id, tenantId));
      await tx
        .delete(connectionLeasedTokens)
        .where(eq(connectionLeasedTokens.tenant_id, tenantId));
      await tx.delete(inboundWebhookEvents).where(
        sql`${inboundWebhookEvents.inbound_webhook_id} IN (
            SELECT ${inboundWebhooks.id} FROM ${inboundWebhooks}
            WHERE ${inboundWebhooks.tenant_id} = ${tenantId}
          )`,
      );
      await tx
        .delete(inboundWebhooks)
        .where(eq(inboundWebhooks.tenant_id, tenantId));

      // ---- 3. Edges teardown. -------------------------------------------
      await tx.delete(edges).where(eq(edges.tenant_id, tenantId));

      // ---- 4. Items bulk-purge (cascades metadata + versions). ----------
      // Goes through ItemStore.bulkPurge so the search index is cleaned
      // per item. The store call runs outside `tx` (different db
      // handle); on rollback FTS may have entries for items the
      // transaction restored — self-healing next sweep.
      const tenantItems = await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.tenant_id, tenantId));
      const ids = tenantItems.map((r) => r.id);
      if (ids.length > 0) {
        await storage.items.bulkPurge(ids, tenantId);
      }

      // ---- 5. Tenant blobs. ---------------------------------------------
      await tx.delete(blobs).where(eq(blobs.tenant_id, tenantId));

      // ---- 6. api_keys, webhooks, quotas. -------------------------------
      await tx.delete(apiKeys).where(eq(apiKeys.tenant_id, tenantId));
      await tx
        .delete(outboundWebhooks)
        .where(eq(outboundWebhooks.tenant_id, tenantId));
      await tx.delete(tenantQuotas).where(eq(tenantQuotas.tenant_id, tenantId));
    }

    // ---- 7. auth_verification rows naming this user. -----------------------
    // Catches the cancel token, plus any in-flight verify-email /
    // reset-password tokens whose `value` is the user id. Identifier
    // prefix isn't load-bearing; the value match covers every flow.
    await tx
      .delete(auth_verification)
      .where(eq(auth_verification.value, authUserId));

    // ---- 8. users row + tenants row. --------------------------------------
    if (tenantId) {
      await tx.delete(users).where(eq(users.auth_user_id, authUserId));
      // Belt + braces — guard against tenant rows shared by another
      // user (multi-user-per-tenant is not the deployed shape today,
      // but the schema permits it). Only drop the tenant when no other
      // user rows reference it. The deleted row is already gone by
      // this point, so this counts genuinely-other users.
      const remaining = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.tenant_id, tenantId));
      if (remaining.length === 0) {
        await tx.delete(tenants).where(eq(tenants.id, tenantId));
      }
    }

    // ---- 9. Hard-delete audit row (survives the redact sweep). -----------
    await storage.audit.log({
      action: "auth.account.hard_deleted",
      resource_type: "auth_account",
      resource_id: authUserId,
      details: { tenant_id: tenantId, redacted: false },
    });

    // ---- 10. Redact remaining audit trail. -------------------------------
    await storage.audit.redactForUser(authUserId);

    // ---- 11. Delete auth_user (cascades sessions / accounts / passkeys). -
    await tx.delete(auth_user).where(eq(auth_user.id, authUserId));
  });
}
