/**
 * The normalizer behind the event instant columns.
 *
 * Every case here is a shape the column has to survive comparing
 * lexically against another one, so the assertions are on the exact
 * string rather than on the instant it denotes.
 */
import { describe, it, expect } from "vitest";
import { instantColumnValues } from "./instant-columns.js";

describe("instantColumnValues", () => {
  it("normalizes an offset-bearing instant to the same instant in Z", () => {
    expect(
      instantColumnValues({ starts_at: "2026-03-24T09:00:00+01:00" }).starts_at,
    ).toBe("2026-03-24T08:00:00.000Z");
    expect(
      instantColumnValues({ starts_at: "2026-05-05T09:00:00-05:30" }).starts_at,
    ).toBe("2026-05-05T14:30:00.000Z");
  });

  it("re-serializes a Z instant into the fixed-width shape", () => {
    // Already UTC, but not already the same width: without the
    // re-serialization a `Z` value and a `.000Z` value would order by
    // their punctuation.
    expect(
      instantColumnValues({ starts_at: "2026-05-05T09:00:00Z" }).starts_at,
    ).toBe("2026-05-05T09:00:00.000Z");
    expect(
      instantColumnValues({ starts_at: "2026-05-05T09:00Z" }).starts_at,
    ).toBe("2026-05-05T09:00:00.000Z");
  });

  it("projects a bare calendar date to UTC midnight", () => {
    expect(instantColumnValues({ starts_at: "2026-05-05" }).starts_at).toBe(
      "2026-05-05T00:00:00.000Z",
    );
  });

  it("reads a naive datetime as UTC rather than in the server's zone", () => {
    // The assertion that would fail if `new Date()` were left to
    // interpret this: the hour has to survive unchanged whatever TZ the
    // process runs under, because the SQL backfills read it as UTC.
    expect(
      instantColumnValues({ starts_at: "2026-05-05T09:00:00" }).starts_at,
    ).toBe("2026-05-05T09:00:00.000Z");
    expect(
      instantColumnValues({ starts_at: "2026-05-05 09:00:00" }).starts_at,
    ).toBe("2026-05-05T09:00:00.000Z");
  });

  it("keeps millisecond fidelity and truncates below it", () => {
    expect(
      instantColumnValues({ starts_at: "2026-05-05T09:00:00.123Z" }).starts_at,
    ).toBe("2026-05-05T09:00:00.123Z");
    expect(
      instantColumnValues({ starts_at: "2026-05-05T09:00:00.123456Z" })
        .starts_at,
    ).toBe("2026-05-05T09:00:00.123Z");
  });

  it("normalizes a partial date to the start of the period it names", () => {
    // `precision` exists so an event dated from memory can be stored with
    // only the year or month it is known to. Such a row still belongs on
    // a calendar, so it gets a column rather than being dropped.
    expect(instantColumnValues({ starts_at: "2026-05" }).starts_at).toBe(
      "2026-05-01T00:00:00.000Z",
    );
    expect(instantColumnValues({ starts_at: "1985" }).starts_at).toBe(
      "1985-01-01T00:00:00.000Z",
    );
  });

  it("carries both fields independently", () => {
    expect(
      instantColumnValues({
        starts_at: "2026-05-05T09:00:00+02:00",
        ends_at: "2026-05-05T10:30:00+02:00",
      }),
    ).toEqual({
      starts_at: "2026-05-05T07:00:00.000Z",
      ends_at: "2026-05-05T08:30:00.000Z",
    });
  });

  it("derives the end from duration, or a whole day, when none is stated", () => {
    expect(
      instantColumnValues({
        starts_at: "2026-05-05T09:00:00Z",
        duration: 5400,
      }),
    ).toEqual({
      starts_at: "2026-05-05T09:00:00.000Z",
      ends_at: "2026-05-05T10:30:00.000Z",
    });
    expect(
      instantColumnValues({ starts_at: "2026-05-05", all_day: true }),
    ).toEqual({
      starts_at: "2026-05-05T00:00:00.000Z",
      ends_at: "2026-05-06T00:00:00.000Z",
    });
    // A stated end wins over both.
    expect(
      instantColumnValues({
        starts_at: "2026-05-05T09:00:00Z",
        ends_at: "2026-05-05T09:15:00Z",
        duration: 5400,
      }).ends_at,
    ).toBe("2026-05-05T09:15:00.000Z");
  });

  it("derives no end from a duration no instant can hold", () => {
    expect(
      instantColumnValues({ starts_at: "2026-05-05T09:00:00Z", duration: 1e13 })
        .ends_at,
    ).toBeNull();
  });

  it("answers null for junk, absence, and non-strings", () => {
    expect(instantColumnValues({ starts_at: "next tuesday" })).toEqual({
      starts_at: null,
      ends_at: null,
    });
    expect(instantColumnValues({})).toEqual({
      starts_at: null,
      ends_at: null,
    });
    expect(instantColumnValues({ starts_at: "" })).toEqual({
      starts_at: null,
      ends_at: null,
    });
    expect(
      instantColumnValues({ starts_at: 1_767_225_600_000, ends_at: null }),
    ).toEqual({ starts_at: null, ends_at: null });
    expect(
      instantColumnValues({ starts_at: { at: "2026-05-05T09:00:00Z" } }),
    ).toEqual({ starts_at: null, ends_at: null });
  });

  it("orders lexically the way the instants order", () => {
    // The property the columns exist for. Mixed offsets across a
    // boundary is exactly the case a raw string comparison gets wrong.
    const values = [
      "2026-08-01T01:00:00+02:00", // 2026-07-31T23:00Z
      "2026-08-01T00:30:00Z",
      "2026-07-31T20:00:00-04:00", // 2026-08-01T00:00Z
    ].map((v) => instantColumnValues({ starts_at: v }).starts_at);

    expect([...values].sort()).toEqual([
      "2026-07-31T23:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:30:00.000Z",
    ]);
  });

  describe("a whole-day row", () => {
    const berlin = { all_day: true, timezone: "Europe/Berlin" };

    it("occupies its day from local midnight to local midnight", () => {
      expect(
        instantColumnValues({ ...berlin, starts_at: "2026-03-29" }),
      ).toEqual({
        starts_at: "2026-03-28T23:00:00.000Z",
        ends_at: "2026-03-29T22:00:00.000Z",
      });
      expect(
        instantColumnValues({
          all_day: true,
          timezone: "America/Los_Angeles",
          starts_at: "2026-01-15",
        }),
      ).toEqual({
        starts_at: "2026-01-15T08:00:00.000Z",
        ends_at: "2026-01-16T08:00:00.000Z",
      });
    });

    it("occupies its day in UTC when it names no zone", () => {
      expect(
        instantColumnValues({ all_day: true, starts_at: "2026-05-05" }),
      ).toEqual({
        starts_at: "2026-05-05T00:00:00.000Z",
        ends_at: "2026-05-06T00:00:00.000Z",
      });
    });

    it("ends at the local midnight of its stated end day", () => {
      expect(
        instantColumnValues({
          ...berlin,
          starts_at: "2026-01-10",
          ends_at: "2026-01-13",
        }),
      ).toEqual({
        starts_at: "2026-01-09T23:00:00.000Z",
        ends_at: "2026-01-12T23:00:00.000Z",
      });
    });

    it("takes the day an instant start falls on in its zone", () => {
      expect(
        instantColumnValues({
          ...berlin,
          starts_at: "2026-01-09T23:30:00Z",
        }).starts_at,
      ).toBe("2026-01-09T23:00:00.000Z");
      expect(
        instantColumnValues({
          ...berlin,
          starts_at: "2026-01-09T22:30:00Z",
        }).starts_at,
      ).toBe("2026-01-08T23:00:00.000Z");
    });

    it("rounds a stated duration up to whole days", () => {
      expect(
        instantColumnValues({
          ...berlin,
          starts_at: "2026-01-10",
          duration: 90_000,
        }).ends_at,
      ).toBe("2026-01-11T23:00:00.000Z");
    });

    it("is placed in UTC by a zone the database does not resolve, and has no span with no start", () => {
      expect(
        instantColumnValues({
          all_day: true,
          timezone: "Not/AZone",
          starts_at: "2026-05-05",
        }).starts_at,
      ).toBe("2026-05-05T00:00:00.000Z");
      expect(
        instantColumnValues({ all_day: true, timezone: "Europe/Berlin" }),
      ).toEqual({
        starts_at: null,
        ends_at: null,
      });
    });

    it("leaves a timed row alone, whatever its zone", () => {
      expect(
        instantColumnValues({
          timezone: "Europe/Berlin",
          starts_at: "2026-01-10",
        }).starts_at,
      ).toBe("2026-01-10T00:00:00.000Z");
    });
  });
});
