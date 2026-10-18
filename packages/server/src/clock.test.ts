import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceClock,
  clockOffsetMs,
  MAX_CLOCK_OFFSET_MS,
  monotonicMs,
  now,
  nowMs,
  resetClockForTests,
  setClockOffset,
} from "./clock.js";

afterEach(() => {
  resetClockForTests();
  vi.useRealTimers();
});

describe("clock", () => {
  it("reads the system clock until it is moved", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    expect(nowMs()).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
    expect(now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("moves forward by the step and keeps following the system clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    expect(advanceClock(86_400_000)).toBe(86_400_000);
    expect(now().toISOString()).toBe("2030-01-02T00:00:00.000Z");
    vi.advanceTimersByTime(1_000);
    expect(now().toISOString()).toBe("2030-01-02T00:00:01.000Z");
    advanceClock(1_000);
    expect(clockOffsetMs()).toBe(86_401_000);
  });

  it("leaves the monotonic reading where it was when the clock moves", () => {
    const before = monotonicMs();
    advanceClock(3_600_000);
    expect(monotonicMs() - before).toBeLessThan(1_000);
    expect(nowMs() - Date.now()).toBe(3_600_000);
  });

  it("refuses a step back and leaves the clock where it was", () => {
    advanceClock(5_000);
    expect(() => advanceClock(-1)).toThrow(RangeError);
    expect(clockOffsetMs()).toBe(5_000);
  });

  it("refuses a step that is not a whole number or goes past the last instant", () => {
    expect(() => advanceClock(1.5)).toThrow(RangeError);
    expect(() => advanceClock(Number.NaN)).toThrow(RangeError);
    expect(() => advanceClock(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => advanceClock(8_640_000_000_000_000)).toThrow(RangeError);
    expect(clockOffsetMs()).toBe(0);
  });

  it("refuses a step that would carry the offset past what a restart accepts", () => {
    advanceClock(MAX_CLOCK_OFFSET_MS - 10);
    expect(() => advanceClock(11)).toThrow(RangeError);
    expect(clockOffsetMs()).toBe(MAX_CLOCK_OFFSET_MS - 10);
    // The witness: the largest step that stays within it is taken.
    expect(advanceClock(10)).toBe(MAX_CLOCK_OFFSET_MS);
  });

  it("takes the offset a restarted server inherits", () => {
    setClockOffset(60_000);
    expect(clockOffsetMs()).toBe(60_000);
    expect(() => {
      setClockOffset(-1);
    }).toThrow(RangeError);
  });
});
