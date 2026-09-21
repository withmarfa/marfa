/**
 * How many rows this instance holds whose stored value falls outside the
 * union the build compares that column against.
 *
 * The request-time half of this is already closed. `platform-family.ts`
 * refuses an unrecognized value, projects onto the least capability, and
 * logs the row it met it on. What it cannot answer is **how many rows**, and
 * that is the question that matters: a rename can leave every row of a table
 * holding a value no build recognizes, and nothing notices until the next
 * rename cycle. A per-request log line would not shorten it: on a broken
 * instance that is a log storm, which is the same as silence.
 *
 * So this is a count and not a guard. Nothing here changes what a request
 * sees.
 *
 * **This reports and does not refuse to boot, which is the whole design.**
 * The reasoning is `platform-drift.ts`'s and `platform-family.ts`'s,
 * twenty lines from where this goes, and it is stronger here rather than
 * weaker:
 *
 * - One image runs `web`, `worker` and `both` from the same
 *   `createSqliteStorage` path. A throw is every replica of every role
 *   exiting at once, including the workers that drain the queues.
 * - The realistic population is a rollback: a value a newer build wrote,
 *   met by an older one. Refusing makes the recovery action the thing that
 *   cannot complete.
 * - There is no repair path from a server that will not start. The remedy
 *   is a migration or a hand `UPDATE`, and both want an instance up.
 * - `platform-family.ts` already says in its own comment why a store read
 *   projects rather than refusing to boot. A boot read is the same read,
 *   earlier.
 *
 * **The severity lives on the log line, not on `/health`.** The boot log
 * is `error`-level and names the table, the column, the true stored string
 * and the count. `/health` carries the number alone: the endpoint is
 * unauthenticated, and the value itself would advertise the shape of a
 * partially-applied migration to anyone who asks.
 *
 * **Derived, never stored.** Recomputed at every boot from the rows, for
 * the reason `platform-drift.ts` gives: a stored flag would be a second
 * source of truth with nothing keeping it honest, and it would go stale in
 * precisely the case that matters.
 */
import { ITEM_STATES, TIERS } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import { BLOB_STORE_KINDS } from "./interface.js";

/** One column, and the set of values this build can interpret in it. */
export interface ScannedColumn {
  table: string;
  column: string;
  /**
   * The type name a projection of this column narrows to.
   *
   * Carried so `scanned-columns.test.ts` can tie a bare `row.x as T` cast
   * in the storage sources back to an entry here. Without it the roster
   * has no way to notice a column that grew a union after this was
   * written, which is exactly how that inventory's own hand-counted
   * predecessor went stale.
   */
  castType: string;
  /**
   * The union itself, by reference.
   *
   * Referenced rather than restated, and load-bearing: a member added to
   * the union and not to a copy here would make the scan report every row
   * holding the new value as unrecognized, on an instance where nothing is
   * wrong. A copy fails loudest exactly when the build is right.
   */
  allowed: readonly string[];
  /**
   * Whether an absent value is a state the column legitimately holds.
   *
   * Only `items.tier` sets it. That column is nullable by design —
   * `system.*` items have no tier because the dimension does not apply, and
   * the field is optional on the wire to model that — so its `GROUP BY`
   * returns a null group on every healthy instance, and counting it would
   * report most of the table as broken. Every other column here is NOT
   * NULL, where a null is genuinely unreadable and stays reportable.
   */
  allowsNull?: boolean;
}

/**
 * The columns counted at boot.
 *
 * `items.tier` is here even though `isTier` already recognizes it at
 * request time. That is the point rather than scope creep: the recognizer
 * gives a deterministic projection and a log line *per read*, and the
 * count is the thing it cannot give.
 */
