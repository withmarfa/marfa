/**
 * The expansion is the part of recurring events that has to be right in
 * the ways calendars are traditionally wrong: the daylight-saving
 * boundary, the exception that shadows an occurrence, and the rule that
 * would run forever.
 *
 * Every fixture stores an instant, offset-bearing where a zone is
 * involved, because that is what the calendar connector writes and
 * what the type declares. A test that only ever feeds floating-with-Z
 * timestamps cannot see the difference between instant and wall-clock
 * arithmetic, which is exactly the blindness that let the double
 * conversion ship.
 */
import { describe, it, expect } from "vitest";
import {
  expandSeries,
  MAX_OCCURRENCES_PER_SERIES,
  RecurrenceExpansionError,
} from "./expand-recurrence.js";
import type { RecurrenceSeries } from "./expand-recurrence.js";

// Tuesday 09:00 Berlin, stored as the instant it names (08:00Z in
// winter). Berlin moves to summer time on 29 March 2026.
const weekly = (over: Partial<RecurrenceSeries> = {}): RecurrenceSeries => ({
  id: "series-1",
  starts_at: "2026-03-03T09:00:00+01:00",
  ends_at: "2026-03-03T10:00:00+01:00",
  timezone: "Europe/Berlin",
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
  ...over,
});

describe("expandSeries", () => {
  it("returns nothing for a series carrying no rule", () => {
    expect(
      expandSeries(
        weekly({ recurrence: [] }),
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-04-01T00:00:00Z"),
      ),
    ).toEqual([]);
  });

  it("computes the occurrences that start inside the window, as instants", () => {
    const out = expandSeries(
      weekly(),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-03-03T08:00:00.000Z",
      "2026-03-10T08:00:00.000Z",
      "2026-03-17T08:00:00.000Z",
      "2026-03-24T08:00:00.000Z",
    ]);
    expect(out.every((o) => o.item_id === "series-1")).toBe(true);
    expect(out.every((o) => o.series_id === "series-1")).toBe(true);
  });

  it("carries the series duration onto every occurrence", () => {
    const [first] = expandSeries(
      weekly(),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-05T00:00:00Z"),
    );
    expect(first?.ends_at).toBeDefined();
    expect(
      new Date(first!.ends_at!).getTime() -
        new Date(first!.starts_at).getTime(),
    ).toBe(3_600_000);
  });

  it("keeps the wall-clock hour across a daylight-saving transition", () => {
    // A 09:00 Berlin meeting stays 09:00 Berlin on both sides of the
    // transition, which is a different UTC hour either side. The stored
    // start is the instant of the first occurrence; the zone is what
    // carries the schedule across the change.
    const out = expandSeries(
      weekly({
        starts_at: "2026-03-24T09:00:00+01:00",
        ends_at: undefined,
      }),
      new Date("2026-03-20T00:00:00Z"),
      new Date("2026-04-10T00:00:00Z"),
    );
    const localHours = out.map((o) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        hour12: false,
      }).format(new Date(o.starts_at)),
    );
    expect(localHours).toEqual(["09", "09", "09"]);
    // Before the transition Berlin is UTC+1, after it is UTC+2.
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-03-24T08:00:00.000Z",
      "2026-03-31T07:00:00.000Z",
      "2026-04-07T07:00:00.000Z",
    ]);
  });

  it("expands an offset-bearing start without a zone as a plain instant", () => {
    // No zone means nothing anchors a wall clock, so the rule advances
    // in UTC from the stored instant. The offset in the string is
    // notation, not a zone: +01:00 on the start does not make later
    // occurrences follow Berlin's summer time.
    const out = expandSeries(
      weekly({ timezone: undefined, ends_at: undefined }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-12T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-03-03T08:00:00.000Z",
      "2026-03-10T08:00:00.000Z",
    ]);
  });

  it("treats a Z-suffixed start with no zone as already an instant", () => {
    const out = expandSeries(
      weekly({
        starts_at: "2026-03-03T09:00:00.000Z",
        ends_at: undefined,
        timezone: undefined,
      }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-12T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-03-03T09:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
    ]);
  });

  it("honors EXDATE against the series' own wall clock", () => {
    // The stored EXDATE names 09:00 on 10 March in the series zone,
    // which is the shape Google writes for a zoned series.
    const out = expandSeries(
      weekly({
        recurrence: [
          "RRULE:FREQ=WEEKLY;BYDAY=TU",
          "EXDATE;TZID=Europe/Berlin:20260310T090000",
        ],
      }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-03-03T08:00:00.000Z",
      "2026-03-17T08:00:00.000Z",
      "2026-03-24T08:00:00.000Z",
    ]);
  });

  it("honors a floating EXDATE the same way", () => {
    const out = expandSeries(
      weekly({
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", "EXDATE:20260310T090000"],
      }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at.slice(0, 10))).toEqual([
      "2026-03-03",
      "2026-03-17",
      "2026-03-24",
    ]);
  });

  it("honors RDATE, so an added occurrence appears off-rule", () => {
    const out = expandSeries(
      weekly({
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", "RDATE:20260305T090000"],
      }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-12T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-03-03T08:00:00.000Z",
      "2026-03-05T08:00:00.000Z",
      "2026-03-10T08:00:00.000Z",
    ]);
  });

  it("refuses EXRULE rather than silently not applying it", () => {
    // An EXRULE that was not applied would over-produce occurrences with
    // no error anywhere, so it is refused rather than ignored.
    expect(() =>
      expandSeries(
        weekly({
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", "EXRULE:FREQ=MONTHLY"],
        }),
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-03-25T00:00:00Z"),
      ),
    ).toThrow(/EXRULE/);
  });

  it("stops at COUNT rather than running to the window edge", () => {
    const out = expandSeries(
      weekly({ recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2"] }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(out).toHaveLength(2);
  });

  it("lets an exception shadow the occurrence it replaces", () => {
    // The exception's original start is stored offset-bearing, exactly
    // as the calendar connector writes it. It has to meet the
    // expanded occurrence on the instant they share.
    const out = expandSeries(
      weekly(),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
      [{ id: "moved-1", original_starts_at: "2026-03-10T09:00:00+01:00" }],
    );
    const shadowed = out.find((o) => o.replaces !== undefined);
    expect(shadowed?.item_id).toBe("moved-1");
    expect(shadowed?.replaces).toBe("2026-03-10T08:00:00.000Z");
    // Exactly one entry for that slot: the replacement, not both.
    expect(
      out.filter((o) => o.starts_at === "2026-03-10T08:00:00.000Z"),
    ).toHaveLength(1);
  });

  it("shadows across the daylight-saving boundary too", () => {
    // The occurrence after the transition sits at a different UTC hour
    // than the series start. A shadow key derived from the wrong side of
    // the conversion misses exactly here.
    const out = expandSeries(
      weekly(),
      new Date("2026-03-25T00:00:00Z"),
      new Date("2026-04-08T00:00:00Z"),
      [{ id: "moved-2", original_starts_at: "2026-03-31T09:00:00+02:00" }],
    );
    const shadowed = out.find((o) => o.replaces !== undefined);
    expect(shadowed?.item_id).toBe("moved-2");
    expect(shadowed?.replaces).toBe("2026-03-31T07:00:00.000Z");
  });

  it("ignores an exception that names an occurrence outside the window", () => {
    const out = expandSeries(
      weekly(),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-09T00:00:00Z"),
      [{ id: "moved-1", original_starts_at: "2026-03-17T09:00:00+01:00" }],
    );
    expect(out.every((o) => o.replaces === undefined)).toBe(true);
  });

  it("counts the cap against the window, not the series' history", () => {
    // A daily meeting running since 2021 contributes seven occurrences
    // to a seven-day window. Its age is not a reason to refuse.
    const out = expandSeries(
      weekly({
        starts_at: "2021-01-04T09:00:00+01:00",
        ends_at: undefined,
        recurrence: ["RRULE:FREQ=DAILY"],
      }),
      new Date("2026-08-10T00:00:00Z"),
      new Date("2026-08-17T00:00:00Z"),
    );
    expect(out).toHaveLength(7);
  });

  it("refuses a window a rule would flood, naming the window", () => {
    expect(() =>
      expandSeries(
        weekly({ recurrence: ["RRULE:FREQ=MINUTELY"] }),
        new Date("2026-03-03T08:00:00Z"),
        new Date("2026-03-31T00:00:00Z"),
      ),
    ).toThrow(/in this window/);
    expect(MAX_OCCURRENCES_PER_SERIES).toBeGreaterThan(400);
  });

  it("refuses a rule too frequent to even reach the window", () => {
    // A per-minute rule five years old would iterate millions of times
    // before the window opens. That is refused with its own reason
    // rather than blamed on the window.
    expect(() =>
      expandSeries(
        weekly({
          starts_at: "2021-01-04T09:00:00+01:00",
          recurrence: ["RRULE:FREQ=MINUTELY"],
        }),
        new Date("2026-08-10T00:00:00Z"),
        new Date("2026-08-11T00:00:00Z"),
      ),
    ).toThrow(/before it reaches the window/);
  });

  it("refuses a rule missing its frequency instead of crashing", () => {
    expect(() =>
      expandSeries(
        weekly({ recurrence: ["RRULE:INTERVAL=2"] }),
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-03-25T00:00:00Z"),
      ),
    ).toThrow(RecurrenceExpansionError);
  });

  it("refuses a rule with an unreadable UNTIL instead of crashing", () => {
    expect(() =>
      expandSeries(
        weekly({ recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=garbage"] }),
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-03-25T00:00:00Z"),
      ),
    ).toThrow(RecurrenceExpansionError);
  });

  it("refuses an unreadable rule instead of returning an empty day", () => {
    expect(() =>
      expandSeries(
        weekly({ recurrence: ["RRULE:FREQ=NOPE;BYDAY=??"] }),
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-03-25T00:00:00Z"),
      ),
    ).toThrow(RecurrenceExpansionError);
  });

  it("refuses a series whose start cannot be read", () => {
    expect(() =>
      expandSeries(
        weekly({ starts_at: "not a date" }),
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-03-25T00:00:00Z"),
      ),
    ).toThrow(RecurrenceExpansionError);
  });

  // Refused on write, and a row written before that can still carry one.
  // `Intl` raises a `RangeError` rather than
  // returning anything, and that raise used to leave this function as
  // something no caller could attribute to a series — which is the whole
  // difference between one bad row and a calendar that will not load.
  it.each([
    ["a misspelled IANA zone", "Europe/Berlim"],
    ["an offset written as a zone", "UTC+1"],
    ["a GMT offset", "GMT+2"],
    ["a Windows zone name", "Pacific Standard Time"],
  ])("refuses %s as this series' failure, not as a crash", (_label, zone) => {
    expect(() =>
      expandSeries(
        weekly({ timezone: zone }),
        new Date("2026-03-01T00:00:00Z"),
        new Date("2026-03-25T00:00:00Z"),
      ),
    ).toThrow(RecurrenceExpansionError);
  });

  it("still expands a series whose zone is an empty string", () => {
    // The conversions read an empty zone as no zone and advance the rule
    // in UTC. A guard testing for `undefined` rather than for
    // truthiness would refuse this, which is a working meeting removed
    // from a calendar to fix a row that expands correctly.
    const occurrences = expandSeries(
      weekly({ timezone: "" }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
    );
    expect(occurrences.map((o) => o.starts_at)).toEqual([
      "2026-03-03T08:00:00.000Z",
      "2026-03-10T08:00:00.000Z",
      "2026-03-17T08:00:00.000Z",
      "2026-03-24T08:00:00.000Z",
    ]);
  });

  it("expands a fixed-offset zone the database names", () => {
    // `Etc/GMT+5` keeps no daylight saving, but it is a zone the database
    // resolves, and calendars do send it.
    const occurrences = expandSeries(
      weekly({ timezone: "Etc/GMT+5" }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
    );
    expect(occurrences.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The account time zone is a default and a display preference. It is never
// what a rule advances in: a person moving country does not reschedule their
// calendar, and two people reading one shared series must see one answer.
//
// The failure mode is ambient rather than explicit — nothing has to *pass*
// the reader's zone in for the expansion to pick it up, because a date
// derived without naming a zone gets the process's. So the check is that the
// same series expands identically under two very different ambient zones.
// ---------------------------------------------------------------------------

describe("expansion is anchored to the series zone, not the reader's", () => {
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

  const series = {
    id: "series-ambient",
    // A weekly 09:00 Berlin meeting spanning the spring transition, which
    // is where a zone mistake stops being invisible.
    starts_at: "2026-03-25T09:00:00+01:00",
    ends_at: "2026-03-25T10:00:00+01:00",
    timezone: "Europe/Berlin",
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4"],
  };
  const from = new Date("2026-03-01T00:00:00Z");
  const to = new Date("2026-04-30T00:00:00Z");

  it("gives the same instants east and west of the event zone", () => {
    const auckland = underAmbientZone("Pacific/Auckland", () =>
      expandSeries(series, from, to).map((o) => o.starts_at),
    );
    const losAngeles = underAmbientZone("America/Los_Angeles", () =>
      expandSeries(series, from, to).map((o) => o.starts_at),
    );
    expect(auckland).toEqual(losAngeles);
    // And the wall clock is the one the series states, across the
    // transition: the instant moves, the local hour does not.
    expect(auckland[0]).toBe("2026-03-25T08:00:00.000Z");
    expect(auckland[1]).toBe("2026-04-01T07:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Values that carry an instant of their own are compared as that instant, and
// whole days stay whole. Each case here was answered wrongly by an expansion
// that read every value as a reading of the series' own clock.
// ---------------------------------------------------------------------------

describe("values carrying their own instant", () => {
  const tuesdays = (zone: string, start: string, lines: string[]) => ({
    id: "series-instant",
    starts_at: start,
    timezone: zone,
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", ...lines],
  });
  it.each([
    // East of UTC: London in summer and Tokyo, whose third meeting is the
    // UNTIL's own instant.
    ["Europe/London", "2026-06-02T08:00:00Z", "20260616T080000Z", 3],
    ["Asia/Tokyo", "2026-01-06T00:00:00Z", "20260120T000000Z", 3],
    // West of UTC: an UNTIL a second before the third meeting ends it at two.
    ["America/New_York", "2026-01-06T14:00:00Z", "20260120T135959Z", 2],
  ])(
    "ends a series at a UTC UNTIL's instant in %s",
    (zone, start, until, count) => {
      const series = tuesdays(zone, start, []);
      series.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=${until}`];
      expect(
        expandSeries(
          series,
          new Date("2026-01-01T00:00:00Z"),
          new Date("2026-07-01T00:00:00Z"),
        ),
      ).toHaveLength(count);
    },
  );

  it.each([
    ["in UTC", "EXDATE:20260609T080000Z"],
    ["in another zone", "EXDATE;TZID=America/New_York:20260609T040000"],
  ])("cancels the meeting an EXDATE names %s", (_label, line) => {
    const out = expandSeries(
      tuesdays("Europe/London", "2026-06-02T09:00:00+01:00", [line]),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-20T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-06-02T08:00:00.000Z",
      "2026-06-16T08:00:00.000Z",
    ]);
  });

  it("adds a UTC RDATE at its instant", () => {
    const out = expandSeries(
      tuesdays("Europe/London", "2026-06-02T09:00:00+01:00", [
        "RDATE:20260604T080000Z",
      ]),
      new Date("2026-06-03T00:00:00Z"),
      new Date("2026-06-05T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual(["2026-06-04T08:00:00.000Z"]);
  });
});

describe("a whole-day series", () => {
  it("spans whole local days on both sides of a clock change", () => {
    const out = expandSeries(
      {
        id: "offsite",
        starts_at: "2026-03-23",
        ends_at: "2026-03-24",
        all_day: true,
        timezone: "Europe/Berlin",
        recurrence: ["RRULE:FREQ=WEEKLY"],
      },
      new Date("2026-03-20T00:00:00Z"),
      new Date("2026-04-04T00:00:00Z"),
    );
    expect(out.map((o) => [o.starts_at, o.ends_at])).toEqual([
      ["2026-03-22T23:00:00.000Z", "2026-03-23T23:00:00.000Z"],
      ["2026-03-29T22:00:00.000Z", "2026-03-30T22:00:00.000Z"],
    ]);
  });

  it("honors duration when the series has no end", () => {
    const [first] = expandSeries(
      weekly({ ends_at: undefined, duration: 1800 }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-05T00:00:00Z"),
    );
    expect(first?.ends_at).toBe("2026-03-03T08:30:00.000Z");
  });
});

describe("a stored rule that names no date that exists", () => {
  it("produces nothing past its start", () => {
    expect(
      expandSeries(
        weekly({
          starts_at: "2026-01-15T09:00:00Z",
          ends_at: "2026-01-15T10:00:00Z",
          recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"],
        }),
        new Date("2026-02-01T00:00:00Z"),
        new Date("2027-01-01T00:00:00Z"),
      ),
    ).toEqual([]);
  });
});

// Rules that hold a widely used expander inside a single step until the
// process is killed or runs out of memory. A row carrying one may predate
// the write-time refusal, so the read has to survive it on its own.
describe("a stored rule that would otherwise hold the read", () => {
  const window = [
    new Date("2026-06-01T00:00:00Z"),
    new Date("2026-06-08T00:00:00Z"),
  ] as const;

  it.each([
    "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
    "RRULE:FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30",
    "RRULE:FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30",
    "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
  ])("answers within its bound: %s", (line) => {
    const started = Date.now();
    let outcome: unknown;
    try {
      outcome = expandSeries(
        weekly({
          starts_at: "1990-01-15T09:00:00Z",
          ends_at: undefined,
          recurrence: [line],
        }),
        ...window,
      );
    } catch (err) {
      outcome = err;
    }
    // Either nothing, or stopped and saying so: never a hang.
    if (Array.isArray(outcome)) expect(outcome).toEqual([]);
    else expect(String(outcome)).toMatch(/was stopped/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops a rule too costly to reach the window inside the walk", () => {
    const work = { iterations: 0 };
    expect(() =>
      expandSeries(
        weekly({
          starts_at: "2019-01-01T00:00:00Z",
          recurrence: ["RRULE:FREQ=SECONDLY"],
        }),
        ...window,
        [],
        work,
        { iterations: 5_000 },
      ),
    ).toThrow(/was stopped/);
    expect(work.iterations).toBe(5_001);
  });

  it("stops a walk at its deadline", () => {
    expect(() =>
      expandSeries(
        weekly({
          starts_at: "2019-01-01T00:00:00Z",
          recurrence: ["RRULE:FREQ=SECONDLY"],
        }),
        ...window,
        [],
        undefined,
        { iterations: Number.MAX_SAFE_INTEGER, timeMs: 20 },
      ),
    ).toThrow(/too long/);
  });
});
