/**
 * T-116: PG account-lifecycle store.
 *
 * Surfaces `auth_user.deletion_state` + `pending_deletion_at` and the
 * accompanying credential-revocation cascade that fires the moment a
 * user confirms an account-deletion email. Pattern mirrors
 * `pg/tenant-store.ts` (single-table store), with one widening:
 * `markPendingDeletion` runs a Drizzle transaction that also revokes
 * the user's tenant's `api_keys` rows and drops every `auth_session`
 * for the user atomically — so the moment the state flips,
 * authenticated callers stop seeing the account on every credential
 * path.
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { AccountLifecycleStore } from "../interface.js";
import { apiKeys, auth_session, auth_user, users } from "./schema.js";
import type { PgDb } from "./connection.js";

type DeletionState = "active" | "pending_deletion";

export class PgAccountLifecycleStore implements AccountLifecycleStore {
  constructor(private db: PgDb) {}

  async markPendingDeletion(authUserId: string, nowIso: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // 1. Flip the lifecycle columns.
      await tx
        .update(auth_user)
        .set({
          deletion_state: "pending_deletion",
          pending_deletion_at: nowIso,
        })
        .where(eq(auth_user.id, authUserId));
      // 2. Revoke every active api_keys row for the user's tenant.
      //    The join is intentionally written via a sub-select so the
      //    cross-table mutation stays in one transaction. The user is
      //    looked up via `users.auth_user_id`; null-tenant rows on
      //    `users` (legacy / single-tenant self-host) are skipped by
      //    the IS NOT NULL guard.
      await tx
        .update(apiKeys)
        .set({ revoked_at: nowIso })
        .where(
          and(
            isNull(apiKeys.revoked_at),
            sql`${apiKeys.tenant_id} IN (
              SELECT ${users.tenant_id} FROM ${users}
              WHERE ${users.auth_user_id} = ${authUserId}
            )`,
          ),
        );
      // 3. Drop every better-auth session for the user. Sessions carry
      //    no audit value once the account is in pending-deletion.
      await tx.delete(auth_session).where(eq(auth_session.userId, authUserId));
    });
  }

  async cancelPendingDeletion(authUserId: string): Promise<void> {
    await this.db
      .update(auth_user)
      .set({ deletion_state: "active", pending_deletion_at: null })
      .where(eq(auth_user.id, authUserId));
  }

  async getAccountLifecycle(authUserId: string): Promise<{
    deletion_state: DeletionState;
    pending_deletion_at: string | null;
  } | null> {
    const [row] = await this.db
      .select({
        deletion_state: auth_user.deletion_state,
        pending_deletion_at: auth_user.pending_deletion_at,
      })
      .from(auth_user)
      .where(eq(auth_user.id, authUserId));
    if (!row) return null;
    return {
      deletion_state: row.deletion_state as DeletionState,
      pending_deletion_at: row.pending_deletion_at ?? null,
    };
  }

  async getAccountLifecycleByEmail(email: string): Promise<{
    auth_user_id: string;
    deletion_state: DeletionState;
    pending_deletion_at: string | null;
  } | null> {
    const lower = email.toLowerCase();
    const [row] = await this.db
      .select({
        id: auth_user.id,
        deletion_state: auth_user.deletion_state,
        pending_deletion_at: auth_user.pending_deletion_at,
      })
      .from(auth_user)
      .where(sql`LOWER(${auth_user.email}) = ${lower}`);
    if (!row) return null;
    return {
      auth_user_id: row.id,
      deletion_state: row.deletion_state as DeletionState,
      pending_deletion_at: row.pending_deletion_at ?? null,
    };
  }

  async listPendingDeletionDue(
    cutoffIso: string,
  ): Promise<{ auth_user_id: string }[]> {
    const rows = await this.db
      .select({ id: auth_user.id })
      .from(auth_user)
      .where(
        and(
          eq(auth_user.deletion_state, "pending_deletion"),
          lt(auth_user.pending_deletion_at, cutoffIso),
        ),
      );
    return rows.map((r) => ({ auth_user_id: r.id }));
  }
}