export const SCANNED_COLUMNS: readonly ScannedColumn[] = [
  {
    table: "api_keys",
    column: "default_tier",
    castType: "Tier",
    allowed: TIERS,
  },
  {
    table: "items",
    column: "state",
    castType: "ItemState",
    allowed: ITEM_STATES,
  },
  // Scanned rather than excused, and it is the entry a roster keyed off
  // casts could never have found: the item projection narrowed this column
  // with `row.tier === "library" || row.tier === "feed"` — a comparison,
  // not a cast — and dropped anything else to `undefined` with no log, no count
  // and no projection. That is `api_keys.default_tier`'s union restated as
  // two literals one directory away, which is the defect
  // `SCANNED_COLUMNS`'s own `allowed` field exists to prevent. Those
  // comparisons now go through `isTier`.
  {
    table: "items",
    column: "tier",
    castType: "Tier",
    allowed: TIERS,
    allowsNull: true,
  },
  // A store this build cannot attach still has rows in the location log,
  // and a copy count that silently ignored them would be wrong in the
  // unsafe direction. The count is what says a build was rolled back past
  // a kind of store it had attached.
  {
    table: "blob_stores",
    column: "kind",
    castType: "BlobStoreKind",
    allowed: BLOB_STORE_KINDS,
  },
];

/**
 * Columns carrying a union that this deliberately does not count, each
 * with the reason.
 *
 * A list rather than a comment because `scanned-columns.test.ts` asserts
 * against it: a column that grows a union has to land in one of these two
 * tables or the guard fails. "We thought about it and decided not to" and
 * "nobody has looked" are indistinguishable in a comment and distinct
 * here. The shape follows `routes/one-auth-layout.test.ts`'s allowed list,
 * where each entry states why it does not generalize.
 *
 * Keyed on the column and the type together, not on the type alone. A
 * roster that asked only whether a type appeared somewhere was silent on
 * the case this whole feature exists for: a *second* column carrying a
 * union that is already on the list. `Tier` is on two of them already,
 * `api_keys.default_tier` and `items.tier`, so a third column cast to it
 * would have passed such a guard without anybody deciding anything.
 */
export const DELIBERATELY_UNSCANNED: readonly {
  table: string;
  column: string;
  castType: string;
  because: string;
}[] = [
  {
    table: "auth_oauth_device_code",
    column: "status",
    castType: "OAuthDeviceCodeStatus",
    because:
      "Rows are ephemeral. A device code lives for minutes, so a boot scan " +
      "reports whatever happened to be in flight at that boot and two " +
      "replicas of one deployment disagree about one database. A number " +
      "that changes when nothing changed is worse than no number.",
  },
  {
    table: "enrichment_state",
    column: "status",
    castType: 'EnrichmentStateRecord["status"]',
    because:
      "No request path reads it. The only consumer is the sweeper's " +
      "anti-join, which re-extracts anything it cannot place, so an " +
      "unrecognized value costs one repeat of work that is already " +
      "idempotent.",
  },
  {
    table: "bulk_action_jobs",
    column: "status",
    castType: "BulkActionJobStatus",
    because:
      "Already fail-closed. A value outside the union matches no `IN (...)` " +
      "claim and no sweep query, so the job is never claimed and never " +
      "swept rather than being mishandled, and the projection only " +
      "decorates a response.",
  },
  {
    table: "idempotency_records",
    column: "state",
    castType: "IdempotencyRecordState",
    because:
      "Fail-closed in the safe direction. Only `complete` replays a stored " +
      "outcome, so a value this build cannot read is treated as a claim " +
      "still in flight rather than as a result: the caller is refused with " +
      "`idempotency_key_in_flight` and the claim's lease then admits a " +
      "takeover, so an unreadable row costs one lease interval and heals " +
      "itself. It can never hand back a body the row does not attest to, " +
      "which is the only outcome worth counting for. Rows also churn on " +
      "the retention sweep, so a boot count would report on whatever was " +
      "in flight at that boot.",
  },
  {
    table: "types",
    column: "origin",
    castType: 'LoadedType["origin"]',
    because:
      "Closed at `storage/loaded-types.ts`, which validates the column and " +
      "reports an unrecognized value, then passes it through unchanged so " +
      "it fails every consumer's comparison rather than being projected " +
      "onto one.",
  },
  {
    table: "types",
    column: "family",
    castType: 'LoadedType["family"]',
    because:
      "Closed at `storage/platform-family.ts`, which pins an unreadable " +
      "family to the restrictive end at the boot projection and logs the " +
      "value it found.",
  },
  {
    table: "housekeeping",
    column: "last_outcome",
    castType: "HousekeepingOutcome",
    because:
      "A record, not a decision. Nothing branches on the value: the " +
      "scheduler writes it after every run and the housekeeping door " +
      "shows it to the operator as it is, so an unrecognized value is " +
      "displayed, never mishandled, and the next run overwrites it.",
  },
  {
    table: "connector_runs",
    column: "outcome",
    castType: 'ConnectorRun["outcome"]',
    because:
      "A record a connector reported, not a decision. The run door " +
      "admits only the two values on the way in and nothing branches on " +
      "the stored one: the listing shows it as it is, and a hundred runs " +
      "later it is gone.",
  },
];

