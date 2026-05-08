import { describe, expect, it } from "vitest";
import { computeNextRunAt, isValidCron } from "./cron.js";

describe("computeNextRunAt", () => {
  const t = (iso: string) => new Date(iso).getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  it("every-minute cron returns next minute boundary in UTC", () => {
    const next = computeNextRunAt("* * * * *", t("2026-01-01T00:00:30Z"));
    expect(iso(next)).toBe("2026-01-01T00:01:00.000Z");
  });

  it("hourly cron returns next top-of-hour", () => {
    const next = computeNextRunAt("0 * * * *", t("2026-01-01T00:30:00Z"));
    expect(iso(next)).toBe("2026-01-01T01:00:00.000Z");
  });

  it("daily-at-3am cron returns next 03:00 UTC", () => {
    const next = computeNextRunAt("0 3 * * *", t("2026-01-01T05:00:00Z"));
    expect(iso(next)).toBe("2026-01-02T03:00:00.000Z");
  });

  it("daily-at-3am cron from before 3am returns same day", () => {
    const next = computeNextRunAt("0 3 * * *", t("2026-01-01T02:30:00Z"));
    expect(iso(next)).toBe("2026-01-01T03:00:00.000Z");
  });

  it("crosses month boundary cleanly", () => {
    const next = computeNextRunAt("0 0 1 * *", t("2026-01-15T12:00:00Z"));
    expect(iso(next)).toBe("2026-02-01T00:00:00.000Z");
  });

  it("crosses year boundary cleanly", () => {
    const next = computeNextRunAt("0 0 * * *", t("2026-12-31T23:30:00Z"));
    expect(iso(next)).toBe("2027-01-01T00:00:00.000Z");
  });

  it("DST is irrelevant in UTC — March 2026 spring-forward day", () => {
    // 2026-03-08 is the US DST spring-forward; in UTC nothing skips.
    const next = computeNextRunAt("0 * * * *", t("2026-03-08T06:30:00Z"));
    expect(iso(next)).toBe("2026-03-08T07:00:00.000Z");
  });

  it("leap day handled in UTC", () => {
    const next = computeNextRunAt("0 0 * * *", t("2028-02-28T12:00:00Z"));
    expect(iso(next)).toBe("2028-02-29T00:00:00.000Z");
  });

  it("strictly forward — minute boundary at fromMs returns next minute", () => {
    const next = computeNextRunAt("* * * * *", t("2026-01-01T00:00:00Z"));
    // cron-parser semantics: next() steps strictly forward.
    expect(next).toBeGreaterThan(t("2026-01-01T00:00:00Z"));
  });

  it("throws on invalid cron expression", () => {
    expect(() => computeNextRunAt("not a cron", Date.now())).toThrow();
  });
});

describe("isValidCron", () => {
  it("accepts standard 5-field crons", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("0 * * * *")).toBe(true);
    expect(isValidCron("0 3 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidCron("nope")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });
});
