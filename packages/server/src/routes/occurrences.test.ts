/**
 * The window read. The expansion itself is covered in
 * `events/expand-recurrence.test.ts`; this covers what the route adds:
 * assembling single events and series into one ordered answer, letting a
 * stored exception stand in for the occurrence it replaces at its own
 * times, and refusing an unbounded ask instead of trimming it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { MAX_WINDOW_DAYS } from "./occurrences.js";

let ctx: TestContext;
let memberKey: string;

interface OccurrenceRow {
  starts_at: string;
  ends_at?: string;
  item: { id: string; properties: Record<string, unknown> };
  series_id?: string;
  replaces?: string;
}

interface SeriesError {
  item_id: string;
  message: string;
}

beforeAll(async () => {
  ctx = await createTestContext();
  // A space credential, not the operator key: reading your own calendar is
  // the ordinary case, and it exercises the type filter rather than bypassing
  // it.
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.spaceKey,
    body: {
      label: "occurrences-member",
      source: "occurrences-src",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    },
  });
  ({ key: memberKey } = (await res.json()) as { key: string });
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createEvent(
  properties: Record<string, unknown>,
  edges?: Record<string, string[]>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: memberKey,
    body: { type: "core.event", properties, ...(edges ? { edges } : {}) },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function occurrences(
  from: string,
  to: string,
  extra = "",
): Promise<{ status: number; rows: OccurrenceRow[]; errors: SeriesError[] }> {
  const res = await request(
    ctx.app,
    "GET",
    `/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`,
    { key: memberKey },
  );
  const body = (await res.json()) as {
    data?: OccurrenceRow[];
    series_errors?: SeriesError[];
  };
  return {
    status: res.status,
    rows: body.data ?? [],
    errors: body.series_errors ?? [],
  };
}

describe("GET /occurrences", () => {
  it("requires auth", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/occurrences?from=2026-03-01T00:00:00Z&to=2026-03-08T00:00:00Z",
      {},
    );
    expect(res.status).toBe(401);
  });

  it("expands a weekly series across the window", async () => {
    const id = await createEvent({
      title: "Standup",
      starts_at: "2026-05-05T09:00:00.000Z",
      ends_at: "2026-05-05T09:30:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    });
    const { status, rows } = await occurrences(
      "2026-05-01T00:00:00Z",
      "2026-05-27T00:00:00Z",
    );
    expect(status).toBe(200);
    const mine = rows.filter((r) => r.item.id === id);
    expect(mine.map((r) => r.starts_at.slice(0, 10))).toEqual([
      "2026-05-05",
      "2026-05-12",
      "2026-05-19",
      "2026-05-26",
    ]);
    expect(mine.every((r) => r.series_id === id)).toBe(true);
    expect(mine[0]?.ends_at).toBe("2026-05-05T09:30:00.000Z");
  });

  it("returns a single event once, by its own time, with no series id", async () => {
    const id = await createEvent({
      title: "One-off",
      starts_at: "2026-06-10T14:00:00.000Z",
    });
    const { rows } = await occurrences(
      "2026-06-01T00:00:00Z",
      "2026-06-30T00:00:00Z",
    );
    const mine = rows.filter((r) => r.item.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.series_id).toBeUndefined();
  });

  it("omits events outside the window", async () => {
    const id = await createEvent({
      title: "Far away",
      starts_at: "2027-01-10T14:00:00.000Z",
    });
    const { rows } = await occurrences(
      "2026-06-01T00:00:00Z",
      "2026-06-30T00:00:00Z",
    );
    expect(rows.some((r) => r.item.id === id)).toBe(false);
  });

  it("lets a stored exception stand in for the occurrence it replaces, at its own time", async () => {
    const seriesId = await createEvent({
      title: "Weekly review",
      starts_at: "2026-07-06T10:00:00.000Z",
      ends_at: "2026-07-06T11:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    // The 13 July instance moved to the afternoon.
    const movedId = await createEvent(
      {
        title: "Weekly review (moved)",
        starts_at: "2026-07-13T15:00:00.000Z",
        ends_at: "2026-07-13T16:00:00.000Z",
        original_starts_at: "2026-07-13T10:00:00.000Z",
      },
      {},
    );
    // parent-of runs series to exception: source is the parent.
    const edge = await request(ctx.app, "POST", "/edges", {
      key: memberKey,
      body: {
        source_id: seriesId,
        target_id: movedId,
        edge_type: "parent-of",
      },
    });
    expect(edge.status).toBe(201);

    const { rows } = await occurrences(
      "2026-07-01T00:00:00Z",
      "2026-07-27T00:00:00Z",
    );
    const mine = rows.filter(
      (r) => r.series_id === seriesId || r.item.id === movedId,
    );
    // The 13th appears once, as the moved item, at 15:00 not 10:00.
    const thirteenth = mine.filter((r) => r.starts_at.startsWith("2026-07-13"));
    expect(thirteenth).toHaveLength(1);
    expect(thirteenth[0]?.item.id).toBe(movedId);
    expect(thirteenth[0]?.starts_at).toBe("2026-07-13T15:00:00.000Z");
    expect(thirteenth[0]?.replaces).toBe("2026-07-13T10:00:00.000Z");
    // The untouched occurrences still come from the series.
    expect(
      mine.find((r) => r.starts_at.startsWith("2026-07-06"))?.item.id,
    ).toBe(seriesId);
  });

  it("orders the window by start time across every source", async () => {
    const { rows } = await occurrences(
      "2026-05-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
    );
    const starts = rows.map((r) => r.starts_at);
    expect([...starts].sort()).toEqual(starts);
  });

  it("refuses an inverted window", async () => {
    const { status } = await occurrences(
      "2026-06-10T00:00:00Z",
      "2026-06-01T00:00:00Z",
    );
    expect(status).toBe(400);
  });

  it("refuses an unreadable window", async () => {
    const { status } = await occurrences("yesterday", "2026-06-01T00:00:00Z");
    expect(status).toBe(400);
  });

  it("refuses a window longer than the cap rather than trimming it", async () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date(from.getTime() + (MAX_WINDOW_DAYS + 1) * 86_400_000);
    const { status } = await occurrences(from.toISOString(), to.toISOString());
    expect(status).toBe(400);
  });

  it("returns a zoned series at the instants its zone names, across the daylight-saving change", async () => {
    // Stored exactly as the calendar integration writes it: an
    // offset-bearing instant plus the series zone alongside.
    const id = await createEvent({
      title: "Berlin standup",
      starts_at: "2026-03-24T09:00:00+01:00",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    });
    const { status, rows } = await occurrences(
      "2026-03-20T00:00:00Z",
      "2026-04-10T00:00:00Z",
    );
    expect(status).toBe(200);
    const mine = rows.filter((r) => r.item.id === id);
    // 09:00 Berlin is 08:00Z before the 29 March transition, 07:00Z after.
    expect(mine.map((r) => r.starts_at)).toEqual([
      "2026-03-24T08:00:00.000Z",
      "2026-03-31T07:00:00.000Z",
      "2026-04-07T07:00:00.000Z",
    ]);
  });

  it("shows a moved occurrence of a zoned series once, at its new time", async () => {
    const seriesId = await createEvent({
      title: "Zoned review",
      starts_at: "2026-10-05T14:00:00+02:00",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    // The 12 October instance moved to the next day.
    const movedId = await createEvent({
      title: "Zoned review (moved)",
      starts_at: "2026-10-13T09:00:00+02:00",
      original_starts_at: "2026-10-12T14:00:00+02:00",
    });
    const edge = await request(ctx.app, "POST", "/edges", {
      key: memberKey,
      body: {
        source_id: seriesId,
        target_id: movedId,
        edge_type: "parent-of",
      },
    });
    expect(edge.status).toBe(201);

    const { rows } = await occurrences(
      "2026-10-01T00:00:00Z",
      "2026-10-20T00:00:00Z",
    );
    const mine = rows.filter(
      (r) => r.series_id === seriesId || r.item.id === movedId,
    );
    // The moved item appears exactly once, at its own time; the slot it
    // left is not shown as a ghost.
    const moved = mine.filter((r) => r.item.id === movedId);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.starts_at).toBe("2026-10-13T07:00:00.000Z");
    expect(moved[0]?.replaces).toBe("2026-10-12T12:00:00.000Z");
    expect(
      mine.filter((r) => r.starts_at === "2026-10-12T12:00:00.000Z"),
    ).toHaveLength(0);
  });

  it("still shows an exception whose original slot is outside the window", async () => {
    const seriesId = await createEvent({
      title: "November series",
      starts_at: "2026-11-02T10:00:00+01:00",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    // The 2 November instance moved forward into December: its original
    // slot sits outside the window below, but the item itself is in it.
    const movedId = await createEvent({
      title: "November review (moved far)",
      starts_at: "2026-12-04T10:00:00+01:00",
      original_starts_at: "2026-11-02T10:00:00+01:00",
    });
    const edge = await request(ctx.app, "POST", "/edges", {
      key: memberKey,
      body: {
        source_id: seriesId,
        target_id: movedId,
        edge_type: "parent-of",
      },
    });
    expect(edge.status).toBe(201);

    const { rows } = await occurrences(
      "2026-12-01T00:00:00Z",
      "2026-12-10T00:00:00Z",
    );
    const moved = rows.filter((r) => r.item.id === movedId);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.starts_at).toBe("2026-12-04T09:00:00.000Z");
  });

  it("counts a series' contribution against the window, not its history", async () => {
    // A daily meeting running since 2021 contributes seven rows to a
    // seven-day window; its age alone must not fail the read.
    const id = await createEvent({
      title: "Old daily standup",
      starts_at: "2021-01-04T09:00:00+01:00",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    const { status, rows, errors } = await occurrences(
      "2027-02-01T00:00:00Z",
      "2027-02-08T00:00:00Z",
    );
    expect(status).toBe(200);
    expect(rows.filter((r) => r.item.id === id)).toHaveLength(7);
    expect(errors.filter((e) => e.item_id === id)).toHaveLength(0);
  });

  it("reports a series that floods the window and keeps the rest of the calendar", async () => {
    const floodId = await createEvent({
      title: "Every minute",
      starts_at: "2026-09-01T00:00:00.000Z",
      recurrence: ["RRULE:FREQ=MINUTELY"],
    });
    const okId = await createEvent({
      title: "September one-off",
      starts_at: "2026-09-10T12:00:00.000Z",
    });
    const { status, rows, errors } = await occurrences(
      "2026-09-01T00:00:00Z",
      "2026-09-30T00:00:00Z",
    );
    expect(status).toBe(200);
    expect(rows.some((r) => r.item.id === okId)).toBe(true);
    const mine = errors.filter((e) => e.item_id === floodId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.message).toContain("in this window");
  });

  it("leaves out an event that straddles the window's start", async () => {
    // Pinning what the route does, not arguing for it: the window is
    // matched on the start instant alone, so an event already running
    // when the window opens is not on it. The SQL narrowing has to make
    // the same call the in-memory filter did, and this is where a
    // change of mind would show up.
    const id = await createEvent({
      title: "Started before the window",
      starts_at: "2027-06-30T22:00:00.000Z",
      ends_at: "2027-07-01T02:00:00.000Z",
    });
    const { rows } = await occurrences(
      "2027-07-01T00:00:00Z",
      "2027-07-05T00:00:00Z",
    );
    expect(rows.some((r) => r.item.id === id)).toBe(false);
  });

  it("shadows an occurrence whose exception was moved out of the window", async () => {
    // The exception's own time is outside the window, so a windowed
    // read of exceptions would never see it and the slot it left would
    // come back as a ghost: a meeting shown at a time nobody is at.
    const seriesId = await createEvent({
      title: "Series with an escapee",
      starts_at: "2027-08-02T10:00:00.000Z",
      ends_at: "2027-08-02T11:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    const movedId = await createEvent({
      title: "Escaped to October",
      starts_at: "2027-10-06T10:00:00.000Z",
      original_starts_at: "2027-08-09T10:00:00.000Z",
    });
    const edge = await request(ctx.app, "POST", "/edges", {
      key: memberKey,
      body: {
        source_id: seriesId,
        target_id: movedId,
        edge_type: "parent-of",
      },
    });
    expect(edge.status).toBe(201);

    const { rows } = await occurrences(
      "2027-08-01T00:00:00Z",
      "2027-08-15T00:00:00Z",
    );
    // Nothing of this series sits at the slot the exception vacated.
    // Scoped to the series because the suite shares one space and an
    // unrelated weekly rule runs through the same instant.
    expect(
      rows.filter(
        (r) =>
          r.series_id === seriesId &&
          r.starts_at === "2027-08-09T10:00:00.000Z",
      ),
    ).toHaveLength(0);
    // The 2nd still comes from the series, so the shadow removed one
    // occurrence rather than the rule.
    expect(
      rows.filter(
        (r) =>
          r.series_id === seriesId &&
          r.starts_at === "2027-08-02T10:00:00.000Z",
      ),
    ).toHaveLength(1);
    // The exception itself appears once and only through the series,
    // carrying its own out-of-window time and the slot it replaces.
    const shown = rows.filter((r) => r.item.id === movedId);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.starts_at).toBe("2027-10-06T10:00:00.000Z");
    expect(shown[0]?.replaces).toBe("2027-08-09T10:00:00.000Z");
    expect(shown[0]?.series_id).toBe(seriesId);
  });

  it("puts mixed offsets on the right side of the window boundary", async () => {
    // The case a comparison against the stored strings gets wrong: read
    // as text, `2027-09-01T01:00:00+02:00` sorts after the window's
    // `2027-09-01T00:00:00Z` start, so the event before the boundary
    // reads as being after it.
    const beforeId = await createEvent({
      title: "An hour before the window, written in +02:00",
      starts_at: "2027-09-01T01:00:00+02:00",
    });
    const insideId = await createEvent({
      title: "Half an hour into the window, written in Z",
      starts_at: "2027-09-01T00:30:00.000Z",
    });
    const alsoInsideId = await createEvent({
      title: "Two hours into the window, written in +02:00",
      starts_at: "2027-09-01T04:00:00+02:00",
    });

    const { rows } = await occurrences(
      "2027-09-01T00:00:00Z",
      "2027-09-02T00:00:00Z",
    );
    const mine = rows.filter((r) =>
      [beforeId, insideId, alsoInsideId].includes(r.item.id),
    );
    expect(mine.map((r) => r.item.id)).toEqual([insideId, alsoInsideId]);
    expect(mine.map((r) => r.starts_at)).toEqual([
      "2027-09-01T00:30:00.000Z",
      "2027-09-01T02:00:00.000Z",
    ]);
  });

  it("reports a malformed rule against its series and keeps the rest of the calendar", async () => {
    const badId = await createEvent({
      title: "Rule with no frequency",
      starts_at: "2027-04-01T09:00:00.000Z",
      recurrence: ["RRULE:INTERVAL=2"],
    });
    const okId = await createEvent({
      title: "April one-off",
      starts_at: "2027-04-02T12:00:00.000Z",
    });
    const { status, rows, errors } = await occurrences(
      "2027-04-01T00:00:00Z",
      "2027-04-05T00:00:00Z",
    );
    expect(status).toBe(200);
    expect(rows.some((r) => r.item.id === okId)).toBe(true);
    expect(errors.filter((e) => e.item_id === badId)).toHaveLength(1);
  });
});

describe("the occurrence ceiling", () => {
  // The ceiling's behavior is owned here. The client suite keeps its own
  // read of the same rules, but asserts only what a typed client adds:
  // that the refusal maps to a `ValidationError` with usable `details`,
  // and that a successful read carries the ceiling back. Where the
  // assembly stops is asserted against a synthetic calendar in
  // `occurrences.pagination.test.ts`, which is the only place large
  // enough to tell stopping early from stopping late.
  //
  // Its own fixture, anchored well past every other case's window: the
  // series pass is unwindowed, so rules dense enough to flood a window
  // would be re-expanded by every assertion in this file if they
  // overlapped one.
  const DENSE_FROM = "2029-01-01T00:00:00Z";

  beforeAll(async () => {
    // Three hourly rules: 1,680 occurrences each over seventy days,
    // under the per-series cap that would report them individually, and
    // 5,040 together — past the ceiling on the assembled result.
    //
    for (const n of [1, 2, 3]) {
      await createEvent({
        title: `Hourly ${String(n)}`,
        starts_at: "2029-01-01T00:00:00.000Z",
        recurrence: ["RRULE:FREQ=HOURLY"],
      });
    }
  });

  it("refuses a window holding more occurrences than the ceiling", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/occurrences?from=${encodeURIComponent(DENSE_FROM)}&to=${encodeURIComponent("2029-03-12T00:00:00Z")}`,
      { key: memberKey },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { max_occurrences?: number; found?: number } };
    };
    expect(body.error.details?.max_occurrences).toBe(5000);
    // The count comes back with it, so a caller narrows by an informed
    // amount rather than by guesswork.
    expect(body.error.details?.found).toBeGreaterThan(5000);
  });

  it("serves a narrower window over the same rules", async () => {
    // The direction that matters most here. A caller refused by this
    // ceiling is told to narrow, and narrowing has to actually work —
    // the scan ceiling this route used to carry refused the same read
    // for a reason no narrowing could address, so "ask for less" did
    // nothing at all.
    const { status, rows } = await occurrences(
      DENSE_FROM,
      "2029-01-03T00:00:00Z",
    );
    expect(status).toBe(200);
    // Scoped to this fixture's own rules: the file's other series are
    // unbounded, so a handful of them reach any window put in front of
    // them, and asserting on the whole window would be asserting on
    // them too.
    const hourly = rows.filter((r) =>
      String(r.item.properties.title).startsWith("Hourly "),
    );
    // Three rules, hourly, over two days: every slot present and none
    // doubled.
    expect(hourly).toHaveLength(3 * 48);
    expect(new Set(hourly.map((r) => r.starts_at)).size).toBe(48);
    expect(hourly.every((r) => r.series_id !== undefined)).toBe(true);
  });
});

describe("a row whose declared rule cannot be used", () => {
  // Every one of these writes with a 201: `core.event` requires `title`
  // and nothing else, and `recurrence` is declared as an array of
  // strings but validated only as an array. Each used to leave the
  // response asserting `series_errors: 0` over a row it had quietly
  // dropped or quietly misread, which is worse than saying nothing:
  // nobody investigates a calendar that reports itself complete.
  //
  // Anchored in 2031, past every other fixture's window. The series
  // pass is unwindowed, so these rows are scanned by every read in this
  // file and only their own assertions should see them.
  const FROM = "2031-05-01T00:00:00Z";
  const TO = "2031-05-08T00:00:00Z";

  it("reports a rule with no start to unfold it from", async () => {
    // Absent from the calendar in both passes: the series pass has no
    // anchor to expand from, and the window pass drops it for carrying a
    // rule. It is reachable, it is invisible, and the only honest thing
    // the response can do is name it.
    const id = await createEvent({
      title: "a rule with nothing to unfold",
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
    const { status, rows, errors } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    expect(rows.filter((r) => r.item.id === id)).toHaveLength(0);
    const reported = errors.filter((e) => e.item_id === id);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("starts_at");
  });

  it("reports a recurrence holding no readable property line", async () => {
    // The narrower sibling. This one is not absent — it filters to an
    // empty rule, so the window pass renders it as the single event its
    // own times describe, which is the best answer available. What was
    // wrong was that the rule went unapplied without a word: a caller
    // asking for a repeating meeting got exactly one and no reason.
    const id = await createEvent({
      title: "a rule made of numbers",
      starts_at: "2031-05-02T09:00:00.000Z",
      recurrence: [7, 9],
    });
    const { status, rows, errors } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    // Still on the calendar, once, at its own time.
    const shown = rows.filter((r) => r.item.id === id);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.series_id).toBeUndefined();
    expect(errors.filter((e) => e.item_id === id)).toHaveLength(1);
  });

  it("reports a line dropped from a rule it still applied", async () => {
    // The one that loses occurrences rather than gaining them: the
    // dropped entry could have been the EXDATE, and expanding without it
    // puts back the very occurrence it existed to remove. So the series
    // expands — refusing it would take a working meeting off the
    // calendar — and the response says a line was ignored.
    const id = await createEvent({
      title: "a rule with an unreadable line",
      starts_at: "2031-05-02T14:00:00.000Z",
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3", { EXDATE: "nope" }],
    });
    const { status, rows, errors } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    const shown = rows.filter((r) => r.item.id === id);
    expect(shown).toHaveLength(3);
    expect(shown.every((r) => r.series_id === id)).toBe(true);
    expect(errors.filter((e) => e.item_id === id)).toHaveLength(1);
  });

  it("reports one row twice when two things are wrong with its rule", async () => {
    // Both sources fire on this row: the projection drops the entry that
    // is not a property line, and the expander then refuses the EXRULE
    // that was left. Two entries against one `item_id`, and
    // `scan.series_errors` counts two.
    //
    // Pinned because the field's description used to say "one entry per
    // series", which made the count read as a number of broken rules —
    // it is a number of failures, and a caller wanting rules groups on
    // `item_id`. It also decides the cap's unit: this row consumes two
    // of the 500 entries, not one.
    const id = await createEvent({
      title: "broken two ways",
      starts_at: "2031-05-04T09:00:00.000Z",
      recurrence: [42, "EXRULE:FREQ=DAILY"],
    });
    const res = await request(
      ctx.app,
      "GET",
      `/occurrences?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series_errors?: SeriesError[];
      scan: { series_errors: number };
    };
    const mine = (body.series_errors ?? []).filter((e) => e.item_id === id);
    expect(mine).toHaveLength(2);
    // Different failures, not the same one twice.
    expect(new Set(mine.map((e) => e.message)).size).toBe(2);
    // And the count is in the same unit as the array, which is what
    // makes the truncation comparison behind `series_errors_truncated`
    // exact.
    expect(body.scan.series_errors).toBeGreaterThanOrEqual(2);
  });

  it("says nothing about a row that declares no rule at all", async () => {
    // The control. An empty list is an explicit "this does not repeat",
    // and a response that called it broken would be the same defect
    // pointed the other way.
    const id = await createEvent({
      title: "an event that does not repeat",
      starts_at: "2031-05-03T09:00:00.000Z",
      recurrence: [],
    });
    const { status, rows, errors } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    expect(rows.filter((r) => r.item.id === id)).toHaveLength(1);
    expect(errors.filter((e) => e.item_id === id)).toHaveLength(0);
  });
});

describe("a series carrying a timezone that does not resolve", () => {
  // `core.event.timezone` is declared `{"type": "string"}` with no
  // format, so every one of these writes with a 201, and `Intl` raises
  // a `RangeError` rather than returning anything for them. The raise
  // reached this route as a bug rather than as a series' own failure, so
  // one row took the whole calendar down with a 500 — permanently, on
  // every window, because the series pass is unwindowed and no narrowing
  // reaches it. The healthy meeting below is the half that makes it
  // matter: it was lost too, and its owner could do nothing about it but
  // find and delete a row they had no reason to suspect.
  const FROM = "2033-02-01T00:00:00Z";
  const TO = "2033-02-08T00:00:00Z";

  it.each([
    ["a misspelled IANA zone", "Europe/Berlim"],
    ["an offset written as a zone", "UTC+1"],
    ["a GMT offset", "GMT+2"],
    ["a Windows zone name", "Pacific Standard Time"],
  ])("degrades that series and not the read: %s", async (_label, zone) => {
    const badId = await createEvent({
      title: `unresolvable zone ${zone}`,
      starts_at: "2033-02-02T09:00:00.000Z",
      timezone: zone,
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    const healthyId = await createEvent({
      title: "a meeting beside it",
      starts_at: "2033-02-03T09:00:00.000Z",
    });

    const { status, rows, errors } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    // The calendar still answers, and the row that had nothing wrong
    // with it is still on it.
    expect(rows.filter((r) => r.item.id === healthyId)).toHaveLength(1);
    // The broken series contributes no occurrence and is named.
    expect(rows.filter((r) => r.item.id === badId)).toHaveLength(0);
    const reported = errors.filter((e) => e.item_id === badId);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("timezone");
  });
});

describe("the scan block", () => {
  it("reports the ceiling on a read nowhere near it", async () => {
    // The announcement is the point: a bound mentioned only when it
    // fires tells a growing calendar nothing until the day it breaks.
    const res = await request(
      ctx.app,
      "GET",
      "/occurrences?from=2026-05-01T00:00:00Z&to=2026-05-08T00:00:00Z",
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      expansion_incomplete?: boolean;
      scan: {
        events_read: number;
        occurrences: number;
        max_occurrences: number;
        max_unproductive_iterations: number;
        series_unexpanded: number;
      };
    };
    expect(body.scan.max_occurrences).toBe(5000);
    expect(body.scan.occurrences).toBe(body.data.length);
    // What the read actually cost. Two of the three passes cannot be
    // narrowed by the window, so this is the figure that grows with the
    // calendar, and it is the one worth watching.
    expect(body.scan.events_read).toBeGreaterThan(0);
    // The expansion budget announces itself the same way, and a read
    // that finished expanding says so rather than leaving the caller to
    // infer it from a missing field.
    expect(body.scan.max_unproductive_iterations).toBeGreaterThan(0);
    expect(body.scan.series_unexpanded).toBe(0);
    expect(body.expansion_incomplete).toBeUndefined();
  });
});
