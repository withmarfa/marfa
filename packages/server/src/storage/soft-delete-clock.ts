import { softDeleteState, type ItemState } from "@withmarfa/shared";

/**
 * The `trashed_at` half of a state write, computed once so the two dialect
 * stores and their three write paths cannot disagree about it.
 *
 * `trashed_at` records when an item entered its soft-deleted state, and the
 * retention sweep is its only reader. `updated_at` used to stand in for it,
 * which made the sweep answer a question nobody asked: any write to a
 * trashed row moves the modification time, so editing something already in
 * the bin restarted its retention clock. Tag and extension writes move it
 * too, so it was not even confined to writes a person would call an edit.
 *
 * The state a soft delete resolves to is per-type — `revoked` for the
 * `system.*` lifecycle, `trashed` for everything else — so this asks
 * `softDeleteState` rather than comparing against a literal. The sweep only
 * looks at `trashed`; stamping both keeps the column's meaning one sentence
 * long rather than "when it entered the bin, except for the states where it
 * means nothing".
 *
 * That does not make the column complete for `revoked`, and reading it as
 * though it does is the trap. The migration backfills `state = 'trashed'`
 * only — deliberately, because inventing a removal time for a row no sweep
 * considers is worse than leaving it null — so every row already revoked
 * when the column landed carries null and always will. A sweep over
 * `revoked` would need its own backfill before it could trust the column.
 * What stamping here buys is that everything revoked from now on is
 * stamped, leaving that backfill a bounded and ageing set rather than the
 * whole table.
 *
 * Returns an empty patch when the write moves between two states that are
 * both outside the soft-deleted one, so `active → archived` leaves the
 * column alone rather than clearing something that is already null.
 */
export function softDeleteClock(
  type: string,
  from: ItemState,
  to: ItemState,
  now: string,
): { trashed_at: string | null } | Record<string, never> {
  const softState = softDeleteState(type);
  if (to === softState) return { trashed_at: now };
  // Clearing on the way out is what makes a restore-then-re-delete start a
  // fresh window instead of inheriting the first one's.
  if (from === softState) return { trashed_at: null };
  return {};
}
