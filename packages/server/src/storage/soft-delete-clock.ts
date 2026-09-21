import { softDeleteState, type ItemState } from "@withmarfa/shared";

/**
 * The `trashed_at` half of a state write, computed once so the four write
 * paths that set it — `create`, `delete`, `restore` and `transition` —
 * cannot disagree about it.
 *
 * `trashed_at` records when an item entered its soft-deleted state, and the
 * retention sweep is its only reader. `updated_at` cannot stand in for it:
 * any write to a trashed row moves the modification time, tag and
 * extension writes included, so a sweep reading it would restart the clock
 * on an edit made in the bin.
 *
 * The state a soft delete resolves to is per-type, `revoked` for the
 * `system.*` lifecycle and `trashed` for everything else, so this asks
 * `softDeleteState` rather than comparing against a literal. The sweep only
 * looks at `trashed`; stamping both keeps the column's meaning one sentence
 * long rather than "when it entered the bin, except for the states where it
 * means nothing".
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
