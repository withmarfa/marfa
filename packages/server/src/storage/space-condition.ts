/**
 * The space fence, written once for both dialects.
 *
 * A space-bounded query narrows on `space_id`, and the argument that says
 * which space is optional at almost every call site. What an absent
 * argument means was decided independently in each store and came out two
 * different ways: most read it as "do not narrow", while one key-store
 * method read it as "narrow to the rows with no space". Both are defensible
 * in isolation and together they are a defect, because a caller cannot know
 * which one it is talking to. A platform admin uninstalling a space's
 * connection resolved the connection under the first meaning and then
 * looked for its credentials under the second, so the revocation list came
 * back empty every time and the pipeline reported success.
 *
 * **`undefined` means no fence.** That is the meaning that wins, and it
 * wins because it is the only one that makes an absent space argument mean
 * the same thing as an absent space on a credential: platform authority is
 * authority not confined to a space. Reading it as "the rows with no space"
 * makes a platform caller narrower than a space caller, which is backwards,
 * and it is unreachable in hosted mode anyway — nothing there is written
 * without a space.
 *
 * The other two meanings are real and are named rather than spelled inline,
 * so choosing one is a decision a reader can see:
 *
 * - `spaceBucketCondition` — the rows with no space, as a bucket in its own
 *   right. Uniqueness checks want this: two spaces may each hold a row the
 *   other also holds, and the space-less rows are a third domain.
 * - `spaceOrPlatformCondition` — a space's own rows plus the platform-scoped
 *   ones. The catalog widening, and never a default.
 *
 * `null` is the explicit form of "the rows with no space" and is accepted by
 * `spaceCondition` so a caller with three states to express (a named space,
 * the space-less bucket, or everything) needs no second helper.
 *
 * Inline `eq(<table>.space_id, ...)` and `isNull(<table>.space_id)` are
 * banned by lint inside the stores these serve, so the divergence cannot be
 * rewritten by hand.
 */
import { eq, isNull, or, type Column, type SQL } from "drizzle-orm";

/** How a caller names the space it is asking about.
 *
 *  - a string — that space
 *  - `null` — the rows carrying no space
 *  - `undefined` — every space (no fence) */
export type SpaceScope = string | null | undefined;

/**
 * Narrow to `spaceId`, or to nothing at all when it is absent.
 *
 * Returns `undefined` for the no-fence case so the result drops out of a
 * surrounding `and(...)` without the caller branching.
 */
export function spaceCondition(
  column: Column,
  spaceId: SpaceScope,
): SQL | undefined {
  if (spaceId === undefined) return undefined;
  if (spaceId === null) return isNull(column);
  return eq(column, spaceId);
}

/**
 * Narrow to `spaceId`, treating an absent one as the space-less bucket.
 *
 * For the places where "no space" is a domain rather than an absence of
 * authority: a uniqueness check has to compare a space-less row against the
 * other space-less rows, and against nothing else.
 */
export function spaceBucketCondition(column: Column, spaceId: SpaceScope): SQL {
  if (spaceId === undefined || spaceId === null) return isNull(column);
  return eq(column, spaceId);
}

/**
 * Narrow to `spaceId` on a column that stores the space-less bucket as the
 * empty string rather than as NULL.
 *
 * Three tables encode it that way — `blobs`, `custom_types` and
 * `custom_edge_types` — because their primary keys are composite and a
 * nullable column in one behaves inconsistently across SQLite and Postgres.
 * The rationale is at the schema.
 *
 * **This exists because {@link spaceBucketCondition} is wrong against those
 * columns and cannot say so.** It emits `IS NULL` for an absent space, which
 * against a `NOT NULL DEFAULT ''` column matches no row and raises no error:
 * the caller gets an empty result and nothing anywhere reports a mistake. The
 * three call sites that reach those tables dodge it today by passing a literal
 * `""`, and two of them carry a comment explaining why. Nothing stopped a
 * fourth from passing `null`.
 *
 * Takes the same nullable input as its sibling and normalizes it here, so a
 * caller holding a `space_id` off a credential does not have to remember which
 * of the two encodings the table it is about to query happens to use.
 */
export function spaceSentinelCondition(
  column: Column,
  spaceId: string | null | undefined,
): SQL {
  return eq(column, spaceId ?? "");
}

/**
 * A space's own rows plus the platform-scoped ones.
 *
 * The catalog widening: `system.integration` rows are registered by a
 * platform credential and carry no space, and a space member still has to
 * read them. Opt in per call, never by default, and always pair it with a
 * type check on the result — the widening is the lookup mechanic, the type
 * is the gate.
 */
export function spaceOrPlatformCondition(
  column: Column,
  spaceId: SpaceScope,
): SQL | undefined {
  if (spaceId === undefined) return undefined;
  if (spaceId === null) return isNull(column);
  return or(eq(column, spaceId), isNull(column));
}
