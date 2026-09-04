import { and, eq } from "drizzle-orm";
import type { StoreIdentity, SyncStateRow } from "../types.js";
import type { Executor } from "./executor.js";
import { syncState } from "./schema.js";

/**
 * Where this store is up to.
 *
 * Keyed by origin, space and account together, because each of those alone
 * lets two different corpora share one cursor and each then believes it
 * applied what the other did. The cursor and the hydration stamp are the
 * stream consumer's; the row exists here so the store's shape is settled
 * before it arrives.
 *
 * The recorded identity is a gate rather than a note: opening a store
 * against one it does not match is refused, in `openLocalStore`, before
 * anything reads or writes it.
 */
export interface SyncStateLayer {
  read(identity: StoreIdentity): Promise<SyncStateRow | undefined>;
  /** Create the row for this identity if it is not there. Returns whether
   *  it made one. */
  ensure(identity: StoreIdentity): Promise<boolean>;
  setCursor(identity: StoreIdentity, cursor: string | null): Promise<void>;
  setHydratedAt(identity: StoreIdentity, at: string | null): Promise<void>;
  setLastDrainedAt(identity: StoreIdentity, at: string): Promise<void>;
  /** Every identity this store file has recorded. One in the ordinary case;
   *  more than one is a store two accounts have shared. */
  listIdentities(): Promise<StoreIdentity[]>;
}

function whereIdentity(identity: StoreIdentity) {
  return and(
    eq(syncState.origin, identity.origin),
    eq(syncState.spaceId, identity.spaceId),
    eq(syncState.accountId, identity.accountId),
  );
}

export function createSyncStateLayer(exec: Executor): SyncStateLayer {
  return {
    read: async (identity) => {
      const rows = await exec
        .select()
        .from(syncState)
        .where(whereIdentity(identity));
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        identity: {
          origin: row.origin,
          spaceId: row.spaceId,
          accountId: row.accountId,
        },
        cursor: row.cursor,
        hydratedAt: row.hydratedAt,
        lastDrainedAt: row.lastDrainedAt,
      };
    },

    ensure: async (identity) => {
      const inserted = await exec
        .insert(syncState)
        .values({
          origin: identity.origin,
          spaceId: identity.spaceId,
          accountId: identity.accountId,
        })
        .onConflictDoNothing()
        .returning({ origin: syncState.origin });
      return inserted.length > 0;
    },

    setCursor: async (identity, cursor) => {
      await exec
        .update(syncState)
        .set({ cursor })
        .where(whereIdentity(identity));
    },

    setHydratedAt: async (identity, at) => {
      await exec
        .update(syncState)
        .set({ hydratedAt: at })
        .where(whereIdentity(identity));
    },

    setLastDrainedAt: async (identity, at) => {
      await exec
        .update(syncState)
        .set({ lastDrainedAt: at })
        .where(whereIdentity(identity));
    },

    listIdentities: async () => {
      const rows = await exec
        .select({
          origin: syncState.origin,
          spaceId: syncState.spaceId,
          accountId: syncState.accountId,
        })
        .from(syncState);
      return rows.map((row) => ({
        origin: row.origin,
        spaceId: row.spaceId,
        accountId: row.accountId,
      }));
    },
  };
}
