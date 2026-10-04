import { describe, expect, it } from "vitest";
import { validateTypeSchema } from "./schema-validation.js";

const declare = (version_policy: unknown) =>
  validateTypeSchema(
    {
      id: "acme.policy",
      fields: { title: { type: "string" } },
      version_policy,
    },
    { resolveSchema: () => undefined },
  );

function refusedAt(version_policy: unknown): string[] {
  const result = declare(version_policy);
  expect(result.success).toBe(false);
  return result.success ? [] : result.errors.map((e) => e.field);
}

describe("a type's version policy", () => {
  it("takes whole positive numbers, windows in order, and any part left out", () => {
    for (const policy of [
      { max_versions: 1 },
      { recent_days: 7, daily_snapshot_days: 30, weekly_snapshot_days: 365 },
      { recent_days: 30, daily_snapshot_days: 30, weekly_snapshot_days: 30 },
      { daily_snapshot_days: 30 },
      {},
    ]) {
      expect(declare(policy).success, JSON.stringify(policy)).toBe(true);
    }
  });

  it.each([0, -1, 1.5, "7", null])(
    "refuses %j for max_versions and every window, naming the field",
    (value) => {
      for (const key of [
        "max_versions",
        "recent_days",
        "daily_snapshot_days",
        "weekly_snapshot_days",
      ]) {
        expect(refusedAt({ [key]: value })).toContain(`version_policy.${key}`);
      }
    },
  );

  it("refuses windows out of order, naming the one that ends too soon", () => {
    expect(refusedAt({ recent_days: 30, daily_snapshot_days: 7 })).toEqual([
      "version_policy.daily_snapshot_days",
    ]);
    expect(
      refusedAt({ daily_snapshot_days: 90, weekly_snapshot_days: 30 }),
    ).toEqual(["version_policy.weekly_snapshot_days"]);
    expect(refusedAt({ recent_days: 400, weekly_snapshot_days: 365 })).toEqual([
      "version_policy.weekly_snapshot_days",
    ]);
  });

  it("holds a window against the longest one before it, not only the last", () => {
    expect(
      refusedAt({
        recent_days: 100,
        daily_snapshot_days: 50,
        weekly_snapshot_days: 70,
      }),
    ).toEqual([
      "version_policy.daily_snapshot_days",
      "version_policy.weekly_snapshot_days",
    ]);
  });
});
