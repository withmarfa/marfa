/**
 * A whole day has to land on the same date for everyone.
 *
 * The failure is ambient rather than explicit: nothing has to pass the
 * reader's zone in for a date derivation to pick it up, because a value
 * derived without naming a zone gets the process's. So these run the same
 * conversions under two very different ambient zones and require the answers
 * to match.
 */
import { describe, expect, it } from "vitest";
import {
  dateInZoneToInstant,
  instantToDateInZone,
  instantToWallClock,
  wallClockToInstant,
} from "./time-zones.js";

/** Runs `fn` with the process ambient zone set to `zone`. */
function underAmbientZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** East and west of the event zone, and far enough either way that a
 *  midnight-UTC storage choice would land on different days. */
const VIEWERS = ["Pacific/Auckland", "America/Los_Angeles", "UTC"];

describe("a whole day", () => {
  it("round-trips to the same date in every viewer zone", () => {
    for (const eventZone of [
      "Europe/Berlin",
      "America/Los_Angeles",
      "Pacific/Auckland",
      "Asia/Kolkata",
    ]) {
      const instant = dateInZoneToInstant("2026-09-15", eventZone);
      expect(instant, eventZone).not.toBeNull();
      for (const viewer of VIEWERS) {
        const seen = underAmbientZone(viewer, () =>
          instantToDateInZone(instant!, eventZone),
        );
        expect(seen, `${eventZone} seen from ${viewer}`).toBe("2026-09-15");
      }
    }
  });

  it("survives a daylight-saving transition on the day itself", () => {
    // 29 March 2026 is when Berlin springs forward; midnight exists, 02:00
    // does not. A day that starts on a transition is where a naive
    // add-the-offset conversion lands on the wrong date.
    const instant = dateInZoneToInstant("2026-03-29", "Europe/Berlin");
    for (const viewer of VIEWERS) {
      expect(
        underAmbientZone(viewer, () =>
          instantToDateInZone(instant!, "Europe/Berlin"),
        ),
      ).toBe("2026-03-29");
    }
  });

  it("starts at midnight in the event's zone, not at midnight UTC", () => {
    // The distinction that makes the round trip work. Midnight in Berlin is
    // the evening before in UTC; midnight UTC would be the evening before in
    // Los Angeles, which is the bug.
    expect(dateInZoneToInstant("2026-09-15", "Europe/Berlin")).toBe(
      "2026-09-14T22:00:00.000Z",
    );
    expect(dateInZoneToInstant("2026-09-15", "America/Los_Angeles")).toBe(
      "2026-09-15T07:00:00.000Z",
    );
    // Midnight UTC read back in Los Angeles is the day before — the shape
    // this exists to avoid.
    expect(
      instantToDateInZone("2026-09-15T00:00:00.000Z", "America/Los_Angeles"),
    ).toBe("2026-09-14");
  });

  it("falls back to UTC consistently when the event states no zone", () => {
    const instant = dateInZoneToInstant("2026-09-15", undefined);
    expect(instant).toBe("2026-09-15T00:00:00.000Z");
    for (const viewer of VIEWERS) {
      expect(
        underAmbientZone(viewer, () =>
          instantToDateInZone(instant!, undefined),
        ),
      ).toBe("2026-09-15");
    }
  });

  it("refuses a value that is not a bare date rather than storing NaN", () => {
    expect(
      dateInZoneToInstant("2026-09-15T10:00:00Z", "Europe/Berlin"),
    ).toBeNull();
    expect(dateInZoneToInstant("not a date", "Europe/Berlin")).toBeNull();
    expect(instantToDateInZone("not an instant", "Europe/Berlin")).toBeNull();
  });
});

describe("a timed event", () => {
  it("keeps its wall clock across a transition", () => {
    const before = wallClockToInstant(
      new Date("2026-03-25T09:00:00.000Z"),
      "Europe/Berlin",
    );
    const after = wallClockToInstant(
      new Date("2026-04-01T09:00:00.000Z"),
      "Europe/Berlin",
    );
    expect(before.toISOString()).toBe("2026-03-25T08:00:00.000Z");
    expect(after.toISOString()).toBe("2026-04-01T07:00:00.000Z");
    // And back: the reading is 09:00 on both sides of the change.
    expect(
      instantToWallClock(before, "Europe/Berlin").toISOString().slice(11, 16),
    ).toBe("09:00");
    expect(
      instantToWallClock(after, "Europe/Berlin").toISOString().slice(11, 16),
    ).toBe("09:00");
  });
});

// RFC 5545 section 3.3.5: a reading the clocks skip is read with the offset in
// force before the gap, which puts it later by the length of the gap, and a
// reading the clocks repeat names its first occurrence. One rule, so the same
// local time lands the same way whichever side of Greenwich the zone is.
describe("a reading a clock change skips or repeats", () => {
  const at = (wall: string, zone: string): string =>
    wallClockToInstant(new Date(`${wall}Z`), zone).toISOString();

  it.each([
    // London springs forward at 01:00 GMT on 29 March 2026: 01:30 does not exist.
    ["Europe/London", "2026-03-29T01:30:00", "2026-03-29T01:30:00.000Z"],
    // New York springs forward at 02:00 EST on 8 March 2026: 02:30 does not exist.
    ["America/New_York", "2026-03-08T02:30:00", "2026-03-08T07:30:00.000Z"],
    // Sydney springs forward at 02:00 AEST on 4 October 2026.
    ["Australia/Sydney", "2026-10-04T02:30:00", "2026-10-03T16:30:00.000Z"],
  ])("moves a skipped reading forward by the gap in %s", (zone, wall, want) => {
    expect(at(wall, zone)).toBe(want);
  });

  it.each([
    // London falls back at 02:00 BST on 25 October 2026: 01:30 happens twice,
    // first at 00:30Z (BST) and again at 01:30Z (GMT).
    ["Europe/London", "2026-10-25T01:30:00", "2026-10-25T00:30:00.000Z"],
    // New York falls back at 02:00 EDT on 1 November 2026: 01:30 is first
    // read at 05:30Z (EDT) and again at 06:30Z (EST).
    ["America/New_York", "2026-11-01T01:30:00", "2026-11-01T05:30:00.000Z"],
    // Sydney falls back at 03:00 AEDT on 5 April 2026: 02:30 is first read
    // at 15:30Z (AEDT) on the 4th.
    ["Australia/Sydney", "2026-04-05T02:30:00", "2026-04-04T15:30:00.000Z"],
  ])("takes the first of a repeated reading in %s", (zone, wall, want) => {
    expect(at(wall, zone)).toBe(want);
  });
});
