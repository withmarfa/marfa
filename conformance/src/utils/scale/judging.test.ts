import { describe, expect, it } from "vitest";
import {
  judgeExactCount,
  judgeItemTotal,
  judgePage,
  sumPageErrors,
  totalOfStats,
} from "./judging.js";

const body = (created: number, updated = 0, errored = 0, skipped = 0) =>
  JSON.stringify({
    counts: { created, updated, skipped, errored },
    results: [],
  });

describe("judging a bulk page", () => {
  it("finds nothing wrong when every entry was created or updated", () => {
    expect(judgePage(200, body(60, 40), 100)).toEqual({
      errors: 0,
      note: null,
    });
  });

  it("counts every entry the server reports errored, whatever the status", () => {
    const page = judgePage(200, body(90, 0, 10), 100);
    expect(page.errors).toBe(10);
    expect(page.note).toMatch(/10 of 100 entries errored/);
  });

  it("counts entries that are in no count as errors too, so a short answer cannot pass", () => {
    const page = judgePage(200, body(70, 0, 0), 100);
    expect(page.errors).toBe(30);
    expect(page.note).toMatch(/70 of 100 entries were created or updated/);
  });

  it("counts a skipped entry as a shortfall, since a page of new entries skips none", () => {
    expect(judgePage(200, body(99, 0, 0, 1), 100).errors).toBe(1);
  });

  it("counts the whole page when the server refused it", () => {
    const page = judgePage(500, "boom", 5_000);
    expect(page.errors).toBe(5_000);
    expect(page.note).toMatch(/answered 500/);
  });

  it("counts the whole page when a 200 carries no counts", () => {
    expect(judgePage(200, "{}", 100).errors).toBe(100);
    expect(judgePage(200, "not json", 100).errors).toBe(100);
    expect(judgePage(200, '{"counts":{"created":"7"}}', 100).errors).toBe(100);
  });

  it("does not count more written than sent as a shortfall of a negative size", () => {
    expect(judgePage(200, body(120), 100).errors).toBe(0);
  });
});

describe("adding pages up", () => {
  it("sums the errors and keeps the first note", () => {
    const pages = [
      judgePage(200, body(100), 100),
      judgePage(200, body(90, 0, 10), 100),
      judgePage(500, "x", 100),
    ];
    const sum = sumPageErrors(pages);
    expect(sum.errors).toBe(110);
    expect(sum.note).toMatch(/2 of 3 pages/);
  });

  it("has no note when every page was whole", () => {
    expect(sumPageErrors([judgePage(200, body(100), 100)])).toEqual({
      errors: 0,
      note: null,
    });
  });
});

describe("the instance's item total", () => {
  it("adds the counts by state", () => {
    expect(
      totalOfStats(JSON.stringify({ active: 20_000, archived: 120 })),
    ).toBe(20_120);
  });

  it.each([["not json"], ["null"], ["[]"], ["{}"], ['{"active":"1"}']])(
    "takes %s as no total",
    (text) => {
      expect(totalOfStats(text)).toBeNull();
    },
  );

  it("fails a stats call that errored or answered nonsense", () => {
    expect(judgeItemTotal(500, "x", 1_000)).toMatchObject({
      value: 0,
      errors: 1,
    });
    expect(judgeItemTotal(200, "{}", 1_000)).toMatchObject({
      value: 0,
      errors: 1,
    });
  });

  it("fails a total below the items the seed claims, by the shortfall", () => {
    const judged = judgeItemTotal(200, '{"active":900}', 1_000);
    expect(judged.value).toBe(900);
    expect(judged.errors).toBe(100);
    expect(judged.note).toMatch(/900.*1,000/);
  });

  it("passes a total at or above the claim, since later steps add items", () => {
    expect(judgeItemTotal(200, '{"active":1000}', 1_000).errors).toBe(0);
    expect(judgeItemTotal(200, '{"active":6000}', 1_000).errors).toBe(0);
  });
});

describe("judgeExactCount", () => {
  it("passes a count equal to the notes generated", () => {
    expect(judgeExactCount(200, '{"active":100}', 100, "note")).toEqual({
      value: 100,
      errors: 0,
      note: null,
    });
  });

  it("fails a count above the notes generated, by the surplus", () => {
    const judged = judgeExactCount(200, '{"active":103}', 100, "note");
    expect(judged.value).toBe(103);
    expect(judged.errors).toBe(3);
    expect(judged.note).toBe("the folder holds 103 notes and was given 100");
  });

  it("fails a count below the notes generated, by the shortfall", () => {
    const judged = judgeExactCount(200, '{"active":98}', 100, "note");
    expect(judged.errors).toBe(2);
    expect(judged.note).toBe("the folder holds 98 notes and was given 100");
  });

  it("fails a stats call that errored or answered nonsense", () => {
    expect(judgeExactCount(500, "x", 100, "note")).toMatchObject({
      value: 0,
      errors: 1,
    });
    expect(judgeExactCount(200, "{}", 100, "note")).toMatchObject({
      value: 0,
      errors: 1,
    });
  });
});