/** One `GROUP BY` row: a stored value and how many rows hold it. */
export interface StoredValueCount {
  /** As the driver handed it back, which is not necessarily a string. */
  value: unknown;
  count: number;
}

/**
 * How the scan asks the database for its counts.
 *
 * The SQL lives with the caller, so this stays a pure function of what the
 * database said and can be driven from a test with no database at all.
 */
export type ColumnValueCounts = (
  table: string,
  column: string,
) => Promise<StoredValueCount[]>;

/** A stored value no union in this build contains, and its row count. */
export interface UnrecognizedStoredValue {
  table: string;
  column: string;
  /**
   * The true stored string.
   *
   * Never projected: this is the only place the original survives, and on
   * the columns that already have a request-time guard every API response
   * reports the fallback instead.
   */
  value: string;
  count: number;
}

/**
 * What one boot's scan concluded.
 *
 * `scanned` exists because `values` being empty has three meanings and
 * `/health` publishes one number over all of them. `platform-drift.ts`,
 * whose reader contract this otherwise copies, has only two — nothing
 * recorded yet, or nothing found — and no failure path at all. This has a
 * third: looked and could not read. The scenario is the one the feature
 * exists for. A newer build meets a database whose migration has not
 * landed, the query fails on the missing column, the catch fires,
 * and without this flag `/health` serves exactly what a healthy instance
 * serves.
 *
 * A boolean carries no identifier, so the reason `/health` publishes a
 * count and not the values is untouched by it.
 */
export interface StoredValueScan {
  /**
   * Whether this scan read every column it meant to.
   *
   * False before any boot has looked and false when a read failed or
   * outran its budget. Both are "this number is not an answer", which is
   * the distinction that matters to a reader; the `error` log separates
   * them for anyone who then goes looking.
   */
  scanned: boolean;
  values: readonly UnrecognizedStoredValue[];
}

/**
 * How long one column's aggregate may take before the scan stops waiting.
 *
 * Measured on production: `items` holds 6,970 rows and `GROUP BY state`
 * answers in 5 ms, planned as an index-only scan over `idx_items_state`
 * with 314 heap fetches and 89 shared buffers hit. So this budget is three
 * orders of magnitude above the observed cost, and it is not here for
 * today's data.
 *
 * It is here for a freshly restored database, where the planner has no
 * statistics until the first `ANALYZE` and falls back to a sequential
 * scan — which is nothing at seven thousand rows and is not nothing
 * forever. Boot is the one place where waiting is expensive, because a
 * deploy's health check is waiting on it.
 *
 * A losing query keeps running and holds its handle, exactly as
 * `/health`'s probe budget accepts for the same reason. That is cheaper at
 * boot than at request time: nothing else is on the database yet.
 */
