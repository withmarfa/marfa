import { afterEach, describe, expect, it } from "vitest";
import { advanceClock, monotonicMs, resetClockForTests } from "../../clock.js";
import { ReadLifetime, ReadSnapshotUnavailable } from "./read-lifetime.js";

afterEach(() => {
  resetClockForTests();
});

describe("a read lifetime", () => {
  it("runs out when its deadline passes", () => {
    // The witness for the test below: a deadline already behind us ends it.
    const lifetime = new ReadLifetime({ deadlineAt: monotonicMs() - 1 });
    try {
      expect(() => {
        lifetime.assertAlive();
      }).toThrow(ReadSnapshotUnavailable);
    } finally {
      lifetime.dispose();
    }
  });

  it("is not ended by a move of the clock", () => {
    const lifetime = new ReadLifetime({ deadlineAt: monotonicMs() + 60_000 });
    try {
      advanceClock(3_600_000);
      expect(() => {
        lifetime.assertAlive();
      }).not.toThrow();
      expect(lifetime.abandoned).toBe(false);
    } finally {
      lifetime.dispose();
    }
  });

  it("keeps its default five seconds when the clock is moved before it opens", () => {
    advanceClock(3_600_000);
    const lifetime = new ReadLifetime();
    try {
      expect(() => {
        lifetime.assertAlive();
      }).not.toThrow();
    } finally {
      lifetime.dispose();
    }
  });
});
