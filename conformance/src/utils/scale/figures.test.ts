import { describe, expect, it } from "vitest";
import {
  CEILINGS,
  distribution,
  fragmentOf,
  scalar,
  type Figure,
} from "./figures.js";

describe("a distribution", () => {
  it("is headed by its p95 and checked against the ceiling the table names", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const figure = distribution("get_item", "ms", samples);
    expect(figure.p50).toBeCloseTo(50.5);
    expect(figure.p95).toBeCloseTo(95.05);
    expect(figure.value).toBe(figure.p95);
    expect(figure.samples).toBe(100);
    expect(figure.ceiling).toBe(CEILINGS.get_item?.ceiling);
    // 95 ms is over the 50 ms budget.
    expect(figure.passed).toBe(false);
  });

  it("passes at or under its ceiling", () => {
    const figure = distribution("get_item", "ms", [10, 20, 30]);
    expect(figure.passed).toBe(true);
  });

  it("fails with no samples, since nothing was measured", () => {
    const figure = distribution("get_item", "ms", []);
    expect(figure.passed).toBe(false);
    expect(figure.note).toMatch(/no samples/);
  });

  it("fails when a request in it answered an error, however fast the rest were", () => {
    const figure = distribution("get_item", "ms", [1, 2, 3], { errors: 2 });
    expect(figure.errors).toBe(2);
    expect(figure.passed).toBe(false);
  });

  it("has no verdict of its own when the table names no ceiling, but still fails on errors", () => {
    const quiet = distribution("search_rare", "ms", [900, 1000]);
    expect(quiet.ceiling).toBeNull();
    expect(quiet.passed).toBe(true);
    expect(distribution("search_rare", "ms", [1], { errors: 1 }).passed).toBe(
      false,
    );
  });
});

describe("a scalar", () => {
  it("takes its ceiling and issue from the table", () => {
    const figure = scalar("rss_at_rest", "MB", 250);
    expect(figure).toMatchObject({
      value: 250,
      ceiling: 300,
      issue: 2609,
      passed: true,
      p95: null,
    });
    expect(scalar("rss_at_rest", "MB", 301).passed).toBe(false);
  });

  it("fails a value that is not a finite number", () => {
    expect(scalar("rss_at_rest", "MB", Number.NaN).passed).toBe(false);
  });

  it("refuses a name the table does not know, so a typo cannot hide a ceiling", () => {
    expect(() => scalar("rss_at_reset", "MB", 1)).toThrow(/rss_at_reset/);
  });
});

describe("the table", () => {
  it("gives every ceiling a unit-free name and a positive or zero bound", () => {
    for (const [name, entry] of Object.entries(CEILINGS)) {
      expect(name, name).toMatch(/^[a-z0-9_]+$/);
      if (entry.ceiling !== null)
        expect(entry.ceiling).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("a fragment", () => {
  it("carries the step, its figures and what the step learned about the instance", () => {
    const figures: Figure[] = [scalar("rss_at_rest", "MB", 100)];
    expect(fragmentOf("restart", figures, { items: 5 })).toEqual({
      step: "restart",
      figures,
      items: 5,
    });
    expect(fragmentOf("restart", figures).items).toBeNull();
  });
});
