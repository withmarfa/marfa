/**
 * The two time filters that were renamed, and why a request still
 * carrying an old name is refused rather than ignored.
 *
 * `since` and `until` both read the item's own user-meaningful time —
 * `timestamp`, falling back to `created_at`. Neither name said so, and
 * `since` in particular reads as "changed since", which is the other
 * question entirely and now has its own filter. They are named for the
 * field they read: `timestamp_after` and `timestamp_before`.
 *
 * **Refusing is the whole point.** Query parameters are parsed with a
 * schema that strips unknown keys rather than rejecting them, so a
 * request carrying the old name parses successfully with the filter
 * silently dropped. The caller gets `200`, a well-formed page, and no
 * time filter at all — a full listing that looks exactly like the narrow
 * one they asked for.
 *
 * On `POST /items/bulk-actions` that is not a bad read but a bad write.
 * The filter is the match set, so a dropped bound turns "purge the items
 * before this date" into "purge everything", and the match cap is high
 * enough that a space under it does not even error. Silence is affordable
 * on none of these doors and least of all that one.
 *
 * The audit log has a `since` of its own that reads its own timestamp
 * column and keeps its name. That is why this is called per door rather
 * than installed as middleware: a blanket rule would refuse a parameter
 * that is still correct.
 */
import { MarfaError, ErrorCode } from "@withmarfa/shared";

/** Old name to new name. The message is derived from this so the two
 *  cannot disagree. */
const RENAMED = {
  since: "timestamp_after",
  until: "timestamp_before",
} as const;

/**
 * Whether the door doing the refusing has a modification-time filter to
 * offer, and so whether the message may name one.
 *
 * `updated_after` exists on `GET /items` and `GET /edges` and on no other
 * door. Naming it from `GET /export` or `POST /items/bulk-actions` would
 * send a caller to a parameter those doors strip in silence, which is the
 * failure this refusal exists to prevent, reached through the refusal.
 */
export type CatchUpFilter = "updated_after" | "none";

/**
 * Whether the door has the renamed filters at all. An edge has no
 * user-meaningful time of its own, so `GET /edges` carries neither
 * `timestamp_after` nor `timestamp_before`, and a refusal there that named
 * one would point at a parameter the door strips in silence, which is the
 * failure being refused. Such a door names only what it has.
 */
export interface RefusalOptions {
  catchUpFilter: CatchUpFilter;
  /** Defaults to true; `GET /edges` passes false. */
  hasItemTimeFilters?: boolean;
}

function refusal(
  oldName: keyof typeof RENAMED,
  opts: RefusalOptions,
): MarfaError {
  const catchUpAdvice =
    opts.catchUpFilter === "none"
      ? // Names the doors that have one, never the parameter itself. A
        // door name cannot be pasted into a query string; the parameter
        // can, and on this door it would be stripped in silence for a
        // 200 carrying everything — which is the failure being refused.
        `This door has no filter on when a row last changed; the item and edge listings do.`
      : `To filter on when a row last changed, use "${opts.catchUpFilter}".`;
  if (opts.hasItemTimeFilters === false) {
    // The renamed filter does not exist here either, so the only parameter
    // the message may name is the one the door has.
    return new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `The "${oldName}" filter does not exist on this door: it read an item's own time, and an edge has none. ` +
        catchUpAdvice,
      {
        renamed_from: oldName,
        use: opts.catchUpFilter === "none" ? null : opts.catchUpFilter,
      },
    );
  }
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `The "${oldName}" filter was renamed to "${RENAMED[oldName]}", which reads the item's own time. ` +
      catchUpAdvice,
    { renamed_from: oldName, use: RENAMED[oldName] },
  );
}

/**
 * Refuse a renamed filter arriving as a query parameter.
 *
 * Reads the raw query string deliberately: by the time the validated
 * object exists the old key has already been stripped from it, so there
 * would be nothing left to notice.
 */
export function refuseRenamedTimeQueryParams(
  rawUrl: string,
  opts: RefusalOptions,
): void {
  const params = new URL(rawUrl).searchParams;
  for (const oldName of Object.keys(RENAMED) as (keyof typeof RENAMED)[]) {
    if (params.has(oldName)) throw refusal(oldName, opts);
  }
}

/**
 * Refuse a renamed filter arriving inside a request body, which is how
 * the bulk-action door takes it.
 *
 * Checks the parsed body before validation strips it, for the same
 * reason as above. A non-object filter is left alone — the schema is
 * what has an opinion about the shape.
 */
export function refuseRenamedTimeFilterKeys(
  filter: unknown,
  opts: RefusalOptions,
): void {
  if (typeof filter !== "object" || filter === null) return;
  for (const oldName of Object.keys(RENAMED) as (keyof typeof RENAMED)[]) {
    if (Object.prototype.hasOwnProperty.call(filter, oldName)) {
      throw refusal(oldName, opts);
    }
  }
}
