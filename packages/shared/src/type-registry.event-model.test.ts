/**
 * The calendar shapes `core.event` has to be able to hold.
 *
 * A whole day is not an instant, and a journey that crosses zones does not
 * end in the one it started in. Neither was expressible: all-day was carried
 * by whether a string happened to omit a time, and one `timezone` field had
 * to answer for both ends. Both rode along as undeclared properties, which a
 * loose space accepts silently and a space that enforces its own schema
 * refuses outright — so turning validation on made an ordinary all-day event
 * unstorable.
 *
 * These drive `validateProperties` in strict mode because that is the call
 * the write path makes, and it is where the refusal came from.
 */
import { describe, expect, it } from "vitest";
import { getTypeSchema, validateProperties } from "./type-registry.js";

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

  it("keeps both zones on the fidelity type too", () => {
    // One integration writes either type depending on how its connection was
    // configured, so a shape only one of them can hold is a shape the user
    // loses to a setting nobody asked them about.
    const props = accepted("google.calendar.event", {
      title: "BER to JFK",
      starts_at: "2026-09-20T10:00:00+02:00",
      ends_at: "2026-09-20T13:30:00-04:00",
      timezone: "Europe/Berlin",
      end_timezone: "America/New_York",
      all_day: false,
    });
    expect(props.end_timezone).toBe("America/New_York");
  });
});

describe("the two event types stay writable by one mapping", () => {
  it("declares the same names for the same meanings", () => {
    // `compatible_with` already forbids a same-named field of a different
    // shape. What it does not require is that the fidelity type declare the
    // field at all, and a mapping that writes both types from one branch
    // silently drops whatever only one of them knows about.
    const core = getTypeSchema("core.event");
    const google = getTypeSchema("google.calendar.event");
    for (const field of ["all_day", "end_timezone", "timezone"]) {
      expect(core?.fields[field], `core.event lacks ${field}`).toBeDefined();
      expect(
        google?.fields[field],
        `google.calendar.event lacks ${field}`,
      ).toBeDefined();
      expect(google?.fields[field]?.type).toBe(core?.fields[field]?.type);
    }
  });
});
