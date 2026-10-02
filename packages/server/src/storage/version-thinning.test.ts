import { describe, it, expect } from "vitest";
import type { Version } from "@withmarfa/shared";
import {
  computeVersionsToDelete,
  resolvePolicy,
  type ResolvedPolicy,
} from "./version-thinning.js";

const DEFAULTS: ResolvedPolicy = {
  recentDays: 30,
  dailySnapshotDays: 90,
  weeklySnapshotDays: 365,
  maxVersions: 500,
};

function makeVersion(id: string, version: number, createdAt: string): Version {
  return {
    id,
    item_id: "item-1",
    version,
    properties: {},
    created_at: createdAt,
  };
}

function daysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function hoursAgo(hours: number, now: Date): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

describe("resolvePolicy", () => {
  it("returns global defaults when no type policy", () => {
    expect(resolvePolicy(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("merges per-type overrides with defaults", () => {
    const result = resolvePolicy(
      { recent_days: 7, max_versions: 100 },
      DEFAULTS,
    );
    expect(result).toEqual({
      recentDays: 7,
      dailySnapshotDays: 90,
      weeklySnapshotDays: 365,
      maxVersions: 100,
    });
  });

  it("uses all type policy fields when provided", () => {
    const result = resolvePolicy(
      {
        recent_days: 14,
        daily_snapshot_days: 60,
        weekly_snapshot_days: 180,
        max_versions: 50,
      },
      DEFAULTS,
    );
    expect(result).toEqual({
      recentDays: 14,
      dailySnapshotDays: 60,
      weeklySnapshotDays: 180,
      maxVersions: 50,
    });
  });
});

describe("computeVersionsToDelete", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("returns empty for 0 versions", () => {
    expect(computeVersionsToDelete([], DEFAULTS, now)).toEqual([]);
  });

  it("returns empty for 1 version", () => {
    const versions = [makeVersion("v1", 1, daysAgo(100, now))];
    expect(computeVersionsToDelete(versions, DEFAULTS, now)).toEqual([]);
  });

  it("keeps all versions in the recent window", () => {
    const versions = [
      makeVersion("v1", 1, daysAgo(5, now)),
      makeVersion("v2", 2, daysAgo(3, now)),
      makeVersion("v3", 3, daysAgo(1, now)),
    ];
    expect(computeVersionsToDelete(versions, DEFAULTS, now)).toEqual([]);
  });

  it("thins daily window to one version per day", () => {
    // 45 days ago: two versions on the same day, should keep latest
    const day45 = new Date(now.getTime() - 45 * 86_400_000);
    const earlyDay = new Date(day45);
    earlyDay.setUTCHours(9, 0, 0, 0);
    const lateDay = new Date(day45);
    lateDay.setUTCHours(17, 0, 0, 0);

    const versions = [
      makeVersion("v1", 1, earlyDay.toISOString()),
      makeVersion("v2", 2, lateDay.toISOString()),
      makeVersion("v3", 3, daysAgo(1, now)), // recent, always kept
    ];

    const toDelete = computeVersionsToDelete(versions, DEFAULTS, now);
    expect(toDelete).toEqual(["v1"]); // early version deleted, late version kept
  });

  it("thins weekly window to one version per week", () => {
    // 120 days ago: two versions in the same week
    const day120 = new Date(now.getTime() - 120 * 86_400_000);
    const day121 = new Date(now.getTime() - 121 * 86_400_000);
    // Same ISO week (1 day apart)

    const versions = [
      makeVersion("v1", 1, day121.toISOString()),
      makeVersion("v2", 2, day120.toISOString()),
      makeVersion("v3", 3, daysAgo(1, now)), // recent
    ];

    const toDelete = computeVersionsToDelete(versions, DEFAULTS, now);
    // v1 and v2 are in the same week — keep only the latest (v2)
    expect(toDelete).toContain("v1");
    expect(toDelete).not.toContain("v2");
  });

  it("deletes versions beyond the weekly window", () => {
    const versions = [
      makeVersion("v1", 1, daysAgo(400, now)), // beyond 365 days
      makeVersion("v2", 2, daysAgo(1, now)), // recent
    ];

    const toDelete = computeVersionsToDelete(versions, DEFAULTS, now);
    expect(toDelete).toEqual(["v1"]);
  });

  it("always keeps the most recent version regardless of age", () => {
    // Only 2 versions, both very old
    const versions = [
      makeVersion("v1", 1, daysAgo(500, now)),
      makeVersion("v2", 2, daysAgo(400, now)),
    ];

    const toDelete = computeVersionsToDelete(versions, DEFAULTS, now);
    // v2 is the most recent by version number — must be kept
    expect(toDelete).not.toContain("v2");
    expect(toDelete).toContain("v1");
  });

  it("enforces hard cap by dropping oldest kept versions", () => {
    const policy: ResolvedPolicy = {
      ...DEFAULTS,
      maxVersions: 3,
    };

    // 5 versions all in the recent window (all would normally be kept)
    const versions = [
      makeVersion("v1", 1, hoursAgo(5, now)),
      makeVersion("v2", 2, hoursAgo(4, now)),
      makeVersion("v3", 3, hoursAgo(3, now)),
      makeVersion("v4", 4, hoursAgo(2, now)),
      makeVersion("v5", 5, hoursAgo(1, now)),
    ];

    const toDelete = computeVersionsToDelete(versions, policy, now);
    // Should keep 3: v3, v4, v5 (most recent + newest kept)
    // Should delete v1, v2 (oldest)
    expect(toDelete.sort()).toEqual(["v1", "v2"]);
  });

  it("never deletes most recent version even under hard cap", () => {
    const policy: ResolvedPolicy = {
      ...DEFAULTS,
      maxVersions: 1,
    };

    const versions = [
      makeVersion("v1", 1, daysAgo(2, now)),
      makeVersion("v2", 2, daysAgo(1, now)),
      makeVersion("v3", 3, hoursAgo(1, now)),
    ];

    const toDelete = computeVersionsToDelete(versions, policy, now);
    expect(toDelete).not.toContain("v3"); // most recent always kept
  });

  it("handles mixed windows correctly", () => {
    const versions = [
      makeVersion("v1", 1, daysAgo(500, now)), // beyond weekly — delete
      makeVersion("v2", 2, daysAgo(200, now)), // weekly window — keep (sole in week)
      makeVersion("v3", 3, daysAgo(60, now)), // daily window — keep (sole in day)
      makeVersion("v4", 4, daysAgo(5, now)), // recent — keep
      makeVersion("v5", 5, daysAgo(1, now)), // recent — keep
    ];

    const toDelete = computeVersionsToDelete(versions, DEFAULTS, now);
    expect(toDelete).toEqual(["v1"]);
  });

  it("keeps multiple daily snapshots for different days", () => {
    const versions = [
      makeVersion("v1", 1, daysAgo(40, now)), // day A
      makeVersion("v2", 2, daysAgo(50, now)), // day B
      makeVersion("v3", 3, daysAgo(60, now)), // day C
      makeVersion("v4", 4, daysAgo(1, now)), // recent
    ];

    // Each is on a different day in the daily window — all kept
    const toDelete = computeVersionsToDelete(versions, DEFAULTS, now);
    expect(toDelete).toEqual([]);
  });

  it("keeps every version when a window cannot be decided", () => {
    // Ten versions from the last ten minutes, the latest last.
    const versions = Array.from({ length: 10 }, (_, i) =>
      makeVersion(`v${String(i)}`, i + 1, hoursAgo((10 - i) / 60, now)),
    );
    // The witness: windows of zero days put all but the latest in no window.
    const none = {
      ...DEFAULTS,
      recentDays: 0,
      dailySnapshotDays: 0,
      weeklySnapshotDays: 0,
    };
    expect(computeVersionsToDelete(versions, none, now)).toHaveLength(9);
    for (const field of [
      "recentDays",
      "dailySnapshotDays",
      "weeklySnapshotDays",
    ] as const) {
      const policy = { ...none, [field]: Number("30 days") };
      expect(computeVersionsToDelete(versions, policy, now)).toEqual([]);
    }
  });

  it("keeps a version whose timestamp cannot be read", () => {
    const versions = [
      makeVersion("v1", 1, "not a time"),
      makeVersion("v2", 2, daysAgo(400, now)),
      makeVersion("v3", 3, daysAgo(1, now)),
    ];
    expect(computeVersionsToDelete(versions, DEFAULTS, now)).toEqual(["v2"]);
  });
});