const COLUMN_BUDGET_MS = 5_000;

/** Marker for an aggregate that outran its budget rather than failing. */
const TIMED_OUT = Symbol("column-aggregate-timed-out");

/**
 * Race one column's aggregate against the budget.
 *
 * A losing query's eventual rejection is swallowed deliberately: it
 * belongs to an answer nothing is waiting for any more, and an unhandled
 * rejection would take the process down at boot over a check whose entire
 * design is that it never does that.
 */
async function withBudget<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolveBudget) => {
    timer = setTimeout(() => {
      resolveBudget(TIMED_OUT);
    }, COLUMN_BUDGET_MS);
  });
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        throw err;
      }),
      budget,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Names a stored value legibly for a log line.
 *
 * `typeof null` is `"object"`, which says nothing useful, so null is
 * named. Every column here is `NOT NULL`, so null should be unreachable,
 * and that is exactly why it is worth reporting legibly if it ever is.
 */
function describeStoredValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  return typeof value;
}

/**
 * Counts the rows in each scanned column that hold a value this build
 * cannot interpret, logging each finding.
 *
 * **A failed read records nothing rather than throwing.** This is a new
 * query on the boot path, so an uncaught failure would be refuse-to-boot
 * by accident — the exact decision taken against above, arrived at through
 * a missing `try` rather than through an argument. So a failure logs at
 * `error` and the whole scan is discarded.
 *
 * Discarded whole, rather than the failing column skipped, because
 * `/health` publishes one bare number and a partial answer is a wrong
 * number presented as a complete one. The scan says `scanned: false` in
 * that case, which is the field that stops a discarded scan from reading
 * as a clean one.
 *
 * A timeout is treated identically to a failure, for the same reason: an
 * aggregate that did not finish did not answer.
 */
export async function scanStoredValues(
  counts: ColumnValueCounts,
): Promise<StoredValueScan> {
  const found: UnrecognizedStoredValue[] = [];

  for (const { table, column, allowed, allowsNull } of SCANNED_COLUMNS) {
    let groups: StoredValueCount[];
    try {
      const outcome = await withBudget(counts(table, column));
      if (outcome === TIMED_OUT) {
        log("error", "stored-value scan outran its budget on a column", {
          table,
          column,
          budget_ms: COLUMN_BUDGET_MS,
        });
        return { scanned: false, values: [] };
      }
      groups = outcome;
    } catch (error) {
      log("error", "stored-value scan could not read a column", {
        table,
        column,
        error: error instanceof Error ? error.message : String(error),
      });
      return { scanned: false, values: [] };
    }

    for (const group of groups) {
      // A nullable column's null group is a real state rather than an
      // unreadable one — see `allowsNull`.
      if (group.value === null && allowsNull) continue;
      // Recognized, not merely present. A non-string cannot be in the
      // union whatever it is, and testing membership first would let a
      // driver-shaped surprise through the `includes` on a widened type.
      if (typeof group.value === "string" && allowed.includes(group.value)) {
        continue;
      }
      const value = describeStoredValue(group.value);
      found.push({ table, column, value, count: group.count });
      log("error", "stored values are not ones this build recognizes", {
        table,
        column,
        stored_value: value,
        rows: group.count,
      });
    }
  }

  return { scanned: true, values: found };
}

/**
 * Not scanned, for the honest reason: a fresh instance and an instance
 * mid-boot have both genuinely not looked, and neither should read as
 * having looked and found nothing.
 */
let lastScan: StoredValueScan = { scanned: false, values: [] };

/**
 * Record what this boot concluded. Called once at boot, on the same pass
 * that records platform drift.
 */
export function setStoredValueScan(scan: StoredValueScan): void {
  lastScan = { scanned: scan.scanned, values: [...scan.values] };
}

/** What the last boot concluded. */
export function storedValueScan(): StoredValueScan {
  return lastScan;
}
