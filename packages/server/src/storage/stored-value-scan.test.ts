/**
 * The scan is a pure function of what the database said, so most of this
 * is a unit test. The one case that is not asks the real storage layer,
 * because a count is only worth anything if the query that feeds it is the
 * query the boot runs.
 *
 * Two properties pull against each other and both are pinned here. The
 * scan must **report** — a value outside the union has to reach an
 * operator with a number attached, which is the whole point. And it must
 * **not stop the boot**, on either the unrecognized-value path or the
 * failed-query path, because one image runs every process role from this
 * code and the realistic population is a rollback, where refusing makes
 * the recovery action the thing that cannot complete.
 *
 * `setStoredValueScan` is module state, exactly as `setPlatformDrift` is,
 * so it is reset in `afterEach`. Without that one test decides the next
 * one's answer, and the reader case is the one that would silently pass on
 * somebody else's recording.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { ITEM_STATES, TIERS } from "@withmarfa/shared";
import {
  SCANNED_COLUMNS,
  scanStoredValues,
  setStoredValueScan,
  storedValueScan,
  type ColumnValueCounts,
  type StoredValueCount,
} from "./stored-value-scan.js";
import { sqliteStoredValueCounts } from "./sqlite/stored-value-counts.js";
import { createTestContext } from "../test-utils.js";
import * as logger from "../middleware/logger.js";

/** A seam answering from a fixed table of `<table>.<column>` groups. */
function answering(
  groups: Record<string, StoredValueCount[]>,
): ColumnValueCounts {
  return (table, column) => Promise.resolve(groups[`${table}.${column}`] ?? []);
}

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoredValueScan({ scanned: false, values: [] });
});

