/**
 * The calendar shapes `core.event` has to be able to hold.
 *
 * A whole day is not an instant, and a journey that crosses zones does not
 * end in the one it started in, so the type declares `all_day` and an
 * `end_timezone` beside `timezone`. Undeclared, they would be accepted by a
 * loose instance and refused by one that enforces its own schema, which
 * would make an ordinary all-day event unstorable.
 *
 * These drive `validateProperties` in strict mode because that is the call
 * the write path makes, and it is where such a refusal would come from.
 */
import { describe, expect, it } from "vitest";
import { validateProperties } from "./type-registry.js";

/** Validates in strict mode and returns the accepted properties, failing with
 *  the validator's own complaint rather than a bare `false`. */
function accepted(
  typeId: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const result = validateProperties(typeId, properties, { strict: true });
  if (!result.success) {
    throw new Error(
      `${typeId} refused: ${result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
    );
  }
  return result.data;
}

describe("an all-day event", () => {
  it("says so, rather than implying it by omitting a time", () => {
    const props = accepted("core.event", {
      title: "Company offsite",
      starts_at: "2026-09-15",
      ends_at: "2026-09-16",
      all_day: true,
      timezone: "Europe/Berlin",
    });
    expect(props.all_day).toBe(true);
  });

  it("is a different question from how precisely the time is known", () => {
    // `precision` narrows an instant that exists; `all_day` says there is no
    // instant to narrow. Conflating them is the obvious wrong turn, so a type
    // that carries both has to accept both at once.
    const props = accepted("core.event", {
      title: "Sometime that week",
      starts_at: "2026-09-15",
      all_day: true,
      precision: "day",
    });
    expect(props.precision).toBe("day");
  });

  it("is a boolean, so a string cannot masquerade as one", () => {
    const result = validateProperties(
      "core.event",
      { title: "Offsite", all_day: "yes" },
      { strict: true },
    );
    expect(result.success).toBe(false);
  });
});

describe("an event that starts in one zone and ends in another", () => {
  it("keeps both zones on the cross-app type", () => {
    const props = accepted("core.event", {
      title: "BER to JFK",
      starts_at: "2026-09-20T10:00:00+02:00",
      ends_at: "2026-09-20T13:30:00-04:00",
      timezone: "Europe/Berlin",
      end_timezone: "America/New_York",
    });
    expect(props.timezone).toBe("Europe/Berlin");
    expect(props.end_timezone).toBe("America/New_York");
  });
});

describe("an event's schedule fields", () => {
  it("refuses a rule that names no date that exists, naming recurrence", () => {
    const result = validateProperties("core.event", {
      title: "Leap day",
      starts_at: "2026-01-15T09:00:00Z",
      recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.map((e) => e.field)).toEqual(["recurrence"]);
    }
  });

  it("refuses a zone the zone database does not resolve, naming the field", () => {
    const result = validateProperties("core.event", {
      title: "Standup",
      timezone: "Europe/Berlim",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.map((e) => e.field)).toEqual(["timezone"]);
    }
  });

  it("takes an ordinary weekly series in its zone", () => {
    const props = accepted("core.event", {
      title: "Standup",
      starts_at: "2026-01-06T09:00:00+01:00",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", "EXDATE:20260113T080000Z"],
    });
    expect(props.recurrence).toHaveLength(2);
  });
});
