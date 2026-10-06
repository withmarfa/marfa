import { describe, expect, it } from "vitest";
import {
  compileSchedule,
  eventScheduleIssues,
  occurrenceEndMs,
  occurrenceStarts,
  RecurrenceBoundError,
  RecurrenceMeter,
  RecurrenceRuleError,
  scheduleProblem,
  wholeDaySpan,
} from "./recurrence.js";
import type { RecurrenceSchedule } from "./recurrence.js";

function starts(
  schedule: RecurrenceSchedule,
  from: string,
  to: string,
  meter = new RecurrenceMeter(),
): string[] {
  return occurrenceStarts(
    compileSchedule(schedule),
    Date.parse(from),
    Date.parse(to),
    meter,
  ).map((ms) => new Date(ms).toISOString());
}

describe("the rule's own shape", () => {
  it("counts the series' start as its first occurrence, matched by the rule or not", () => {
    // A Thursday start under a Tuesday rule: RFC 5545 counts the start, then
    // the rule's own days.
    expect(
      starts(
        {
          starts_at: "2026-01-15T09:00:00Z",
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3"],
        },
        "2026-01-01T00:00:00Z",
        "2026-03-01T00:00:00Z",
      ),
    ).toEqual([
      "2026-01-15T09:00:00.000Z",
      "2026-01-20T09:00:00.000Z",
      "2026-01-27T09:00:00.000Z",
    ]);
  });

  it.each([
    [
      "monthly by numbered weekday",
      "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3",
      "2026-01-30T09:00:00Z",
      ["2026-01-30", "2026-02-27", "2026-03-27"],
    ],
    [
      "yearly by month and numbered weekday",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3",
      "2026-11-26T09:00:00Z",
      ["2026-11-26", "2027-11-25", "2028-11-23"],
    ],
    [
      "the last weekday of the month",
      "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3",
      "2026-01-30T09:00:00Z",
      ["2026-01-30", "2026-02-27", "2026-03-31"],
    ],
    [
      "the 29th of February",
      "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=3",
      "2028-02-29T09:00:00Z",
      ["2028-02-29", "2032-02-29", "2036-02-29"],
    ],
    [
      "the last day of the month",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3",
      "2026-01-31T09:00:00Z",
      ["2026-01-31", "2026-02-28", "2026-03-31"],
    ],
    [
      "every other week on two days",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4",
      "2026-01-05T09:00:00Z",
      ["2026-01-05", "2026-01-07", "2026-01-19", "2026-01-21"],
    ],
    [
      "the 31st, in the months that have one",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
      "2026-01-31T09:00:00Z",
      ["2026-01-31", "2026-03-31", "2026-05-31"],
    ],
    [
      "week 1 under ISO numbering",
      "RRULE:FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO;COUNT=3",
      "2027-01-04T09:00:00Z",
      ["2027-01-04", "2028-01-03", "2029-01-01"],
    ],
    [
      "the 100th day of the year",
      "RRULE:FREQ=YEARLY;BYYEARDAY=100;COUNT=2",
      "2026-04-10T09:00:00Z",
      ["2026-04-10", "2027-04-10"],
    ],
  ])("unfolds %s", (_label, line, start, days) => {
    expect(
      starts(
        { starts_at: start, recurrence: [line] },
        "2026-01-01T00:00:00Z",
        "2040-01-01T00:00:00Z",
      ).map((s) => s.slice(0, 10)),
    ).toEqual(days);
  });

  it("unfolds hourly and minutely rules within their limits", () => {
    expect(
      starts(
        {
          starts_at: "2026-01-05T09:15:00Z",
          recurrence: ["RRULE:FREQ=HOURLY;INTERVAL=3;BYHOUR=9,12,15;COUNT=4"],
        },
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
      ),
    ).toEqual([
      "2026-01-05T09:15:00.000Z",
      "2026-01-05T12:15:00.000Z",
      "2026-01-05T15:15:00.000Z",
      "2026-01-06T09:15:00.000Z",
    ]);
    expect(
      starts(
        {
          starts_at: "2026-01-05T09:00:00Z",
          recurrence: ["RRULE:FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10"],
        },
        "2026-01-05T00:00:00Z",
        "2026-01-06T00:00:00Z",
      ),
    ).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T09:20:00.000Z",
      "2026-01-05T09:40:00.000Z",
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T10:20:00.000Z",
      "2026-01-05T10:40:00.000Z",
    ]);
  });

  it.each([
    ["no FREQ", "RRULE:INTERVAL=2"],
    ["an unknown FREQ", "RRULE:FREQ=NOPE"],
    ["an unreadable UNTIL", "RRULE:FREQ=WEEKLY;UNTIL=garbage"],
    ["COUNT beside UNTIL", "RRULE:FREQ=DAILY;COUNT=2;UNTIL=20270101T000000Z"],
    ["an unknown part", "RRULE:FREQ=DAILY;BYEASTER=1"],
    ["a part given twice", "RRULE:FREQ=DAILY;COUNT=2;COUNT=3"],
    ["a numbered weekday on a weekly rule", "RRULE:FREQ=WEEKLY;BYDAY=1MO"],
    ["BYMONTHDAY on a weekly rule", "RRULE:FREQ=WEEKLY;BYMONTHDAY=3"],
    ["BYWEEKNO on a monthly rule", "RRULE:FREQ=MONTHLY;BYWEEKNO=3"],
    ["a month numbered 13", "RRULE:FREQ=YEARLY;BYMONTH=13"],
    ["an EXRULE", "EXRULE:FREQ=MONTHLY"],
    ["a property that is not a recurrence line", "DTSTART:20260101T000000Z"],
    ["an RDATE period", "RDATE;VALUE=PERIOD:20260101T000000Z/PT1H"],
    ["a TZID that names no zone", "EXDATE;TZID=Mars/Olympus:20260101T090000"],
    ["a date that does not exist", "EXDATE:20260230T090000Z"],
  ])("refuses %s", (_label, line) => {
    expect(() =>
      compileSchedule({
        starts_at: "2026-01-05T09:00:00Z",
        recurrence: [line],
      }),
    ).toThrow(RecurrenceRuleError);
  });
});

