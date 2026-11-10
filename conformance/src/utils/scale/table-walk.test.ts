import { describe, expect, it } from "vitest";
import { rowOf } from "./table-data.js";
import { WalkChecker, type WalkPlan } from "./table-walk.js";

const BUCKETS = 3;
const idOf = (n: number) => `id-${String(n).padStart(6, "0")}`;
const rowFor = (n: number, updated = "2026-01-01T00:00:00.000Z") => ({
  id: idOf(n),
  values: rowOf(n, BUCKETS),
  updated_at: updated,
});
const plan = (over: Partial<WalkPlan> = {}): WalkPlan => ({
  limit: 4,
  rows: 10,
  buckets: BUCKETS,
  order: "id",
  ...over,
});

function walkOf(checker: WalkChecker, pages: number[][], last = true) {
  let cursor: string | null = null;
  pages.forEach((numbers, i) => {
    const next = i === pages.length - 1 && last ? null : `c${i}`;
    checker.page(
      { data: numbers.map((n) => rowFor(n)), next_cursor: next },
      cursor,
    );
    cursor = next;
  });
  checker.finish(last ? "end" : "budget");
}

describe("WalkChecker", () => {
  it("passes a whole walk, with a short last page", () => {
    const checker = new WalkChecker(plan());
    walkOf(checker, [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
    expect(checker.problems).toEqual([]);
    expect(checker.rowsSeen).toBe(10);
    expect(checker.pageSums.map((p) => p.rows)).toEqual([4, 4, 2]);
  });

  it("names a row that came twice, a row that is missing, and a short walk", () => {
    const twice = new WalkChecker(plan());
    walkOf(twice, [
      [0, 1, 2, 3],
      [3, 4, 5, 6],
      [7, 8],
    ]);
    expect(twice.problems.join("\n")).toMatch(/came twice/);
    expect(twice.problems.join("\n")).toMatch(/out of order/);
    const missing = new WalkChecker(plan());
    walkOf(missing, [[0, 1, 2, 3], [4, 5, 6, 7], [8]]);
    expect(missing.problems.join("\n")).toMatch(/read 9 rows, not the 10/);
  });

  it("names a page over the limit, a short page with a cursor, and rows out of order", () => {
    const over = new WalkChecker(plan());
    over.page(
      { data: [0, 1, 2, 3, 4].map((n) => rowFor(n)), next_cursor: null },
      null,
    );
    expect(over.problems.join("\n")).toMatch(/for a limit of 4/);
    const short = new WalkChecker(plan());
    short.page({ data: [0, 1].map((n) => rowFor(n)), next_cursor: "c0" }, null);
    expect(short.problems.join("\n")).toMatch(/with a cursor, not 4/);
    const order = new WalkChecker(plan());
    order.page({ data: [1, 0].map((n) => rowFor(n)), next_cursor: null }, null);
    expect(order.problems.join("\n")).toMatch(/out of order/);
  });

  it("names a cursor that does not move on, and a walk that never ends", () => {
    const stuck = new WalkChecker(plan());
    stuck.page(
      { data: [0, 1, 2, 3].map((n) => rowFor(n)), next_cursor: "c0" },
      null,
    );
    stuck.page(
      { data: [4, 5, 6, 7].map((n) => rowFor(n)), next_cursor: "c0" },
      "c0",
    );
    expect(stuck.problems.join("\n")).toMatch(/did not move on/);
    stuck.finish("pages");
    expect(stuck.problems.join("\n")).toMatch(/did not end/);
  });

  it("names values that were never written, and a row the filter does not keep", () => {
    const changed = new WalkChecker(plan());
    changed.page(
      {
        data: [
          { ...rowFor(0), values: { ...rowOf(0, BUCKETS), note: "patched 0" } },
        ],
        next_cursor: null,
      },
      null,
    );
    expect(changed.problems.join("\n")).toMatch(/never written/);
    const filtered = new WalkChecker(plan({ keep: (n) => n % 3 === 0 }));
    filtered.page({ data: [rowFor(0), rowFor(1)], next_cursor: null }, null);
    expect(filtered.problems.join("\n")).toMatch(/not one the filter keeps/);
  });

  it("checks coverage of a filtered walk against the rows the filter keeps", () => {
    const keep = (n: number) => n % 3 === 0;
    const whole = new WalkChecker(plan({ keep }));
    walkOf(whole, [[0, 3, 6, 9]]);
    expect(whole.problems).toEqual([]);
    const short = new WalkChecker(plan({ keep }));
    walkOf(short, [[0, 3, 6]]);
    expect(short.problems.join("\n")).toMatch(/not the 4 written/);
  });

  it("orders by a column, ties by id, and by updated_at", () => {
    const sorted = [0, 5, 1, 6, 2, 7, 3, 8, 4, 9].sort(
      (a, b) =>
        rowOf(a, BUCKETS).reading - rowOf(b, BUCKETS).reading ||
        (idOf(a) < idOf(b) ? -1 : 1),
    );
    const checker = new WalkChecker(plan({ order: "reading", limit: 10 }));
    checker.page(
      { data: sorted.map((n) => rowFor(n)), next_cursor: null },
      null,
    );
    checker.finish("end");
    expect(checker.problems).toEqual([]);
    const reversed = new WalkChecker(plan({ order: "reading", limit: 10 }));
    reversed.page(
      { data: [...sorted].reverse().map((n) => rowFor(n)), next_cursor: null },
      null,
    );
    expect(reversed.problems.join("\n")).toMatch(/out of order/);
    const byTime = new WalkChecker(plan({ order: "updated_at" }));
    byTime.page(
      {
        data: [
          rowFor(0, "2026-01-02T00:00:00Z"),
          rowFor(1, "2026-01-01T00:00:00Z"),
        ],
        next_cursor: null,
      },
      null,
    );
    expect(byTime.problems.join("\n")).toMatch(/out of order/);
  });

  it("judges only what a walk read when it stopped on its budget", () => {
    const checker = new WalkChecker(plan());
    walkOf(checker, [[0, 1, 2, 3]], false);
    expect(checker.problems).toEqual([]);
  });

  it("answers the same digest for the same ids in the same order only", () => {
    const a = new WalkChecker(plan());
    const b = new WalkChecker(plan());
    walkOf(a, [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
    walkOf(b, [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
    expect(a.digest()).toBe(b.digest());
    const c = new WalkChecker(plan());
    walkOf(c, [[0, 1, 2, 3], [4, 5, 6, 7], [8]]);
    expect(c.digest()).not.toBe(a.digest());
  });
});
