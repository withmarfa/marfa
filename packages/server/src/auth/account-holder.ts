import type { Item } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/**
 * The account holder's graph handle: one `items` row per space whose only
 * job is to be addressable, so an edge can name the person who owns the
 * space. `assertEdgesCanBeCreated` resolves both endpoints against `items`,
 * and the profile's identity lives in the disjoint `users` id-space, so
 * without a row there is simply no id to put at the end of an `authored-by`.
 *
 * The row carries no profile fields. `/profile/me` reads `users` joined to
 * `auth_user` and stays the source of truth; mirroring username or display
 * name onto the item would give the same facts two writers (a handle can
 * change through `PATCH /profile/me` or `PUT /auth/me/handle`) for a label
 * every caller can already fetch.
 */
export const ACCOUNT_HOLDER_TYPE = "system.account_holder";

/**
 * Natural key for the handle. `items` carries a unique index on
 * `(source, source_id)` where source is not null, so keying `source_id` on
 * the space makes "one account holder per space" a database constraint
 * rather than a convention two call sites have to remember. The backfill
 * migration writes the same pair, which is what lets it be re-run.
 */
export const ACCOUNT_HOLDER_SOURCE = "system";

export function accountHolderSourceId(spaceId: string): string {
  return `account-holder:${spaceId}`;
}

/**
 * Resolve the space's account-holder handle, creating it when absent.
 *
 * Called from the sign-up provisioning hook, inside the same transaction as
 * the space and `users` row on Postgres. The lookup runs before the insert
 * so a repeat call is a no-op; the unique index is the backstop if two
 * callers ever race, and a losing insert fails the caller loudly rather than
 * leaving a space with two account holders.
 */
export async function ensureAccountHolderItem(
  storage: Storage,
  spaceId: string,
): Promise<Item> {
  const existing = await findAccountHolderItem(storage, spaceId);
  if (existing) return existing;
  return storage.items.create(
    {
      type: ACCOUNT_HOLDER_TYPE,
      properties: {},
      source: ACCOUNT_HOLDER_SOURCE,
      source_id: accountHolderSourceId(spaceId),
    },
    spaceId,
  );
}

/**
 * Read-only lookup for callers that must not create — the profile endpoints,
 * which would otherwise turn a GET into a write. Uses the trashed-inclusive
 * variant because the uniqueness constraint the handle relies on does not
 * care about state, so a state-filtered read could report "absent" for a row
 * an insert would then collide with.
 */
export async function findAccountHolderItem(
  storage: Storage,
  spaceId: string,
): Promise<Item | null> {
  return storage.items.findBySourceIdIncludingTrashed(
    ACCOUNT_HOLDER_SOURCE,
    accountHolderSourceId(spaceId),
    spaceId,
  );
}