describe("scanStoredValues", () => {
  it("reports a value outside the union with the number of rows holding it", async () => {
    const found = await scanStoredValues(
      answering({
        "api_keys.default_tier": [
          { value: "library", count: 40 },
          { value: "vault", count: 3 },
        ],
      }),
    );

    expect(found).toEqual({
      scanned: true,
      values: [
        {
          table: "api_keys",
          column: "default_tier",
          value: "vault",
          count: 3,
        },
      ],
    });
  });

  it("offers every rostered value to the comparison and reports nothing", async () => {
    // Positive, deliberately. An earlier version handed in a fixture keyed
    // by hand and asserted only that the result was empty and nothing was
    // logged — both negative, so misspelling all four fixture keys left it
    // passing while the scan compared nothing at all.
    //
    // So the fixture is built from `SCANNED_COLUMNS` itself, which makes a
    // misspelling impossible; an unrostered column throws rather than
    // answering empty; and the count of groups actually handed over is
    // asserted, which is what observes the fixture being consumed rather
    // than merely offered.
    let groupsOffered = 0;
    const found = await scanStoredValues((table, column) => {
      const entry = SCANNED_COLUMNS.find(
        (c) => c.table === table && c.column === column,
      );
      if (!entry) {
        throw new Error(
          `scanned a column not on the roster: ${table}.${column}`,
        );
      }
      const groups = entry.allowed.map((value) => ({ value, count: 1 }));
      groupsOffered += groups.length;
      return Promise.resolve(groups);
    });

    expect(found).toEqual({ scanned: true, values: [] });
    expect(groupsOffered).toBe(
      SCANNED_COLUMNS.reduce((n, c) => n + c.allowed.length, 0),
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("counts a null on a NOT NULL column and excuses one where null is a state", async () => {
    // `items.tier` is nullable by design — `system.*` items have no tier
    // because the dimension does not apply — so its null group is a real
    // state and counting it would report most of the table as broken.
    // Every other column here is NOT NULL, where a null is genuinely
    // unreadable and stays reportable.
    const found = await scanStoredValues(
      answering({
        "items.tier": [
          { value: null, count: 900 },
          { value: "library", count: 12 },
        ],
        "items.state": [{ value: null, count: 1 }],
      }),
    );

    expect(found).toEqual({
      scanned: true,
      values: [{ table: "items", column: "state", value: "null", count: 1 }],
    });
  });

  it("names the table, the column and the true stored string on the log line", async () => {
    // The stored string is logged because nothing else surfaces it: on the
    // columns that already carry a request-time guard every API response
    // reports the projection instead, and `/health` publishes the count
    // alone because it is unauthenticated.
    await scanStoredValues(
      answering({ "items.state": [{ value: "quarantined", count: 12 }] }),
    );

    expect(logSpy).toHaveBeenCalledWith(
      "error",
      "stored values are not ones this build recognizes",
      {
        table: "items",
        column: "state",
        stored_value: "quarantined",
        rows: 12,
      },
    );
  });

  it("names a value that is not a string legibly rather than as its typeof", async () => {
    // `typeof null` is `"object"`, which says nothing useful. Every column
    // here is NOT NULL, so this should be unreachable, which is exactly
    // why it is worth reporting legibly if it ever is.
    const found = await scanStoredValues(
      answering({ "items.state": [{ value: null, count: 2 }] }),
    );

    expect(found).toEqual({
      scanned: true,
      values: [{ table: "items", column: "state", value: "null", count: 2 }],
    });
  });

  it("does not stop the boot when a value is unrecognized", async () => {
    // The decision this file exists to pin. A throw here is every replica
    // of every process role exiting at once, including the workers that
    // drain the queues, over a data problem no restart repairs. So an
    // unrecognized value has to leave the scan running: it reports, it
    // reaches the columns behind the bad one, and it resolves.
    const found = await scanStoredValues(
      answering({
        "api_keys.default_tier": [{ value: "premium", count: 1 }],
        "items.state": [{ value: "quarantined", count: 5 }],
      }),
    );

    expect(found).toEqual({
      scanned: true,
      values: [
        {
          table: "api_keys",
          column: "default_tier",
          value: "premium",
          count: 1,
        },
        { table: "items", column: "state", value: "quarantined", count: 5 },
      ],
    });
  });

  it("records nothing when a column aggregate fails, rather than throwing", async () => {
    // The scan is a new query on the boot path, so an uncaught failure
    // would be refuse-to-boot by accident — the decision above, arrived at
    // through a missing `try` rather than through an argument.
    //
    // The whole scan is discarded rather than the failing column skipped:
    // `/health` publishes one bare number, and a partial answer is a wrong
    // number presented as a complete one. The finding on the column that
    // did answer is deliberately dropped with it.
    const found = await scanStoredValues((table, column) => {
      if (table === "items") return Promise.reject(new Error("no such column"));
      if (table === "api_keys" && column === "default_tier") {
        return Promise.resolve([{ value: "premium", count: 1 }]);
      }
      return Promise.resolve([]);
    });

    // `scanned: false` is the half that stops a discarded scan from
    // reading as a clean one at `/health`.
    expect(found).toEqual({ scanned: false, values: [] });
    expect(logSpy).toHaveBeenCalledWith(
      "error",
      "stored-value scan could not read a column",
      { table: "items", column: "state", error: "no such column" },
    );
  });

  it("records nothing when a column aggregate outruns its budget", async () => {
    // A query that did not finish did not answer, so it is treated exactly
    // as a failure is. Boot is the one place where waiting is expensive,
    // because a deploy's health check is waiting on it.
    vi.useFakeTimers();
    try {
      const scan = scanStoredValues(
        () =>
          new Promise<StoredValueCount[]>(() => {
            // Deliberately never settles: the unbounded-aggregate shape.
          }),
      );
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await scan).toEqual({ scanned: false, values: [] });
    } finally {
      vi.useRealTimers();
    }

    expect(logSpy).toHaveBeenCalledWith(
      "error",
      "stored-value scan outran its budget on a column",
      { table: "api_keys", column: "default_tier", budget_ms: 5_000 },
    );
  });

  it("keys every column off the shared union rather than restating it", () => {
    // Reference identity, not contents. A hardcoded copy of the same
    // values passes every behavioral test in this file and is still the
    // defect: a tier added to `TIERS` and not to the copy would make the
    // scan report every row holding the new value as unrecognized, on an
    // instance where nothing is wrong. Keyed off the array so widening a
    // union cannot leave this behind.
    const allowedFor = (table: string, column: string) =>
      SCANNED_COLUMNS.find((c) => c.table === table && c.column === column)
        ?.allowed;

    expect(allowedFor("api_keys", "default_tier")).toBe(TIERS);
    expect(allowedFor("items", "state")).toBe(ITEM_STATES);
    // The entry a cast-keyed roster could never have found: this column
    // was narrowed by comparison against two hardcoded literals rather
    // than by a cast, which is the same restated-union defect wearing
    // different syntax.
    expect(allowedFor("items", "tier")).toBe(TIERS);
  });
});

describe("storedValueScan", () => {
  it("reports what the last boot recorded, and nothing until one has", () => {
    // Not scanned before a boot has looked, which is a different answer
    // from a boot that looked and found nothing — and the reason the
    // reader carries a flag at all.
    expect(storedValueScan()).toEqual({ scanned: false, values: [] });

    const values = [
      { table: "api_keys", column: "default_tier", value: "vault", count: 3 },
    ];
    setStoredValueScan({ scanned: true, values });
    expect(storedValueScan()).toEqual({ scanned: true, values });

    setStoredValueScan({ scanned: true, values: [] });
    expect(storedValueScan()).toEqual({ scanned: true, values: [] });
  });
});

describe("the query the boot runs", () => {
  it("finds a real row through the query the boot uses", async () => {
    // The unit cases above prove the comparison. This proves the thing
    // feeding it: one aggregate per column, against real tables, through
    // the same seam builder each dialect's boot passes to the scan. A test
    // that wrote its own SQL here would prove only that two hand-written
    // queries agree.
    const ctx = await createTestContext();
    try {
      const store = ctx.storage as unknown as {
        __sqliteAll?: (q: string) => Promise<unknown[]>;
        __sqliteRun?: (q: string, p: unknown[]) => Promise<{ changes: number }>;
      };

      // One row, so the count is a fact about the fixture rather than
      // about how many credentials the context happened to mint.
      const plant = `UPDATE api_keys SET default_tier = 'junk_tier'
                      WHERE id = (SELECT id FROM api_keys LIMIT 1)`;

      const run = store.__sqliteRun;
      const all = store.__sqliteAll;
      if (!run || !all) throw new Error("sqlite escape hatches missing");
      await run(plant, []);
      const counts: ColumnValueCounts = sqliteStoredValueCounts((sql) =>
        all(sql),
      );

      const found = await scanStoredValues(counts);

      expect(found).toEqual({
        scanned: true,
        values: [
          {
            table: "api_keys",
            column: "default_tier",
            value: "junk_tier",
            count: 1,
          },
        ],
      });
    } finally {
      await ctx.cleanup();
    }
  });
});
