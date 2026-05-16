/**
 * T-116: SQLite account hard-delete cascade.
 *
 * Mirrors pg/account-cascade.ts step-for-step. See that file for the
 * full design notes including the T-136 race-safety re-check at step 0.
 * The libsql adapter exposes the same Drizzle
 * `db.transaction(async tx => …)` shape as postgres-js, so the
 * end-to-end transactional guarantee is real.
 *
 * **T-136 note for SQLite:** there is no `FOR UPDATE` — better-sqlite3
 * serialises all writes via the database file lock, so any concurrent
 * `cancelPendingDeletion` UPDATE on `auth_user` waits behind the
 * cascade transaction (or vice versa). The in-transaction re-check
 * still gates: if the cancel commits first, the cascade reads the
 * fresh `deletion_state = 'active'` row and short-circuits cleanly.
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
import type { DrizzleDb } from "./connection.js";

export async function sqliteDeleteAccountCascade(
  db: DrizzleDb,
  storage: Storage,
  authUserId: string,
  cutoffIso: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // ---- 0. T-136 race-safety re-check. ----------------------------------
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
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.auth_user_id, authUserId))
      .get();
    const tenantId = userRow?.tenant_id ?? null;

    if (tenantId) {
      await tx
        .delete(connectionOauthTokens)
        .where(eq(connectionOauthTokens.tenant_id, tenantId))
        .run();
      await tx
        .delete(connectionLeasedTokens)
        .where(eq(connectionLeasedTokens.tenant_id, tenantId))
        .run();
      await tx
        .delete(inboundWebhookEvents)
        .where(
          sql`${inboundWebhookEvents.inbound_webhook_id} IN (
            SELECT ${inboundWebhooks.id} FROM ${inboundWebhooks}
            WHERE ${inboundWebhooks.tenant_id} = ${tenantId}
          )`,
        )
        .run();
      await tx
        .delete(inboundWebhooks)
        .where(eq(inboundWebhooks.tenant_id, tenantId))
        .run();
      await tx.delete(edges).where(eq(edges.tenant_id, tenantId)).run();

      const tenantItems = await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.tenant_id, tenantId))
        .all();
      const ids = tenantItems.map((r) => r.id);
      if (ids.length > 0) {
        await storage.items.bulkPurge(ids, tenantId);
      }

      await tx.delete(blobs).where(eq(blobs.tenant_id, tenantId)).run();
      await tx.delete(apiKeys).where(eq(apiKeys.tenant_id, tenantId)).run();
      await tx
        .delete(outboundWebhooks)
        .where(eq(outboundWebhooks.tenant_id, tenantId))
        .run();
      await tx
        .delete(tenantQuotas)
        .where(eq(tenantQuotas.tenant_id, tenantId))
        .run();
    }

    await tx
      .delete(auth_verification)
      .where(eq(auth_verification.value, authUserId))
      .run();

    if (tenantId) {
      await tx.delete(users).where(eq(users.auth_user_id, authUserId)).run();
      // Drop the tenant only when no other users reference it (the
      // deleted row is already gone, so this counts genuinely-other
      // users). Mirrors pg/account-cascade.ts.
      const remaining = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.tenant_id, tenantId))
        .all();
      if (remaining.length === 0) {
        await tx.delete(tenants).where(eq(tenants.id, tenantId)).run();
      }
    }

    await storage.audit.log({
      action: "auth.account.hard_deleted",
      resource_type: "auth_account",
      resource_id: authUserId,
      details: { tenant_id: tenantId, redacted: false },
    });

    await storage.audit.redactForUser(authUserId);

    await tx.delete(auth_user).where(eq(auth_user.id, authUserId)).run();

    return true;
  });
}
