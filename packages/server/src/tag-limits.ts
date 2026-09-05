/**
 * The per-item tag bound, in one place.
 *
 * It was a bare `100` at five sites in the items route file, each beside a
 * message restating it in prose. Five copies of one number agreed with each
 * other, which is what made the absence of a constant invisible — and the
 * number had to leave the route layer anyway, because the bound is now
 * enforced where the write happens rather than in front of it.
 *
 * **Two different questions, and only one of them is this bound.** A route
 * still refuses a body carrying more than this many tags, because that is a
 * statement about the request: a hundred and one copies of one tag is over
 * that limit and projects to a single tag, so the store would accept it and
 * should. This constant bounds what an item may *hold*, and the stores
 * enforce it inside the transaction that computes the merged set, on the same
 * read the write uses. A check that read in one transaction and wrote in
 * another — which is what the routes used to do — bounds nothing under
 * concurrency: two tag writes to one item each read a set under the bound,
 * each pass, and the merged result lands over it with nothing refused.
 *
 * **The check fires on an increase, not on a state.** A row can already be
 * over this bound: the bulk doors write tags through paths that do not
 * consult it, so such rows exist. Refusing every write to one would strand
 * it — a merge carrying no tags at all, which changes nothing, would answer
 * 400 and tell the caller about a limit they had not approached. So a write
 * is refused when it is over the bound *and* larger than what the row already
 * held, which leaves a legacy row writable downward and a no-op a no-op.
 */

/**
 * Largest number of distinct tags one item may hold.
 *
 * Counted on the deduplicated set, because that is what the store writes.
 */
export const MAX_TAGS_PER_ITEM = 100;
