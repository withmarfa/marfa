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
