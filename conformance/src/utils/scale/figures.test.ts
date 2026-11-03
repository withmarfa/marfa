import { describe, expect, it } from "vitest";
import {
  CEILINGS,
  MIN_SAMPLES,
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
    const figure = distribution(
      "get_item",
      "ms",
      Array.from({ length: MIN_SAMPLES }, () => 10),
    );
    expect(figure.passed).toBe(true);
  });

  it("does not pass a ceiling on fewer samples than it needs, however fast they were", () => {
    const figure = distribution(
      "get_item",
      "ms",
      Array.from({ length: MIN_SAMPLES - 1 }, () => 1),
    );
    expect(figure.passed).toBe(false);
    expect(figure.note).toMatch(/19 samples.*at least 20/);
  });

  it("keeps the caller's note beside the one about too few samples", () => {
    const figure = distribution("get_item", "ms", [1, 2], { note: "a note" });
    expect(figure.note).toMatch(/a note/);
    expect(figure.note).toMatch(/2 samples/);
  });

  it("fails with no samples, since nothing was measured", () => {
    const figure = distribution("get_item", "ms", []);
    expect(figure.passed).toBe(false);
    expect(figure.note).toMatch(/no samples/);
  });

  it("fails when a request in it answered an error, however fast the rest were", () => {
    const figure = distribution(
      "get_item",
      "ms",
      Array.from({ length: 30 }, () => 1),
      { errors: 2 },
    );
    expect(figure.errors).toBe(2);
    expect(figure.passed).toBe(false);
  });

  it("has no verdict of its own when the table names no ceiling, but still fails on errors", () => {
    const quiet = distribution("search_rare", "ms", [900, 1000]);
    expect(quiet.ceiling).toBeNull();
    // Nothing is judged, so few samples are no fault.
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

  it("judges a figure whose ceiling is relative against the ceiling its step works out", () => {
    const within = scalar("rss_after_bulk_10s", "MB", 350, { ceiling: 400 });
    expect(within).toMatchObject({ ceiling: 400, issue: 2609, passed: true });
    expect(
      scalar("rss_after_bulk_10s", "MB", 401, { ceiling: 400 }).passed,
    ).toBe(false);
  });

  it("refuses a relative figure with no ceiling, and a fixed figure with one", () => {
    expect(() => scalar("rss_after_bulk_10s", "MB", 1)).toThrow(/ceiling/);
    expect(() => scalar("rss_at_rest", "MB", 1, { ceiling: 999 })).toThrow(
      /ceiling/,
    );
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

describe("the folder and device figures", () => {
  it("takes each ceiling from the budget or the issue that set it", () => {
    expect(CEILINGS.folder_scan).toEqual({ ceiling: 60, issue: 2610 });
    expect(CEILINGS.folder_first_sync).toEqual({ ceiling: 300, issue: null });
    expect(CEILINGS.folder_edit_to_server).toEqual({
      ceiling: 2000,
      issue: 2611,
    });
    expect(CEILINGS.folder_watch_cpu).toEqual({ ceiling: 0.5, issue: 2608 });
    expect(CEILINGS.device_hydrate).toEqual({ ceiling: 60, issue: null });
    expect(CEILINGS.device_follow_change).toEqual({
      ceiling: 1000,
      issue: null,
    });
  });

  it("only records what has no budget", () => {
    for (const name of [
      "folder_hydrate",
      "folder_push",
      "folder_notes_synced",
      "folder_watch_rss",
      "device_copy_size",
    ]) {
      expect(CEILINGS[name]?.ceiling, name).toBeNull();
    }
  });

  it("judges a quiet watch by CPU seconds a minute", () => {
    expect(scalar("folder_watch_cpu", "cpu_s_per_min", 0.4).passed).toBe(true);
    expect(scalar("folder_watch_cpu", "cpu_s_per_min", 26).passed).toBe(false);
  });

  it("judges an edit's time to the server by its p95 over at least 30 edits", () => {
    const fast = Array.from({ length: 30 }, () => 1_900);
    expect(distribution("folder_edit_to_server", "ms", fast).passed).toBe(true);
    const slow = [...fast.slice(1), 7_500, 7_500, 7_500];
    expect(distribution("folder_edit_to_server", "ms", slow).passed).toBe(
      false,
    );
  });

  it("fails an edit that never arrived, however quick the others were", () => {
    const figure = distribution(
      "folder_edit_to_server",
      "ms",
      Array.from({ length: 29 }, () => 100),
      { errors: 1 },
    );
    expect(figure.passed).toBe(false);
  });

  it("does not pass a device change figure on a handful of samples", () => {
    expect(
      distribution("device_follow_change", "ms", [10, 10, 10]).passed,
    ).toBe(false);
  });
});
