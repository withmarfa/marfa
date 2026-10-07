import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  cleanup,
  getOperatorClient,
} from "../../utils/setup.js";
import { itemsArchive } from "../../utils/archive.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "recurrence"));
});

afterAll(async () => {
  await cleanup(ctx);
});

// Every fixture here sits in 2041 or later, past every other file's window,
// and every assertion is scoped to the rows this file wrote: the series pass
// reads every rule on the instance, so the window alone does not isolate it.

async function event(properties: Record<string, unknown>): Promise<string> {
  const r = await client.createItem({
    type: "core.event",
    source: ctx.source,
    properties: { title: `recurrence ${ctx.runId}`, ...properties },
  });
  expect(r.status, JSON.stringify(r.error)).toBe(201);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

interface Row {
  starts_at: string;
  ends_at?: string;
  series_id?: string;
  replaces?: string;
  item: { id: string };
}

async function window(from: string, to: string): Promise<Row[]> {
  const r = await client.listOccurrences({ from, to });
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return r.data.data as Row[];
}

async function startsOf(
  id: string,
  from: string,
  to: string,
): Promise<string[]> {
  return (await window(from, to))
    .filter((o) => o.item.id === id)
    .map((o) => o.starts_at);
}

function fields(details: Record<string, unknown> | undefined): string[] {
  const errors = (details?.errors ?? []) as { field: string }[];
  return errors.map((e) => e.field);
}

describe("a recurring series", () => {
  it("counts its own start as the first occurrence and carries its length to each", async () => {
    // A Thursday start under a Tuesday rule: the start, then the rule's days.
    const id = await event({
      starts_at: "2041-03-28T09:00:00.000Z",
      ends_at: "2041-03-28T09:45:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3"],
    });
    const rows = (
      await window("2041-03-27T00:00:00Z", "2041-04-30T00:00:00Z")
    ).filter((o) => o.item.id === id);
    expect(rows.map((o) => [o.starts_at, o.ends_at, o.series_id])).toEqual([
      ["2041-03-28T09:00:00.000Z", "2041-03-28T09:45:00.000Z", id],
      ["2041-04-02T09:00:00.000Z", "2041-04-02T09:45:00.000Z", id],
      ["2041-04-09T09:00:00.000Z", "2041-04-09T09:45:00.000Z", id],
    ]);
  });

  it("gives an occurrence no end when its series states neither an end nor a duration", async () => {
    const id = await event({
      starts_at: "2041-05-14T09:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    });
    const rows = (
      await window("2041-05-13T00:00:00Z", "2041-05-30T00:00:00Z")
    ).filter((o) => o.item.id === id);
    expect(rows.map((o) => o.starts_at)).toEqual([
      "2041-05-14T09:00:00.000Z",
      "2041-05-21T09:00:00.000Z",
    ]);
    expect(rows.map((o) => o.ends_at)).toEqual([undefined, undefined]);
  });

  it("takes its length from its end rather than its duration when it states both", async () => {
    const id = await event({
      starts_at: "2041-05-21T09:00:00.000Z",
      ends_at: "2041-05-21T09:30:00.000Z",
      duration: 7200,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    });
    const rows = (
      await window("2041-05-20T00:00:00Z", "2041-06-03T00:00:00Z")
    ).filter((o) => o.item.id === id);
    expect(rows.map((o) => o.ends_at)).toEqual([
      "2041-05-21T09:30:00.000Z",
      "2041-05-28T09:30:00.000Z",
    ]);
  });

  it("advances a series with no timezone in UTC across a clock change", async () => {
    // Berlin changes clocks on 31 March 2041; a series that names no zone
    // does not follow it, and the offset its start was written with is only
    // a spelling of the instant.
    const id = await event({
      starts_at: "2041-03-26T09:00:00+01:00",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    });
    expect(
      await startsOf(id, "2041-03-20T00:00:00Z", "2041-04-10T00:00:00Z"),
    ).toEqual(["2041-03-26T08:00:00.000Z", "2041-04-02T08:00:00.000Z"]);
  });

  it("keeps its local hour across a clock change in its zone", async () => {
    // 09:00 in Berlin on both sides of 31 March 2041.
    const id = await event({
      starts_at: "2041-03-26T09:00:00+01:00",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    });
    expect(
      await startsOf(id, "2041-03-20T00:00:00Z", "2041-04-10T00:00:00Z"),
    ).toEqual(["2041-03-26T08:00:00.000Z", "2041-04-02T07:00:00.000Z"]);
  });

  it("takes its length from duration when it states no end", async () => {
    const id = await event({
      starts_at: "2041-05-07T09:00:00.000Z",
      duration: 5400,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=1"],
    });
    const rows = (
      await window("2041-05-06T00:00:00Z", "2041-05-08T00:00:00Z")
    ).filter((o) => o.item.id === id);
    expect(rows.map((o) => o.ends_at)).toEqual(["2041-05-07T10:30:00.000Z"]);
  });
});

describe("a value carrying its own instant", () => {
  it.each([
    // East of UTC, the third meeting is the UNTIL's own instant.
    ["Europe/London", "2041-06-04T08:00:00.000Z", "20410618T080000Z", 3],
    ["Asia/Tokyo", "2041-06-04T00:00:00.000Z", "20410618T000000Z", 3],
    // West of UTC, a second before the third meeting ends it at two.
    ["America/New_York", "2041-06-04T13:00:00.000Z", "20410618T125959Z", 2],
  ])(
    "ends a series at a UTC UNTIL's instant in %s",
    async (zone, start, until, count) => {
      const id = await event({
        starts_at: start,
        timezone: zone,
        recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=${until}`],
      });
      expect(
        await startsOf(id, "2041-06-01T00:00:00Z", "2041-07-01T00:00:00Z"),
      ).toHaveLength(count);
    },
  );

  it("applies an EXDATE and an RDATE at their instants, in UTC or another zone", async () => {
    // Tuesdays at 09:00 in London; the 11th removed in UTC, the 18th removed
    // as New York reads it, and the 6th added as Tokyo reads it.
    const id = await event({
      starts_at: "2041-06-04T09:00:00+01:00",
      timezone: "Europe/London",
      recurrence: [
        "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3",
        "EXDATE:20410611T080000Z",
        "EXDATE;TZID=America/New_York:20410618T040000",
        "RDATE;TZID=Asia/Tokyo:20410606T170000",
      ],
    });
    expect(
      await startsOf(id, "2041-06-01T00:00:00Z", "2041-07-01T00:00:00Z"),
    ).toEqual(["2041-06-04T08:00:00.000Z", "2041-06-06T08:00:00.000Z"]);
  });
});

describe("a value carrying no zone of its own", () => {
  // Tuesdays at 09:00 in Berlin from 26 March 2041: 08:00Z before the clock
  // change of 31 March and 07:00Z after it.
  const berlin = {
    starts_at: "2041-03-26T09:00:00+01:00",
    timezone: "Europe/Berlin",
  };
  const rule = "RRULE:FREQ=WEEKLY;BYDAY=TU";

  it("reads an RDATE in UTC at the instant it names", async () => {
    const id = await event({
      ...berlin,
      recurrence: [`${rule};COUNT=2`, "RDATE:20410329T150000Z"],
    });
    expect(
      await startsOf(id, "2041-03-20T00:00:00Z", "2041-04-10T00:00:00Z"),
    ).toEqual([
      "2041-03-26T08:00:00.000Z",
      "2041-03-29T15:00:00.000Z",
      "2041-04-02T07:00:00.000Z",
    ]);
  });

  it("reads an EXDATE and an RDATE with no zone in the series' zone", async () => {
    // Read as UTC, 09:00 on 2 April would miss the occurrence at 07:00Z and
    // 15:00 on 3 April would land two hours late.
    const id = await event({
      ...berlin,
      recurrence: [
        `${rule};COUNT=3`,
        "EXDATE:20410402T090000",
        "RDATE:20410403T150000",
      ],
    });
    expect(
      await startsOf(id, "2041-03-20T00:00:00Z", "2041-04-20T00:00:00Z"),
    ).toEqual([
      "2041-03-26T08:00:00.000Z",
      "2041-04-03T13:00:00.000Z",
      "2041-04-09T07:00:00.000Z",
    ]);
  });

  it("ends a series at an UNTIL with no zone, read in the series' zone", async () => {
    const until = async (value: string) => {
      const id = await event({
        ...berlin,
        recurrence: [`${rule};UNTIL=${value}`],
      });
      return startsOf(id, "2041-03-20T00:00:00Z", "2041-04-20T00:00:00Z");
    };
    // The third meeting is 09:00 in Berlin on 9 April, 07:00Z. Read as UTC,
    // the second's UNTIL would still let it through.
    expect(await until("20410409T090000")).toHaveLength(3);
    expect(await until("20410409T085959")).toHaveLength(2);
  });

  it("removes the occurrence on the day a date-only EXDATE names, in the series' zone", async () => {
    // 08:00 in Tokyo is 23:00Z the day before, so the local 6 June is the
    // occurrence on 5 June in UTC.
    const id = await event({
      starts_at: "2041-06-04T08:00:00+09:00",
      timezone: "Asia/Tokyo",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=5", "EXDATE;VALUE=DATE:20410606"],
    });
    expect(
      await startsOf(id, "2041-06-01T00:00:00Z", "2041-06-20T00:00:00Z"),
    ).toEqual([
      "2041-06-03T23:00:00.000Z",
      "2041-06-04T23:00:00.000Z",
      "2041-06-06T23:00:00.000Z",
      "2041-06-07T23:00:00.000Z",
    ]);
  });

  it("adds the occurrence at the series' own time of day on the day a date-only RDATE names", async () => {
    const id = await event({
      starts_at: "2041-06-04T08:00:00+09:00",
      timezone: "Asia/Tokyo",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=2", "RDATE;VALUE=DATE:20410610"],
    });
    expect(
      await startsOf(id, "2041-06-01T00:00:00Z", "2041-06-20T00:00:00Z"),
    ).toEqual([
      "2041-06-03T23:00:00.000Z",
      "2041-06-04T23:00:00.000Z",
      "2041-06-09T23:00:00.000Z",
    ]);
  });
});

describe("a local time a clock change skips or repeats", () => {
  it.each([
    // 01:30 does not exist in London on 31 March 2041: read with the offset
    // before the gap, it is 02:30 BST.
    [
      "Europe/London",
      "2041-03-30T01:30:00.000Z",
      [
        "2041-03-30T01:30:00.000Z",
        "2041-03-31T01:30:00.000Z",
        "2041-04-01T00:30:00.000Z",
      ],
    ],
    // 02:30 does not exist in New York on 10 March 2041: 03:30 EDT.
    [
      "America/New_York",
      "2041-03-09T07:30:00.000Z",
      [
        "2041-03-09T07:30:00.000Z",
        "2041-03-10T07:30:00.000Z",
        "2041-03-11T06:30:00.000Z",
      ],
    ],
  ])(
    "moves a skipped time later by the gap in %s",
    async (zone, start, want) => {
      const id = await event({
        starts_at: start,
        timezone: zone,
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      });
      expect(
        await startsOf(id, "2041-03-01T00:00:00Z", "2041-04-10T00:00:00Z"),
      ).toEqual(want);
    },
  );

  it.each([
    // 01:30 happens twice in London on 27 October 2041; the first is BST.
    [
      "Europe/London",
      "2041-10-26T00:30:00.000Z",
      ["2041-10-26T00:30:00.000Z", "2041-10-27T00:30:00.000Z"],
    ],
    // 01:30 happens twice in New York on 3 November 2041; the first is EDT.
    [
      "America/New_York",
      "2041-11-02T05:30:00.000Z",
      ["2041-11-02T05:30:00.000Z", "2041-11-03T05:30:00.000Z"],
    ],
  ])("takes the first of a repeated time in %s", async (zone, start, want) => {
    const id = await event({
      starts_at: start,
      timezone: zone,
      recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
    });
    expect(
      await startsOf(id, "2041-10-20T00:00:00Z", "2041-11-10T00:00:00Z"),
    ).toEqual(want);
  });
});

describe("a whole-day series", () => {
  it("spans whole local days across a clock change", async () => {
    // Sundays in Berlin; the second is 31 March 2041, a 23-hour day.
    const id = await event({
      starts_at: "2041-03-24",
      ends_at: "2041-03-25",
      all_day: true,
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
    });
    const rows = (
      await window("2041-03-20T00:00:00Z", "2041-04-10T00:00:00Z")
    ).filter((o) => o.item.id === id);
    expect(rows.map((o) => [o.starts_at, o.ends_at])).toEqual([
      ["2041-03-23T23:00:00.000Z", "2041-03-24T23:00:00.000Z"],
      ["2041-03-30T23:00:00.000Z", "2041-03-31T22:00:00.000Z"],
    ]);
  });

  it("refuses a rule that repeats by hours, minutes or seconds, and takes one that repeats by days", async () => {
    const create = (extra: Record<string, unknown>, rule: string) =>
      client.createItem({
        type: "core.event",
        source: ctx.source,
        properties: {
          title: `whole-day rule ${ctx.runId}`,
          starts_at: "2041-03-24",
          timezone: "Europe/Berlin",
          recurrence: [rule],
          ...extra,
        },
      });
    for (const rule of [
      "RRULE:FREQ=HOURLY;COUNT=3",
      "RRULE:FREQ=MINUTELY;COUNT=3",
      "RRULE:FREQ=SECONDLY;COUNT=3",
      "RRULE:FREQ=DAILY;BYHOUR=9;COUNT=3",
      "RRULE:FREQ=DAILY;BYMINUTE=30;COUNT=3",
      "RRULE:FREQ=DAILY;BYSECOND=15;COUNT=3",
    ]) {
      // The witness for each: the same rule on an event that is not whole-day
      // is taken, so the whole-day flag is what the refusal is for.
      const timed = await create({ all_day: false }, rule);
      expect(timed.status, `${rule}: ${JSON.stringify(timed.error)}`).toBe(201);
      trackItem(ctx, timed.data.item.id);

      const refused = await create({ all_day: true }, rule);
      expect(refused.status, rule).toBe(400);
      expect(refused.error?.error.code, rule).toBe("invalid_properties");
      expect(fields(refused.error?.error.details), rule).toEqual([
        "recurrence",
      ]);
    }
    const daily = await create({ all_day: true }, "RRULE:FREQ=DAILY;COUNT=3");
    expect(daily.status, JSON.stringify(daily.error)).toBe(201);
    trackItem(ctx, daily.data.item.id);
  });
});

describe("a whole-day event, single or repeating", () => {
  // Berlin is an hour east of UTC in January, so 15 January there runs from
  // 23:00Z on the 14th to 23:00Z on the 15th.
  const day = { all_day: true, starts_at: "2046-01-15" };
  const berlin = { ...day, timezone: "Europe/Berlin" };
  const repeating = { recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"] };

  async function span(
    id: string,
    from: string,
    to: string,
  ): Promise<string[][]> {
    return (await window(from, to))
      .filter((o) => o.item.id === id)
      .slice(0, 1)
      .map((o) => [o.starts_at, o.ends_at ?? ""]);
  }

  it("places a whole-day event by its zone's midnights, single or repeating", async () => {
    const single = await event(berlin);
    const series = await event({ ...berlin, ...repeating });
    const midnights = [
      ["2046-01-14T23:00:00.000Z", "2046-01-15T23:00:00.000Z"],
    ];
    for (const id of [single, series]) {
      expect(
        await span(id, "2046-01-14T12:00:00Z", "2046-01-17T00:00:00Z"),
      ).toEqual(midnights);
      // Both windows touch the day only at the zone's midnights: a UTC-midnight
      // reading leaves the event out of the first and puts it in the second.
      expect(
        await span(id, "2046-01-14T22:30:00Z", "2046-01-14T23:30:00Z"),
      ).toEqual(midnights);
      expect(
        await span(id, "2046-01-15T23:00:00Z", "2046-01-16T00:30:00Z"),
      ).toEqual([]);
    }
  });

  it("places a whole-day event in UTC when it names no zone", async () => {
    const single = await event(day);
    const series = await event({ ...day, ...repeating });
    for (const id of [single, series]) {
      expect(
        await span(id, "2046-01-14T12:00:00Z", "2046-01-17T00:00:00Z"),
      ).toEqual([["2046-01-15T00:00:00.000Z", "2046-01-16T00:00:00.000Z"]]);
    }
  });

  async function bothPlaced(
    properties: Record<string, unknown>,
  ): Promise<string[][][]> {
    const single = await event(properties);
    const series = await event({ ...properties, ...repeating });
    const out: string[][][] = [];
    for (const id of [single, series]) {
      out.push(await span(id, "2046-02-01T00:00:00Z", "2046-04-30T00:00:00Z"));
    }
    return out;
  }

  it("places a whole-day event named by an instant on the day it falls on in its zone", async () => {
    // Each instant is a different calendar day in its zone than in UTC, so a
    // reading by the UTC day or by the offset it was written with places the
    // day elsewhere.
    for (const [zone, startsAt, from, to] of [
      [
        "America/New_York",
        "2046-02-11T02:00:00.000Z",
        "2046-02-10T05:00:00.000Z",
        "2046-02-11T05:00:00.000Z",
      ],
      [
        "Asia/Tokyo",
        "2046-02-10T20:00:00.000Z",
        "2046-02-10T15:00:00.000Z",
        "2046-02-11T15:00:00.000Z",
      ],
      [
        undefined,
        "2046-02-11T01:30:00+02:00",
        "2046-02-10T00:00:00.000Z",
        "2046-02-11T00:00:00.000Z",
      ],
    ] as const) {
      const placed = await bothPlaced({
        all_day: true,
        starts_at: startsAt,
        ...(zone === undefined ? {} : { timezone: zone }),
      });
      expect(placed, `${String(zone)}`).toEqual([[[from, to]], [[from, to]]]);
    }
  });

  it("ends a whole-day event at midnight of the day its end names", async () => {
    // The end is a bare date or an instant that falls on that day in Berlin.
    const midnights = [
      ["2046-03-09T23:00:00.000Z", "2046-03-11T23:00:00.000Z"],
    ];
    for (const endsAt of ["2046-03-12", "2046-03-12T10:00:00+01:00"]) {
      expect(
        await bothPlaced({
          all_day: true,
          starts_at: "2046-03-10",
          ends_at: endsAt,
          timezone: "Europe/Berlin",
        }),
        endsAt,
      ).toEqual([midnights, midnights]);
    }
  });

  it("covers the days a whole-day event's duration reaches, rounded up, when it states no end", async () => {
    for (const [duration, days] of [
      [172_800, 2],
      [172_801, 3],
      [90_000, 2],
    ] as const) {
      const first = "2046-03-09T23:00:00.000Z";
      const end = new Date(Date.parse(first) + days * 86_400_000).toISOString();
      expect(
        await bothPlaced({
          all_day: true,
          starts_at: "2046-03-10",
          duration,
          timezone: "Europe/Berlin",
        }),
        String(duration),
      ).toEqual([[[first, end]], [[first, end]]]);
    }
  });

  it("places a whole-day event as one day long when its end names its start day or an earlier one", async () => {
    const oneDay = [["2046-04-09T22:00:00.000Z", "2046-04-10T22:00:00.000Z"]];
    for (const endsAt of ["2046-04-10", "2046-04-08"]) {
      expect(
        await bothPlaced({
          all_day: true,
          starts_at: "2046-04-10",
          ends_at: endsAt,
          timezone: "Europe/Berlin",
        }),
        endsAt,
      ).toEqual([oneDay, oneDay]);
    }
    // The witness: an end one day later is what makes it two, so the day
    // above is not the only length a whole-day event is given.
    const [single] = await bothPlaced({
      all_day: true,
      starts_at: "2046-04-10",
      ends_at: "2046-04-12",
      timezone: "Europe/Berlin",
    });
    expect(single).toEqual([
      ["2046-04-09T22:00:00.000Z", "2046-04-11T22:00:00.000Z"],
    ]);
  });

  it("places a whole-day event as one day long when its duration is under a day", async () => {
    const oneDay = [["2046-04-09T22:00:00.000Z", "2046-04-10T22:00:00.000Z"]];
    for (const duration of [0, 3_600, 86_399]) {
      expect(
        await bothPlaced({
          all_day: true,
          starts_at: "2046-04-10",
          duration,
          timezone: "Europe/Berlin",
        }),
        String(duration),
      ).toEqual([oneDay, oneDay]);
    }
  });

  it("places a moved whole-day occurrence by its own days, in a window holding its slot and in one that does not", async () => {
    // Mondays in Berlin; the second is moved to the Sunday week after.
    const series = await event({
      all_day: true,
      starts_at: "2046-05-07",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    });
    const moved = await event({
      all_day: true,
      starts_at: "2046-05-20",
      timezone: "Europe/Berlin",
      original_starts_at: "2046-05-13T22:00:00.000Z",
    });
    const edge = await client.createEdge({
      source_id: series,
      target_id: moved,
      edge_type: "parent-of",
    });
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    const ownDays = [["2046-05-19T22:00:00.000Z", "2046-05-20T22:00:00.000Z"]];

    const both = await window("2046-05-05T00:00:00Z", "2046-05-25T00:00:00Z");
    expect(
      both
        .filter((o) => o.item.id === moved)
        .map((o) => [o.starts_at, o.ends_at]),
    ).toEqual(ownDays);
    // The slot it left is not shown beside it.
    expect(
      both.filter((o) => o.item.id === series).map((o) => o.starts_at),
    ).toEqual(["2046-05-06T22:00:00.000Z", "2046-05-20T22:00:00.000Z"]);

    const alone = await window("2046-05-19T23:00:00Z", "2046-05-20T01:00:00Z");
    expect(
      alone
        .filter((o) => o.item.id === moved)
        .map((o) => [o.starts_at, o.ends_at]),
    ).toEqual(ownDays);
  });
});

describe("the window", () => {
  it("includes every event that overlaps it, and no event that ends as it opens", async () => {
    const running = await event({
      starts_at: "2041-07-01T22:00:00.000Z",
      ends_at: "2041-07-02T02:00:00.000Z",
    });
    const lasting = await event({
      starts_at: "2041-07-02T11:00:00.000Z",
      ends_at: "2041-07-03T02:00:00.000Z",
    });
    const ended = await event({
      starts_at: "2041-07-01T22:00:00.000Z",
      ends_at: "2041-07-02T00:00:00.000Z",
    });
    const shift = await event({
      starts_at: "2041-06-28T22:00:00.000Z",
      ends_at: "2041-06-29T06:00:00.000Z",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
    });
    const rows = await window("2041-07-02T00:00:00Z", "2041-07-02T12:00:00Z");
    const ids = rows.map((o) => o.item.id);
    expect(ids).toContain(running);
    expect(ids).toContain(lasting);
    expect(ids).not.toContain(ended);
    expect(
      rows.filter((o) => o.series_id === shift).map((o) => o.starts_at),
    ).toEqual(["2041-07-01T22:00:00.000Z"]);
  });

  it("shows a moved occurrence only in the window its own times overlap", async () => {
    const series = await event({
      starts_at: "2042-08-04T10:00:00.000Z",
      ends_at: "2042-08-04T11:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    });
    const moved = await event({
      starts_at: "2042-08-27T10:00:00.000Z",
      ends_at: "2042-08-27T11:00:00.000Z",
      original_starts_at: "2042-08-11T10:00:00.000Z",
    });
    const edge = await client.createEdge({
      source_id: series,
      target_id: moved,
      edge_type: "parent-of",
    });
    expect(edge.status).toBe(201);

    const august = await window("2042-08-01T00:00:00Z", "2042-08-15T00:00:00Z");
    expect(
      august.filter((o) => o.series_id === series).map((o) => o.starts_at),
    ).toEqual(["2042-08-04T10:00:00.000Z"]);
    expect(august.some((o) => o.item.id === moved)).toBe(false);

    const later = await window("2042-08-15T00:00:00Z", "2042-09-01T00:00:00Z");
    expect(
      later.filter((o) => o.item.id === moved).map((o) => o.starts_at),
    ).toEqual(["2042-08-27T10:00:00.000Z"]);
  });

  it("includes an event with no length where it starts, from inclusive and to exclusive", async () => {
    const point = await event({ starts_at: "2041-08-12T10:00:00.000Z" });
    const ids = async (from: string, to: string) =>
      (await window(from, to)).map((o) => o.item.id);
    // The witness: a window one millisecond past the start holds it.
    expect(
      await ids("2041-08-12T09:00:00.000Z", "2041-08-12T10:00:00.001Z"),
    ).toContain(point);
    expect(
      await ids("2041-08-12T10:00:00.000Z", "2041-08-12T11:00:00.000Z"),
    ).toContain(point);
    expect(
      await ids("2041-08-12T09:00:00.000Z", "2041-08-12T10:00:00.000Z"),
    ).not.toContain(point);
  });

  it("ends an event that states no end at its start plus its duration", async () => {
    const hour = await event({
      starts_at: "2041-08-13T10:00:00.000Z",
      duration: 3600,
    });
    const ids = async (from: string, to: string) =>
      (await window(from, to)).map((o) => o.item.id);
    expect(
      await ids("2041-08-13T10:59:59.000Z", "2041-08-13T12:00:00.000Z"),
    ).toContain(hour);
    expect(
      await ids("2041-08-13T11:00:00.000Z", "2041-08-13T12:00:00.000Z"),
    ).not.toContain(hour);
  });

  it("carries series_id and replaces on a moved occurrence in a window that holds only its new time", async () => {
    const series = await event({
      starts_at: "2047-03-04T10:00:00.000Z",
      ends_at: "2047-03-04T11:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    });
    const moved = await event({
      starts_at: "2047-05-14T10:00:00.000Z",
      ends_at: "2047-05-14T11:00:00.000Z",
      original_starts_at: "2047-03-11T10:00:00.000Z",
    });
    const edge = await client.createEdge({
      source_id: series,
      target_id: moved,
      edge_type: "parent-of",
    });
    expect(edge.status).toBe(201);

    // The witness: the series is live, and a window holding the slot it
    // left shows nothing there.
    const first = await window("2047-03-04T00:00:00Z", "2047-03-05T00:00:00Z");
    expect(first.filter((o) => o.series_id === series)).toHaveLength(1);
    const slot = await window("2047-03-11T00:00:00Z", "2047-03-12T00:00:00Z");
    expect(slot.filter((o) => o.series_id === series)).toEqual([]);

    // The window holds the new time and no slot of the series.
    const rows = await window("2047-05-13T00:00:00Z", "2047-05-15T00:00:00Z");
    expect(rows.filter((o) => o.series_id === series)).toHaveLength(1);
    const shown = rows.filter((o) => o.item.id === moved);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.starts_at).toBe("2047-05-14T10:00:00.000Z");
    expect(shown[0]?.series_id).toBe(series);
    expect(shown[0]?.replaces).toBe("2047-03-11T10:00:00.000Z");
  });

  it("carries series_id and replaces on a moved occurrence in a window that holds both times", async () => {
    const series = await event({
      starts_at: "2048-08-03T10:00:00.000Z",
      ends_at: "2048-08-03T11:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
    });
    const moved = await event({
      starts_at: "2048-08-12T10:00:00.000Z",
      ends_at: "2048-08-12T11:00:00.000Z",
      original_starts_at: "2048-08-10T10:00:00.000Z",
    });
    const edge = await client.createEdge({
      source_id: series,
      target_id: moved,
      edge_type: "parent-of",
    });
    expect(edge.status).toBe(201);

    const rows = await window("2048-08-01T00:00:00Z", "2048-08-25T00:00:00Z");
    const shown = rows.filter((o) => o.item.id === moved);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.starts_at).toBe("2048-08-12T10:00:00.000Z");
    expect(shown[0]?.series_id).toBe(series);
    expect(shown[0]?.replaces).toBe("2048-08-10T10:00:00.000Z");
    // The slot it left shows nothing, and the series still shows its others.
    expect(
      rows
        .filter((o) => o.series_id === series && o.item.id === series)
        .map((o) => o.starts_at),
    ).toEqual([
      "2048-08-03T10:00:00.000Z",
      "2048-08-17T10:00:00.000Z",
      "2048-08-24T10:00:00.000Z",
    ]);
  });

  it("refuses a window longer than 400 days, and one holding more than 5000 occurrences", async () => {
    const long = await client.listOccurrences({
      from: "2043-01-01T00:00:00Z",
      to: "2044-02-06T00:00:00Z",
    });
    expect(long.status).toBe(400);
    expect(long.error?.error.code).toBe("validation_error");
    expect(long.error?.error.details?.max_days).toBe(400);

    // Three series of 1,800 a minute each: under the per-series ceiling and
    // over the window's.
    for (const hour of ["00", "01", "02"]) {
      await event({
        starts_at: `2046-01-01T${hour}:00:00.000Z`,
        recurrence: ["RRULE:FREQ=MINUTELY;COUNT=1800"],
      });
    }
    const full = await client.listOccurrences({
      from: "2046-01-01T00:00:00Z",
      to: "2046-01-03T00:00:00Z",
    });
    expect(full.status).toBe(400);
    expect(full.error?.error.code).toBe("validation_error");
    expect(full.error?.error.details?.max_occurrences).toBe(5000);
  });

  it("takes a window of exactly 400 days and refuses one a millisecond longer", async () => {
    const from = Date.parse("2060-01-01T00:00:00.000Z");
    const to = (days: number, extraMs = 0) =>
      new Date(from + days * 86_400_000 + extraMs).toISOString();
    const taken = await client.listOccurrences({
      from: new Date(from).toISOString(),
      to: to(400),
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);

    const refused = await client.listOccurrences({
      from: new Date(from).toISOString(),
      to: to(400, 1),
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.max_days).toBe(400);
  });

  it("takes a window holding exactly 5000 occurrences and refuses one holding 5001", async () => {
    // Under the ceiling a single series has, and in a year no other fixture
    // writes to.
    for (const [hour, count] of [
      ["00", 1800],
      ["01", 1800],
      ["02", 1400],
    ] as const) {
      await event({
        starts_at: `2047-03-01T${hour}:00:00.000Z`,
        recurrence: [`RRULE:FREQ=MINUTELY;COUNT=${String(count)}`],
      });
    }
    const query = {
      from: "2047-03-01T00:00:00Z",
      to: "2047-03-03T00:00:00Z",
    };
    const taken = await client.listOccurrences(query);
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
    expect(taken.data.data).toHaveLength(5000);

    await event({ starts_at: "2047-03-02T12:00:00.000Z" });
    const refused = await client.listOccurrences(query);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.max_occurrences).toBe(5000);
  });
});

/** One more added date than a series may carry. */
const TOO_MANY_DATES =
  "RDATE:" + Array.from({ length: 1_001 }, () => "20410201T090000Z").join(",");

describe("what a write may store", () => {
  it.each([
    [
      "a rule that names no date that exists",
      { recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"] },
      "recurrence",
    ],
    [
      "a rule that names no date that exists, by the day",
      { recurrence: ["RRULE:FREQ=DAILY;BYMONTH=4;BYMONTHDAY=31"] },
      "recurrence",
    ],
    [
      "a rule no read can unfold",
      { recurrence: ["RRULE:FREQ=HOURLY;INTERVAL=24;BYHOUR=5"] },
      "recurrence",
    ],
    [
      "a rule that cannot be read",
      { recurrence: ["RRULE:INTERVAL=2"] },
      "recurrence",
    ],
    [
      "an EXRULE",
      { recurrence: ["RRULE:FREQ=DAILY;COUNT=3", "EXRULE:FREQ=WEEKLY"] },
      "recurrence",
    ],
    [
      "an RDATE period",
      {
        recurrence: ["RDATE;VALUE=PERIOD:20410201T090000Z/PT1H"],
      },
      "recurrence",
    ],
    [
      "COUNT and UNTIL together",
      { recurrence: ["RRULE:FREQ=DAILY;COUNT=3;UNTIL=20410301T000000Z"] },
      "recurrence",
    ],
    [
      "an unknown rule part",
      { recurrence: ["RRULE:FREQ=DAILY;BYFORTNIGHT=2"] },
      "recurrence",
    ],
    [
      "a numbered weekday on a weekly rule",
      { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=2TU"] },
      "recurrence",
    ],
    [
      "a day of the month on a weekly rule",
      { recurrence: ["RRULE:FREQ=WEEKLY;BYMONTHDAY=15"] },
      "recurrence",
    ],
    [
      "a day of the year on a daily rule",
      { recurrence: ["RRULE:FREQ=DAILY;BYYEARDAY=100"] },
      "recurrence",
    ],
    [
      "a week of the year on a monthly rule",
      { recurrence: ["RRULE:FREQ=MONTHLY;BYWEEKNO=10"] },
      "recurrence",
    ],
    [
      "a rule that counts more than one occurrence and names no date that exists",
      {
        recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=2"],
      },
      "recurrence",
    ],
    ["a duration below zero", { duration: -1 }, "duration"],
    [
      "a rule with no start to unfold from",
      {
        starts_at: undefined,
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      },
      "recurrence",
    ],
    ["a length no instant can hold", { duration: 1e13 }, "duration"],
    [
      "a second RRULE",
      { recurrence: ["RRULE:FREQ=DAILY", "RRULE:FREQ=WEEKLY"] },
      "recurrence",
    ],
    [
      "more added dates than a series may carry",
      {
        recurrence: [TOO_MANY_DATES],
      },
      "recurrence",
    ],
    [
      "a zone the zone database does not resolve",
      { timezone: "Europe/Berlim" },
      "timezone",
    ],
    [
      "an end zone the zone database does not resolve",
      { end_timezone: "UTC+1" },
      "end_timezone",
    ],
  ])("refuses %s, naming the field", async (_label, bad, field) => {
    const r = await client.createItem({
      type: "core.event",
      source: ctx.source,
      properties: {
        title: `refused ${ctx.runId}`,
        starts_at: "2041-01-15T09:00:00.000Z",
        ...bad,
      },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    expect(fields(r.error?.error.details)).toEqual([field]);
  });

  it("refuses the same rule added by an update or a bulk write, and stores none of it", async () => {
    const id = await event({ starts_at: "2041-01-15T09:00:00.000Z" });
    const read = await client.getItem(id);
    const patch = await client.updateItem(id, {
      version: read.data.item.version,
      properties: {
        recurrence: ["RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30"],
      },
    });
    expect(patch.status).toBe(400);
    expect(patch.error?.error.code).toBe("invalid_properties");
    expect(fields(patch.error?.error.details)).toEqual(["recurrence"]);

    const bulk = await client.bulkItems({
      atomic: false,
      items: [
        {
          type: "core.event",
          source: ctx.source,
          properties: {
            title: `refused in bulk ${ctx.runId}`,
            starts_at: "2041-01-15T09:00:00.000Z",
            recurrence: ["RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30"],
          },
        },
      ],
    });
    expect(bulk.status).toBe(200);
    const entry = (
      bulk.data as unknown as {
        results: { outcome: string; error?: { code: string } }[];
      }
    ).results[0];
    expect(entry?.outcome).toBe("errored");
    expect(entry?.error?.code).toBe("invalid_properties");
    expect(
      (await client.getItem(id)).data.item.properties.recurrence,
    ).toBeUndefined();
  });

  it("refuses it on a bulk-action patch per row, and in a restored archive", async () => {
    const tag = `recurrence-${ctx.runId}`;
    const r = await client.createItem({
      type: "core.event",
      source: ctx.source,
      properties: {
        title: `patched ${ctx.runId}`,
        starts_at: "2041-01-15T09:00:00.000Z",
      },
      tags: [tag],
    });
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    const queued = await client.bulkAction({
      action: "update_properties",
      patch: { recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"] },
      filter: { tags: [tag] },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await client.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.result?.succeeded).toBe(0);
    expect(job.result?.errors?.[0]?.code).toBe("invalid_properties");
    expect(
      (await client.getItem(r.data.item.id)).data.item.properties.recurrence,
    ).toBeUndefined();

    const archivedId = uuidv7();
    const archived = (recurrence: string[]) =>
      itemsArchive([
        {
          id: archivedId,
          type: "core.event",
          source: ctx.source,
          properties: {
            title: `archived ${ctx.runId}`,
            starts_at: "2041-01-15T09:00:00.000Z",
            recurrence,
          },
        },
      ]);
    const operator = getOperatorClient();
    const refused = await operator.restoreArchive(
      archived(["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"]),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(fields(refused.error?.error.details)).toEqual(["recurrence"]);
    // The witness: the same archive with an ordinary rule restores.
    const taken = await operator.restoreArchive(
      archived(["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28"]),
    );
    expect(taken.status, JSON.stringify(taken.error)).toBe(200);
    trackItem(ctx, archivedId);
  });

  it("takes the nearest rule each of those refusals turns away", async () => {
    // One step inside each refusal above: the same rule with the one part
    // that was refused changed or removed.
    for (const recurrence of [
      ["RRULE:FREQ=DAILY;COUNT=3"],
      ["RRULE:FREQ=DAILY;UNTIL=20410301T000000Z"],
      ["RRULE:FREQ=DAILY;COUNT=3", "RDATE:20410201T090000Z"],
      ["RRULE:FREQ=MONTHLY;BYDAY=2TU"],
      ["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"],
      ["RRULE:FREQ=YEARLY;BYYEARDAY=100"],
      ["RRULE:FREQ=YEARLY;BYWEEKNO=10"],
      ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;COUNT=1"],
    ]) {
      await event({ starts_at: "2041-01-15T09:00:00.000Z", recurrence });
    }
    await event({ starts_at: "2041-01-15T09:00:00.000Z", duration: 0 });
  });

  it("refuses a recurrence over 40,000 characters in all and takes one of exactly 40,000", async () => {
    // Blank padding is read as nothing, so the characters counted are the
    // only thing that differs. The count is of every line together.
    const lines = (padding: number) => [
      " ".repeat(padding) + "RRULE:FREQ=DAILY;COUNT=2",
      " ".repeat(20_000) + "EXDATE:20410201T090000Z",
    ];
    const exact = 40_000 - ("RRULE:FREQ=DAILY;COUNT=2".length + 20_000 + 23);
    expect(lines(exact).join("")).toHaveLength(40_000);
    await event({
      starts_at: "2041-01-15T09:00:00.000Z",
      recurrence: lines(exact),
    });

    const refused = await client.createItem({
      type: "core.event",
      source: ctx.source,
      properties: {
        title: `refused ${ctx.runId}`,
        starts_at: "2041-01-15T09:00:00.000Z",
        recurrence: lines(exact + 1),
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(fields(refused.error?.error.details)).toEqual(["recurrence"]);
  });

  it("takes an ordinary series, a fixed-offset zone and a leap day", async () => {
    await event({
      starts_at: "2044-02-29T09:00:00.000Z",
      timezone: "Etc/GMT+5",
      recurrence: ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"],
    });
  });
});

describe("a rule too costly to unfold", () => {
  it("is stopped inside its walk and named, and the rest of the window answers", async () => {
    // Writable, because it repeats at once; its age is what makes it too
    // costly to walk to a window decades later. Removed at once, so the
    // other files' reads in the run do not walk it too.
    const costly = await event({
      starts_at: "1990-01-15T09:00:00.000Z",
      recurrence: ["RRULE:FREQ=SECONDLY"],
    });
    const meeting = await event({ starts_at: "2041-09-02T09:00:00.000Z" });
    try {
      const r = await client.listOccurrences({
        from: "2041-09-01T00:00:00Z",
        to: "2041-09-08T00:00:00Z",
      });
      expect(r.status).toBe(200);
      const ids = r.data.data.map((o) => o.item.id);
      expect(ids).toContain(meeting);
      expect(ids).not.toContain(costly);
      const named = (
        r.data as unknown as { series_errors?: { item_id: string }[] }
      ).series_errors?.filter((e) => e.item_id === costly);
      expect(named).toHaveLength(1);
      const partial = r.data as unknown as {
        expansion_incomplete?: boolean;
        scan: { series_unexpanded: number };
      };
      expect(partial.expansion_incomplete).toBe(true);
      expect(partial.scan.series_unexpanded).toBeGreaterThanOrEqual(1);
    } finally {
      await client.deleteItem(costly);
    }
  });
});