describe("values carrying their own instant", () => {
  // A weekly Tuesday 09:00 series, its third meeting on 20 January 2026.
  const ending = (zone: string, start: string, until: string) => ({
    starts_at: start,
    timezone: zone,
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=${until}`],
  });

  it.each([
    // London is UTC in winter, so the third meeting is 09:00Z.
    [
      "Europe/London",
      "2026-01-06T09:00:00Z",
      "20260120T090000Z",
      "20260120T085959Z",
    ],
    // East of UTC: 09:00 in Tokyo is 00:00Z.
    [
      "Asia/Tokyo",
      "2026-01-06T00:00:00Z",
      "20260120T000000Z",
      "20260119T235959Z",
    ],
    // West of UTC: 09:00 in New York is 14:00Z.
    [
      "America/New_York",
      "2026-01-06T14:00:00Z",
      "20260120T140000Z",
      "20260120T135959Z",
    ],
  ])(
    "ends a series at a UTC UNTIL's instant in %s",
    (zone, start, until, before) => {
      const window = ["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"] as const;
      expect(starts(ending(zone, start, until), ...window)).toHaveLength(3);
      // A second earlier and the third meeting is past the end.
      expect(starts(ending(zone, start, before), ...window)).toHaveLength(2);
    },
  );

  it("ends a series at a floating UNTIL read in its own zone, and a date UNTIL at the end of that day", () => {
    expect(
      starts(
        ending("America/New_York", "2026-01-06T14:00:00Z", "20260120T090000"),
        "2026-01-01T00:00:00Z",
        "2026-03-01T00:00:00Z",
      ),
    ).toHaveLength(3);
    expect(
      starts(
        ending("America/New_York", "2026-01-06T14:00:00Z", "20260120"),
        "2026-01-01T00:00:00Z",
        "2026-03-01T00:00:00Z",
      ),
    ).toHaveLength(3);
  });

  const london = (lines: string[]) => ({
    starts_at: "2026-06-02T09:00:00+01:00",
    timezone: "Europe/London",
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3", ...lines],
  });
  const june = ["2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"] as const;

  it.each([
    ["in UTC", "EXDATE:20260609T080000Z"],
    ["in the series' zone", "EXDATE;TZID=Europe/London:20260609T090000"],
    ["in another zone", "EXDATE;TZID=America/New_York:20260609T040000"],
    ["floating, read in the series' zone", "EXDATE:20260609T090000"],
    ["as a whole day", "EXDATE;VALUE=DATE:20260609"],
  ])("removes the occurrence an EXDATE names %s", (_label, line) => {
    expect(starts(london([line]), ...june)).toEqual([
      "2026-06-02T08:00:00.000Z",
      "2026-06-16T08:00:00.000Z",
    ]);
  });

  it.each([
    ["in UTC", "RDATE:20260604T080000Z"],
    ["in another zone", "RDATE;TZID=Asia/Tokyo:20260604T170000"],
    ["floating, read in the series' zone", "RDATE:20260604T090000"],
  ])("adds an RDATE %s at its instant", (_label, line) => {
    expect(starts(london([line]), ...june)).toContain(
      "2026-06-04T08:00:00.000Z",
    );
  });
});

describe("a clock change", () => {
  it("keeps a daily reading the change skips, moved forward by the gap, in every zone", () => {
    // 01:30 does not exist in London on 29 March, nor 02:30 in New York on 8 March.
    expect(
      starts(
        {
          starts_at: "2026-03-28T01:30:00Z",
          timezone: "Europe/London",
          recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
        },
        "2026-03-27T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ),
    ).toEqual([
      "2026-03-28T01:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
    ]);
    expect(
      starts(
        {
          starts_at: "2026-03-07T07:30:00Z",
          timezone: "America/New_York",
          recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
        },
        "2026-03-06T00:00:00Z",
        "2026-03-11T00:00:00Z",
      ),
    ).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("takes the first of a repeated reading in every zone", () => {
    expect(
      starts(
        {
          starts_at: "2026-10-24T00:30:00Z",
          timezone: "Europe/London",
          recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
        },
        "2026-10-23T00:00:00Z",
        "2026-10-27T00:00:00Z",
      ),
    ).toEqual(["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z"]);
    expect(
      starts(
        {
          starts_at: "2026-10-31T05:30:00Z",
          timezone: "America/New_York",
          recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
        },
        "2026-10-30T00:00:00Z",
        "2026-11-03T00:00:00Z",
      ),
    ).toEqual(["2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z"]);
  });

  it("produces each instant of an hourly rule once across a skipped hour", () => {
    const out = starts(
      {
        starts_at: "2026-03-29T00:00:00Z",
        timezone: "Europe/London",
        recurrence: ["RRULE:FREQ=HOURLY;COUNT=4"],
      },
      "2026-03-28T00:00:00Z",
      "2026-03-30T00:00:00Z",
    );
    expect(new Set(out).size).toBe(out.length);
    expect(out[0]).toBe("2026-03-29T00:00:00.000Z");
  });
});

describe("a whole-day series", () => {
  const offsite = (
    over: Partial<RecurrenceSchedule> = {},
  ): RecurrenceSchedule => ({
    starts_at: "2026-03-23",
    ends_at: "2026-03-24",
    all_day: true,
    timezone: "Europe/Berlin",
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    ...over,
  });

  it("starts and ends each occurrence at local midnight across a clock change", () => {
    const compiled = compileSchedule(offsite());
    const out = occurrenceStarts(
      compiled,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-05-01T00:00:00Z"),
      new RecurrenceMeter(),
    );
    expect(out.map((ms) => new Date(ms).toISOString())).toEqual([
      "2026-03-22T23:00:00.000Z",
      "2026-03-29T22:00:00.000Z",
      "2026-04-05T22:00:00.000Z",
    ]);
    // The second occurrence begins the day the clocks change, and still
    // spans exactly that one day.
    expect(new Date(occurrenceEndMs(compiled, out[1]!)).toISOString()).toBe(
      "2026-03-30T22:00:00.000Z",
    );
  });

  it("reads an instant start as the day it falls on in the series' zone", () => {
    const compiled = compileSchedule(
      offsite({ starts_at: "2026-03-22T23:00:00Z", ends_at: undefined }),
    );
    expect(new Date(compiled.startMs).toISOString()).toBe(
      "2026-03-22T23:00:00.000Z",
    );
    expect(
      new Date(occurrenceEndMs(compiled, compiled.startMs)).toISOString(),
    ).toBe("2026-03-23T23:00:00.000Z");
  });

  it("refuses an hourly rule, which a whole day cannot follow", () => {
    expect(() =>
      compileSchedule(offsite({ recurrence: ["RRULE:FREQ=HOURLY"] })),
    ).toThrow(RecurrenceRuleError);
  });
});

describe("a whole-day event that does not repeat", () => {
  const iso = (span: { startMs: number; endMs: number }): string[] => [
    new Date(span.startMs).toISOString(),
    new Date(span.endMs).toISOString(),
  ];

  it("occupies the first occurrence of the series it would be", () => {
    for (const timezone of [
      "Europe/Berlin",
      "America/Los_Angeles",
      undefined,
    ]) {
      const day = {
        starts_at: "2026-03-29",
        ends_at: "2026-03-30",
        ...(timezone !== undefined ? { timezone } : {}),
      };
      const series = compileSchedule({
        ...day,
        all_day: true,
        recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
      });
      expect(iso(wholeDaySpan(day))).toEqual([
        new Date(series.startMs).toISOString(),
        new Date(occurrenceEndMs(series, series.startMs)).toISOString(),
      ]);
    }
  });

  it("runs from local midnight to local midnight across a clock change", () => {
    // 29 March 2026 is the 23-hour day Berlin's clocks go forward.
    expect(
      iso(wholeDaySpan({ starts_at: "2026-03-29", timezone: "Europe/Berlin" })),
    ).toEqual(["2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"]);
  });

  it("is a whole day when its end is the day it starts, and in UTC with no zone", () => {
    expect(
      iso(wholeDaySpan({ starts_at: "2026-03-29", ends_at: "2026-03-29" })),
    ).toEqual(["2026-03-29T00:00:00.000Z", "2026-03-30T00:00:00.000Z"]);
  });
});

describe("how long an occurrence lasts", () => {
  it("takes duration in seconds when the series has no end", () => {
    const compiled = compileSchedule({
      starts_at: "2026-03-03T09:00:00Z",
      duration: 5400,
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    expect(occurrenceEndMs(compiled, Date.parse("2026-03-04T09:00:00Z"))).toBe(
      Date.parse("2026-03-04T10:30:00Z"),
    );
  });

  it("includes an occurrence that started before the window and is still running", () => {
    expect(
      starts(
        {
          starts_at: "2026-03-02T22:00:00Z",
          ends_at: "2026-03-03T02:00:00Z",
          recurrence: ["RRULE:FREQ=DAILY"],
        },
        "2026-03-05T00:00:00Z",
        "2026-03-05T12:00:00Z",
      ),
    ).toEqual(["2026-03-04T22:00:00.000Z"]);
  });
});

// Rules that name no date that exists, which a step that is not metered can
// walk forever.
const NEVER = [
  "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
  "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30",
  "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
  "FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30",
  "FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30",
  "FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30",
  "FREQ=MONTHLY;BYMONTH=4,6;BYMONTHDAY=31",
  "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO",
  "FREQ=YEARLY;BYMONTH=1;BYYEARDAY=366",
  "FREQ=YEARLY;BYMONTH=6;BYWEEKNO=53",
  "FREQ=HOURLY;INTERVAL=24;BYHOUR=5",
  "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=5",
];

describe("a rule that never produces an occurrence", () => {
  it.each(NEVER)("is named as a problem, within the meter: %s", (rule) => {
    const meter = new RecurrenceMeter();
    const started = Date.now();
    const problem = scheduleProblem(
      compileSchedule({
        starts_at: "2026-01-15T09:00:00Z",
        recurrence: [`RRULE:${rule}`],
      }),
      meter,
    );
    expect(problem).toBeDefined();
    expect(meter.spent).toBeLessThanOrEqual(meter.limit + 1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each(NEVER)(
    "produces nothing past its start when unfolded: %s",
    (rule) => {
      expect(
        starts(
          { starts_at: "2026-01-15T09:00:00Z", recurrence: [`RRULE:${rule}`] },
          "2026-02-01T00:00:00Z",
          "2027-03-01T00:00:00Z",
        ),
      ).toEqual([]);
    },
  );

  it("says so plainly for a day of the month no month it names has", () => {
    expect(
      scheduleProblem(
        compileSchedule({
          starts_at: "2026-01-15T09:00:00Z",
          recurrence: ["RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30"],
        }),
      ),
    ).toMatch(/no month it names has a day it names/);
  });

  it("is not a problem when it ends by its own UNTIL", () => {
    expect(
      scheduleProblem(
        compileSchedule({
          starts_at: "2026-01-15T09:00:00Z",
          recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20260115T090000Z"],
        }),
      ),
    ).toBeUndefined();
  });

  it("is not a problem for an ordinary rule", () => {
    expect(
      scheduleProblem(
        compileSchedule({
          starts_at: "2028-02-29T09:00:00Z",
          recurrence: ["RRULE:FREQ=YEARLY"],
        }),
      ),
    ).toBeUndefined();
  });
});

describe("the meter", () => {
  it("stops a walk at its limit, inside the walk", () => {
    const meter = new RecurrenceMeter(500);
    expect(() =>
      starts(
        {
          starts_at: "2020-01-01T00:00:00Z",
          recurrence: ["RRULE:FREQ=MINUTELY"],
        },
        "2026-01-01T00:00:00Z",
        "2026-01-02T00:00:00Z",
        meter,
      ),
    ).toThrow(RecurrenceBoundError);
    expect(meter.spent).toBe(501);
  });

  it("stops a walk at its deadline", () => {
    let now = 0;
    const meter = new RecurrenceMeter(10_000_000, 50, () => (now += 1));
    expect(() =>
      starts(
        {
          starts_at: "2020-01-01T00:00:00Z",
          recurrence: ["RRULE:FREQ=MINUTELY"],
        },
        "2026-01-01T00:00:00Z",
        "2026-01-02T00:00:00Z",
        meter,
      ),
    ).toThrow(/too long/);
  });

  it("charges every time of day a yearly rule expands into", () => {
    // 366 days of 24 x 60 x 60 times is 31 million candidates in one year.
    const meter = new RecurrenceMeter(1_000);
    expect(() =>
      starts(
        {
          starts_at: "2026-01-01T00:00:00Z",
          recurrence: [
            `RRULE:FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;BYHOUR=${[...Array(24).keys()].join(",")};BYMINUTE=${[...Array(60).keys()].join(",")};BYSECOND=${[...Array(60).keys()].join(",")}`,
          ],
        },
        "2027-01-01T00:00:00Z",
        "2027-01-02T00:00:00Z",
        meter,
      ),
    ).toThrow(RecurrenceBoundError);
  });
});

describe("the schedule fields an event write is held to", () => {
  const event = (over: Record<string, unknown>) => ({
    title: "Standup",
    starts_at: "2026-01-15T09:00:00Z",
    ...over,
  });

  it.each(NEVER)(
    "refuses a rule that never repeats, naming recurrence: %s",
    (rule) => {
      const issues = eventScheduleIssues(
        event({ recurrence: [`RRULE:${rule}`] }),
      );
      expect(issues.map((i) => i.field)).toEqual(["recurrence"]);
    },
  );

  it("refuses an unreadable rule, a non-line entry and a rule with no start", () => {
    expect(
      eventScheduleIssues(event({ recurrence: ["RRULE:FREQ=NOPE"] }))[0]?.field,
    ).toBe("recurrence");
    expect(
      eventScheduleIssues(event({ recurrence: ["RRULE:FREQ=DAILY", 3] }))[0]
        ?.field,
    ).toBe("recurrence");
    expect(
      eventScheduleIssues({ title: "x", recurrence: ["RRULE:FREQ=DAILY"] })[0]
        ?.message,
    ).toMatch(/starts_at/);
  });

  it.each(["Europe/Berlim", "UTC+1", "+01:00", "", "Pacific Standard Time"])(
    "refuses %j as a zone",
    (zone) => {
      expect(
        eventScheduleIssues(event({ timezone: zone })).map((i) => i.field),
      ).toEqual(["timezone"]);
      expect(
        eventScheduleIssues(event({ end_timezone: zone })).map((i) => i.field),
      ).toEqual(["end_timezone"]);
    },
  );

  it("takes an ordinary series and the zones the database names", () => {
    for (const zone of ["Europe/Berlin", "UTC", "Etc/GMT+5", "Asia/Kolkata"]) {
      expect(
        eventScheduleIssues(
          event({ timezone: zone, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"] }),
        ),
      ).toEqual([]);
    }
    expect(eventScheduleIssues(event({ recurrence: [] }))).toEqual([]);
  });
});

describe("BYSETPOS over a series' first period", () => {
  it("counts positions over the whole period, not from the start date", () => {
    expect(
      starts(
        {
          starts_at: "2026-01-17T09:00:00Z",
          recurrence: [
            "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;COUNT=3",
          ],
        },
        "2026-01-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ).map((s) => s.slice(0, 10)),
    ).toEqual(["2026-01-17", "2026-02-02", "2026-03-02"]);
    expect(
      starts(
        {
          starts_at: "2026-01-10T09:00:00Z",
          recurrence: [
            "RRULE:FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1,2;BYSETPOS=2;COUNT=2",
          ],
        },
        "2026-01-01T00:00:00Z",
        "2028-01-01T00:00:00Z",
      ).map((s) => s.slice(0, 10)),
    ).toEqual(["2026-01-10", "2027-01-02"]);
  });
});

describe("what a rule's text can cost", () => {
  it("keeps one copy of each numbered weekday however often it is named", () => {
    const entries = Array.from(
      { length: 4_000 },
      (_, i) => `${String((i % 5) + 1)}MO`,
    );
    const [rule] = compileSchedule({
      starts_at: "2026-01-05T09:00:00Z",
      recurrence: [`RRULE:FREQ=MONTHLY;BYDAY=${entries.join(",")}`],
    }).rules;
    expect(rule?.bynweekday).toHaveLength(5);
  });

  it("refuses a line too long, and more added or removed dates than a series may carry", () => {
    const dates = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `2026${String((i % 12) + 1).padStart(2, "0")}01T090000Z`,
      ).join(",");
    expect(() =>
      compileSchedule({
        starts_at: "2026-01-05T09:00:00Z",
        recurrence: [`RDATE:${dates(1_001)}`],
      }),
    ).toThrow(RecurrenceRuleError);
    expect(() =>
      compileSchedule({
        starts_at: "2026-01-05T09:00:00Z",
        recurrence: [
          "RRULE:FREQ=DAILY",
          `EXDATE:${dates(600)}`,
          `EXDATE:${dates(600)}`,
        ],
      }),
    ).toThrow(RecurrenceRuleError);
    expect(() =>
      compileSchedule({
        starts_at: "2026-01-05T09:00:00Z",
        recurrence: [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${"1,".repeat(20_000)}1`],
      }),
    ).toThrow(RecurrenceRuleError);
    expect(
      compileSchedule({
        starts_at: "2026-01-05T09:00:00Z",
        recurrence: [`RDATE:${dates(1_000)}`],
      }).rdates,
    ).toHaveLength(1_000);
  });

  it("refuses a duration no instant can hold, as the rule's own failure", () => {
    for (const duration of [1e13, -60, Number.POSITIVE_INFINITY]) {
      expect(() =>
        compileSchedule({
          starts_at: "2026-01-05T09:00:00Z",
          duration,
          timezone: "Europe/Berlin",
          recurrence: ["RRULE:FREQ=DAILY"],
        }),
      ).toThrow(RecurrenceRuleError);
      expect(
        eventScheduleIssues({
          title: "x",
          starts_at: "2026-01-05T09:00:00Z",
          duration,
        }).map((i) => i.field),
      ).toEqual(["duration"]);
    }
  });
});

describe("how much rule a series may carry", () => {
  it("refuses a second RRULE, and a value over the total cap before reading it", () => {
    expect(() =>
      compileSchedule({
        starts_at: "2026-01-05T09:00:00Z",
        recurrence: ["RRULE:FREQ=DAILY", "RRULE:FREQ=WEEKLY"],
      }),
    ).toThrow(/one RRULE/);
    const many = Array.from(
      { length: 700 },
      () => `EXDATE:20260105T090000Z;${"X".repeat(100)}`,
    );
    expect(() =>
      compileSchedule({ starts_at: "2026-01-05T09:00:00Z", recurrence: many }),
    ).toThrow(/at most/);
  });
});
