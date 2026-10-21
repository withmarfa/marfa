import { expect, it } from "vitest";
import { trashEligibleAt } from "./trash-retention.js";
it("calculates eligibility across leap days and month boundaries without promising sweep time", () => {
  expect(trashEligibleAt("2024-02-28T12:30:00.000Z", 2)).toBe(
    "2024-03-01T12:30:00.000Z",
  );
  expect(trashEligibleAt("2026-12-31T12:30:00.000Z", 1)).toBe(
    "2027-01-01T12:30:00.000Z",
  );
});
it("leaves disabled, missing, invalid and out-of-range deadlines unknown", () => {
  for (const [at, days] of [
    [null, 30],
    ["invalid", 30],
    ["2026-02-30T00:00:00Z", 30],
    ["2026-01-01", 0],
    ["9999-12-31T00:00:00Z", 1],
    ["2026-01-01", Number.MAX_SAFE_INTEGER],
  ] as const)
    expect(trashEligibleAt(at, days)).toBeNull();
});
