/**
 * The expansion is the part of recurring events that has to be right in
 * the ways calendars are traditionally wrong: the daylight-saving
 * boundary, the exception that shadows an occurrence, and the rule that
 * would run forever.
 */
import { describe, it, expect } from "vitest";
import {
  expandSeries,
  MAX_OCCURRENCES_PER_SERIES,
  RecurrenceExpansionError,
} from "./expand-recurrence.js";
import type { RecurrenceSeries } from "./expand-recurrence.js";

const weekly = (over: Partial<RecurrenceSeries> = {}): RecurrenceSeries => ({
  id: "series-1",
  starts_at: "2026-03-03T09:00:00.000Z",
  ends_at: "2026-03-03T10:00:00.000Z",
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

  it("computes the occurrences that start inside the window", () => {
    const out = expandSeries(
      weekly(),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at.slice(0, 10))).toEqual([
      "2026-03-03",
      "2026-03-10",
      "2026-03-17",
      "2026-03-24",
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
    // Europe/Berlin moves to summer time on 29 March 2026. A 09:00 local
    // meeting stays 09:00 local, which is a different UTC hour either
    // side — expanding in UTC would silently move it.
    const out = expandSeries(
      weekly({ starts_at: "2026-03-24T09:00:00.000Z" }),
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

  it("treats a series with no zone as already an instant", () => {
    const out = expandSeries(
      weekly({ timezone: undefined }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-12T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at)).toEqual([
      "2026-03-03T09:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
    ]);
  });

  it("honours EXDATE, so a removed occurrence is simply absent", () => {
    const out = expandSeries(
      weekly({
        timezone: undefined,
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

  it("honours RDATE, so an added occurrence appears off-rule", () => {
    const out = expandSeries(
      weekly({
        timezone: undefined,
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU", "RDATE:20260305T090000"],
      }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-12T00:00:00Z"),
    );
    expect(out.map((o) => o.starts_at.slice(0, 10))).toEqual([
      "2026-03-03",
      "2026-03-05",
      "2026-03-10",
    ]);
  });

  it("stops at COUNT rather than running to the window edge", () => {
    const out = expandSeries(
      weekly({
        timezone: undefined,
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2"],
      }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(out).toHaveLength(2);
  });

  it("lets an exception shadow the occurrence it replaces", () => {
    const out = expandSeries(
      weekly({ timezone: undefined }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-25T00:00:00Z"),
      [{ id: "moved-1", original_starts_at: "2026-03-10T09:00:00.000Z" }],
    );
    const shadowed = out.find((o) => o.replaces !== undefined);
    expect(shadowed?.item_id).toBe("moved-1");
    expect(shadowed?.replaces).toBe("2026-03-10T09:00:00.000Z");
    // Exactly one entry for that slot: the replacement, not both.
    expect(
      out.filter((o) => o.starts_at === "2026-03-10T09:00:00.000Z"),
    ).toHaveLength(1);
  });

  it("ignores an exception that names an occurrence outside the window", () => {
    const out = expandSeries(
      weekly({ timezone: undefined }),
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-09T00:00:00Z"),
      [{ id: "moved-1", original_starts_at: "2026-03-17T09:00:00.000Z" }],
    );
    expect(out.every((o) => o.replaces === undefined)).toBe(true);
  });

  it("refuses a window a rule would flood, rather than truncating it", () => {
    expect(() =>
      expandSeries(
        weekly({
          timezone: undefined,
          recurrence: ["RRULE:FREQ=MINUTELY"],
        }),
        new Date("2026-03-03T09:00:00Z"),
        new Date("2026-03-31T00:00:00Z"),
      ),
    ).toThrow(RecurrenceExpansionError);
    expect(MAX_OCCURRENCES_PER_SERIES).toBeGreaterThan(400);
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
});
