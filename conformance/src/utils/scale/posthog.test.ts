import { describe, expect, it } from "vitest";
import { distribution, scalar } from "./figures.js";
import { benchmarkEvent, captureUrl, propertyName } from "./posthog.js";
import type { FiguresFile } from "./report.js";

const file: FiguresFile = {
  commit: "abc1234",
  runId: "42",
  date: "2026-11-03T04:43:00.000Z",
  profile: "scale-250k",
  items: 250_000,
  figures: [
    distribution("get_item", "ms", [10, 20, 30]),
    scalar("rss_at_rest", "MB", 400),
    scalar("bulk_page_ratio", "ratio", 1.1),
    scalar("seed_rate", "per_s", 330),
    scalar("items_seeded", "count", 250_000),
    scalar("server_restart", "ms", 1500),
    scalar("archive_export", "s", 120),
  ],
  missingSteps: [],
  problems: [],
};

describe("property names", () => {
  it("name a distribution's p50 and p95 with the unit", () => {
    expect(propertyName("get_item", "ms", "p95")).toBe("get_item_p95_ms");
    expect(propertyName("get_item", "ms", "p50")).toBe("get_item_p50_ms");
  });

  it("name a scalar with the unit", () => {
    expect(propertyName("rss_at_rest", "MB", "value")).toBe("rss_at_rest_mb");
    expect(propertyName("bulk_page_ratio", "ratio", "value")).toBe(
      "bulk_page_ratio_ratio",
    );
    expect(propertyName("seed_rate", "per_s", "value")).toBe("seed_rate_per_s");
    expect(propertyName("items_seeded", "count", "value")).toBe(
      "items_seeded_count",
    );
    expect(propertyName("archive_export", "s", "value")).toBe(
      "archive_export_s",
    );
  });
});

describe("the event", () => {
  const event = benchmarkEvent(file, {
    token: "phc_test",
    distinctId: "bench",
  });

  it("is one event with the token, a fixed id and no person profile", () => {
    expect(event.api_key).toBe("phc_test");
    expect(event.event).toBe("marfa nightly benchmark");
    expect(event.distinct_id).toBe("bench");
    expect(event.timestamp).toBe(file.date);
  });

  it("carries exactly these properties", () => {
    expect(Object.keys(event.properties).sort()).toEqual(
      [
        "$process_person_profile",
        "archive_export_s",
        "bulk_page_ratio_ratio",
        "commit",
        "failed_count",
        "get_item_p50_ms",
        "get_item_p95_ms",
        "items",
        "items_seeded_count",
        "passed",
        "profile",
        "rss_at_rest_mb",
        "run_id",
        "seed_rate_per_s",
        "server_restart_ms",
      ].sort(),
    );
  });

  it("holds numbers for figures and the verdict as given", () => {
    expect(event.properties).toMatchObject({
      get_item_p95_ms: 29,
      rss_at_rest_mb: 400,
      commit: "abc1234",
      run_id: "42",
      items: 250_000,
      passed: false,
      failed_count: 1,
      $process_person_profile: false,
    });
    for (const [key, value] of Object.entries(event.properties)) {
      if (key.endsWith("_ms") || key.endsWith("_mb"))
        expect(typeof value, key).toBe("number");
    }
  });

  it("counts a missing step as a failure", () => {
    const missing = benchmarkEvent(
      { ...file, figures: [], missingSteps: ["bulk", "export"] },
      { token: "t", distinctId: "d" },
    );
    expect(missing.properties).toMatchObject({
      passed: false,
      failed_count: 2,
    });
  });

  it("reports a clean night as passed", () => {
    const clean = benchmarkEvent(
      { ...file, figures: [scalar("rss_at_rest", "MB", 1)] },
      { token: "t", distinctId: "d" },
    );
    expect(clean.properties).toMatchObject({ passed: true, failed_count: 0 });
  });

  it("leaves an unknown size out as null rather than zero", () => {
    const unknown = benchmarkEvent(
      { ...file, items: null },
      { token: "t", distinctId: "d" },
    );
    expect(unknown.properties.items).toBeNull();
  });
});

describe("the capture address", () => {
  it("joins the host and the capture path whatever slash the host ends with", () => {
    expect(captureUrl("https://eu.i.posthog.com")).toBe(
      "https://eu.i.posthog.com/i/v0/e/",
    );
    expect(captureUrl("https://eu.i.posthog.com/")).toBe(
      "https://eu.i.posthog.com/i/v0/e/",
    );
  });
});
