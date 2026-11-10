import { describe, expect, it } from "vitest";
import {
  expectedTotals,
  judgeRows,
  judgeTotals,
  readingCents,
  rowNumber,
  rowOf,
} from "./table-data.js";

describe("generated rows", () => {
  it("name the number they were made from, and nothing for altered values", () => {
    expect(rowNumber(rowOf(41, 3), 3)).toBe(41);
    expect(rowNumber({ ...rowOf(41, 3), note: "patched 0" }, 3)).toBeNull();
    expect(rowNumber({ ...rowOf(41, 3), reading: 1 }, 3)).toBeNull();
    expect(rowNumber({ ...rowOf(41, 3), extra: 1 }, 3)).toBeNull();
    expect(rowNumber(rowOf(41, 3), 5)).toBeNull();
    expect(rowNumber(null, 3)).toBeNull();
  });
});

describe("expectedTotals", () => {
  it("adds up the generated rows a selection keeps", () => {
    const all = expectedTotals(1000);
    expect(all.rows).toBe(1000);
    let cents = 0;
    for (let n = 0; n < 1000; n++) cents += readingCents(n);
    expect(all.cents).toBe(cents);
    expect(expectedTotals(1000, (n) => n % 4 === 3).rows).toBe(250);
  });
});

describe("judgeTotals", () => {
  const expected = expectedTotals(500);
  const right = {
    row_count: 500,
    totals: { reading: { sum: expected.cents / 100 } },
  };

  it("accepts the expected answer and names each way it differs", () => {
    expect(judgeTotals(right, expected)).toBeNull();
    expect(judgeTotals({ ...right, row_count: 499 }, expected)).toMatch(
      /row_count/,
    );
    expect(
      judgeTotals(
        {
          ...right,
          totals: { reading: { sum: right.totals.reading.sum + 1 } },
        },
        expected,
      ),
    ).toMatch(/sum/);
    expect(judgeTotals({ row_count: 500, totals: {} }, expected)).toMatch(
      /sum/,
    );
    expect(judgeTotals(null, expected)).toMatch(/row_count/);
  });
});

describe("judgeRows", () => {
  const rows = [
    { id: "a", values: { note: "x" } },
    { id: "b", values: { note: "y" } },
  ];

  it("accepts rows holding the expected values, and names a stale or missing one", () => {
    expect(
      judgeRows(rows, ["a", "b"], [{ note: "x" }, { note: "y" }]),
    ).toBeNull();
    expect(judgeRows(rows, ["a", "b"], [{ note: "x" }, { note: "z" }])).toMatch(
      /note/,
    );
    expect(judgeRows(rows, ["a"], [{ note: "x" }])).toMatch(/not 1/);
    expect(judgeRows(rows, ["b", "a"], [{ note: "y" }, { note: "x" }])).toMatch(
      /row 0/,
    );
    expect(
      judgeRows(rows, ["a", "b"], [{ note: "x", extra: 1 }, { note: "y" }]),
    ).toMatch(/extra/);
    expect(judgeRows(undefined, [], [])).toMatch(/no rows/);
  });
});
