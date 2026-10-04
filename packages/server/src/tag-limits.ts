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
 * over this bound. Two ways: rows written through the bulk doors before those
 * consulted it at all, and `items.create`, which writes tags verbatim and
 * stays that way because it is also the archive restore's writer — an archive
 * is a faithful record of rows written before this rule existed, so bounding
 * that writer makes them unrestorable. Refusing every write to such a row
 * would strand it: a merge carrying no tags at all, which changes nothing,
 * would answer 400 and tell the caller about a limit they had not approached.
 * So a write is refused when it is over the bound *and* larger than what the
 * row already held, which leaves a legacy row writable downward and a no-op a
 * no-op.
 *
 * **Where each layer counts.** The merging writers count a deduplicated set
 * and the wholesale replace counts the array as sent, because each counts what
 * it writes. The doors count the array as sent for the same reason: that is
 * the request they are answering about.
 */

/**
 * Largest number of tags one item may hold.
 *
 * Counted on what the writer in hand will actually store — see the note above
 * on where each layer counts.
 */
export const MAX_TAGS_PER_ITEM = 100;

/**
 * Longest tag, in characters. A tag is removed through its own URL path, so
 * one the server's URL limit refuses could be written and never removed.
 */
export const MAX_TAG_LENGTH = 128;
