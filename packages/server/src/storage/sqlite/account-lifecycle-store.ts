/**
 * T-116: SQLite account-lifecycle store. Mirrors the PG sibling — see
 * pg/account-lifecycle-store.ts for the design notes. `markPendingDeletion`
 * is wrapped in `db.transaction(...)` so the lifecycle flip + key
 * revocation + session drop are atomic on the libsql side.
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { AccountLifecycleStore } from "../interface.js";
import { apiKeys, auth_session, auth_user, users } from "./schema.js";
import type { DrizzleDb } from "./connection.js";

type DeletionState = "active" | "pending_deletion";

export class SqliteAccountLifecycleStore implements AccountLifecycleStore {
  constructor(private db: DrizzleDb) {}

  async markPendingDeletion(authUserId: string, nowIso: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(auth_user)
        .set({
          deletion_state: "pending_deletion",
          pending_deletion_at: nowIso,
        })
        .where(eq(auth_user.id, authUserId))
        .run();
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
        )
        .run();
      await tx
        .delete(auth_session)
        .where(eq(auth_session.userId, authUserId))
        .run();
    });
  }

  async cancelPendingDeletion(authUserId: string): Promise<void> {
    await this.db
      .update(auth_user)
      .set({ deletion_state: "active", pending_deletion_at: null })
      .where(eq(auth_user.id, authUserId))
      .run();
  }

  async getAccountLifecycle(authUserId: string): Promise<{
    deletion_state: DeletionState;
    pending_deletion_at: string | null;
  } | null> {
    const row = await this.db
      .select({
        deletion_state: auth_user.deletion_state,
        pending_deletion_at: auth_user.pending_deletion_at,
      })
      .from(auth_user)
      .where(eq(auth_user.id, authUserId))
      .get();
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
    const row = await this.db
      .select({
        id: auth_user.id,
        deletion_state: auth_user.deletion_state,
        pending_deletion_at: auth_user.pending_deletion_at,
      })
      .from(auth_user)
      .where(sql`LOWER(${auth_user.email}) = ${lower}`)
      .get();
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
      )
      .all();
    return rows.map((r) => ({ auth_user_id: r.id }));
  }
}
