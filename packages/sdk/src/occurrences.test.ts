import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createKeysModeFixture, type KeysModeFixture } from "./test-harness.js";
import { MarfaClient } from "./client.js";
import { UnauthorizedError, ValidationError } from "./errors.js";

/**
 * `client.occurrences` against a real in-process server, because the
 * whole value of this namespace is what the server computes: rules
 * expanded over a window, exceptions shadowing the slots they left, and
 * an ask too big to answer refused rather than trimmed. A mock fetch
 * would only prove the URL was assembled.
 *
 * The suite shares one space, so every assertion scopes to the ids it
 * created and the windows are kept in separate years. The occurrence
 * ceiling gets its own fixture: the series pass is unwindowed, so the
 * rules that flood one window would be re-expanded on every later read.
 */

let fx: KeysModeFixture;

beforeAll(async () => {
  fx = await createKeysModeFixture();
});

afterAll(() => {
  fx.cleanup();
});

async function createEvent(
  properties: Record<string, unknown>,
): Promise<string> {
  const item = await fx.client.items.create({
    type: "core.event",
    properties,
  });
  return item.id;
}

describe("occurrences.list", () => {
  it("returns a single event once, at its own time, with no series id", async () => {
    const id = await createEvent({
      title: "One-off",
      starts_at: "2026-06-10T14:00:00.000Z",
      ends_at: "2026-06-10T15:00:00.000Z",
    });

    const result = await fx.client.occurrences.list({
      from: "2026-06-01T00:00:00Z",
      to: "2026-06-30T00:00:00Z",
    });

    const mine = result.data.filter((o) => o.item.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.starts_at).toBe("2026-06-10T14:00:00.000Z");
    expect(mine[0]?.ends_at).toBe("2026-06-10T15:00:00.000Z");
    expect(mine[0]?.series_id).toBeUndefined();
    expect(mine[0]?.replaces).toBeUndefined();
  });

  it("echoes the window it read, normalized to UTC", async () => {
    const result = await fx.client.occurrences.list({
      from: "2026-06-01T02:00:00+02:00",
      to: "2026-06-30T00:00:00Z",
    });
    expect(result.window).toEqual({
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-30T00:00:00.000Z",
    });
  });

  it("omits an event outside the window", async () => {
    const outside = await createEvent({
      title: "Far away",
      starts_at: "2030-01-10T14:00:00.000Z",
    });
    // Seeded alongside so the absence below cannot be satisfied by an
    // empty read. Without it this test passes against a route that
    // returns nothing at all.
    const inside = await createEvent({
      title: "Inside the window",
      starts_at: "2026-06-14T09:00:00.000Z",
    });

    const result = await fx.client.occurrences.list({
      from: "2026-06-01T00:00:00Z",
      to: "2026-06-30T00:00:00Z",
    });
    expect(result.data.some((o) => o.item.id === inside)).toBe(true);
    expect(result.data.some((o) => o.item.id === outside)).toBe(false);
  });

  it("expands a weekly series into one entry per occurrence in the window", async () => {
    const id = await createEvent({
      title: "Standup",
      starts_at: "2026-05-05T09:00:00.000Z",
      ends_at: "2026-05-05T09:30:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    });

    const result = await fx.client.occurrences.list({
      from: "2026-05-01T00:00:00Z",
      to: "2026-05-27T00:00:00Z",
    });

    const mine = result.data.filter((o) => o.item.id === id);
    // Four Tuesdays, not one anchor: the series is stored as a single item.
    expect(mine.map((o) => o.starts_at)).toEqual([
      "2026-05-05T09:00:00.000Z",
      "2026-05-12T09:00:00.000Z",
      "2026-05-19T09:00:00.000Z",
      "2026-05-26T09:00:00.000Z",
    ]);
    expect(mine.every((o) => o.series_id === id)).toBe(true);
    expect(mine[0]?.ends_at).toBe("2026-05-05T09:30:00.000Z");
  });

  it("returns occurrences ordered by start time across every source", async () => {
    // Ordering is vacuous on an empty list, and the window below is only
    // populated by earlier tests in this file. Seeding a series and a
    // single event here makes the assertion stand on its own rather than
    // on declaration order.
    const series = await createEvent({
      title: "Ordering series",
      starts_at: "2026-05-04T08:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3"],
    });
    const single = await createEvent({
      title: "Ordering one-off",
      starts_at: "2026-06-20T18:00:00.000Z",
    });

    const result = await fx.client.occurrences.list({
      from: "2026-05-01T00:00:00Z",
      to: "2026-07-01T00:00:00Z",
    });

    expect(result.data.filter((o) => o.series_id === series)).toHaveLength(3);
    expect(result.data.some((o) => o.item.id === single)).toBe(true);
    const starts = result.data.map((o) => o.starts_at);
    expect([...starts].sort()).toEqual(starts);
  });

  it("keeps a series in its own zone rather than flattening it", async () => {
    // 09:00 in Berlin is 08:00Z before the 29 March transition and 07:00Z
    // after it. A kit that resolved these against one zone would space
    // them evenly and be wrong on one side of the change.
    const id = await createEvent({
      title: "Berlin standup",
      starts_at: "2026-03-24T09:00:00+01:00",
      timezone: "Europe/Berlin",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    });

    const result = await fx.client.occurrences.list({
      from: "2026-03-20T00:00:00Z",
      to: "2026-04-10T00:00:00Z",
    });

    const mine = result.data.filter((o) => o.item.id === id);
    expect(mine.map((o) => o.starts_at)).toEqual([
      "2026-03-24T08:00:00.000Z",
      "2026-03-31T07:00:00.000Z",
      "2026-04-07T07:00:00.000Z",
    ]);
    // The zone rides along on the item, which is the only thing that lets
    // a caller render the wall-clock hour the series actually keeps.
    expect(mine[0]?.item.properties.timezone).toBe("Europe/Berlin");
  });

  it("lets a stored exception shadow the occurrence it replaces", async () => {
    const seriesId = await createEvent({
      title: "Weekly review",
      starts_at: "2026-07-06T10:00:00.000Z",
      ends_at: "2026-07-06T11:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    const movedId = await createEvent({
      title: "Weekly review (moved)",
      starts_at: "2026-07-13T15:00:00.000Z",
      ends_at: "2026-07-13T16:00:00.000Z",
      original_starts_at: "2026-07-13T10:00:00.000Z",
    });
    // parent-of runs series to exception: the series is the source.
    await fx.client.edges.create({
      source_id: seriesId,
      target_id: movedId,
      edge_type: "parent-of",
    });

    const result = await fx.client.occurrences.list({
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-27T00:00:00Z",
    });
    const mine = result.data.filter(
      (o) => o.series_id === seriesId || o.item.id === movedId,
    );

    // The 13th shows once, as the moved item, at its own time.
    const moved = mine.filter((o) => o.item.id === movedId);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.starts_at).toBe("2026-07-13T15:00:00.000Z");
    expect(moved[0]?.ends_at).toBe("2026-07-13T16:00:00.000Z");
    expect(moved[0]?.replaces).toBe("2026-07-13T10:00:00.000Z");
    expect(moved[0]?.series_id).toBe(seriesId);
    // Nothing is left standing at the slot it vacated.
    expect(
      mine.filter((o) => o.starts_at === "2026-07-13T10:00:00.000Z"),
    ).toHaveLength(0);
    // The untouched occurrences still come from the series itself.
    expect(
      mine.find((o) => o.starts_at === "2026-07-06T10:00:00.000Z")?.item.id,
    ).toBe(seriesId);
  });

  it("reports a series that cannot expand and still returns the calendar", async () => {
    const badId = await createEvent({
      title: "Rule with no frequency",
      starts_at: "2028-04-01T09:00:00.000Z",
      recurrence: ["RRULE:INTERVAL=2"],
    });
    const okId = await createEvent({
      title: "April one-off",
      starts_at: "2028-04-02T12:00:00.000Z",
    });

    const result = await fx.client.occurrences.list({
      from: "2028-04-01T00:00:00Z",
      to: "2028-04-05T00:00:00Z",
    });

    expect(result.data.some((o) => o.item.id === okId)).toBe(true);
    expect(
      (result.series_errors ?? []).filter((e) => e.item_id === badId),
    ).toHaveLength(1);
  });

  it("narrows to one event type and answers empty for a type that holds no events", async () => {
    const id = await createEvent({
      title: "Typed",
      starts_at: "2028-05-02T12:00:00.000Z",
    });

    const matching = await fx.client.occurrences.list({
      from: "2028-05-01T00:00:00Z",
      to: "2028-05-05T00:00:00Z",
      type: "core.event",
    });
    expect(matching.data.some((o) => o.item.id === id)).toBe(true);

    // A real type that is not an event type: the calendar is empty rather
    // than unfiltered.
    const other = await fx.client.occurrences.list({
      from: "2028-05-01T00:00:00Z",
      to: "2028-05-05T00:00:00Z",
      type: "core.note",
    });
    expect(other.data).toEqual([]);
  });

  it("accepts Date bounds and sends them as UTC instants", async () => {
    const id = await createEvent({
      title: "Date-bounded",
      starts_at: "2028-06-02T12:00:00.000Z",
    });

    const result = await fx.client.occurrences.list({
      from: new Date("2028-06-01T00:00:00Z"),
      to: new Date("2028-06-05T00:00:00Z"),
    });
    expect(result.data.some((o) => o.item.id === id)).toBe(true);
    expect(result.window.from).toBe("2028-06-01T00:00:00.000Z");
  });
});

describe("occurrences.list refusals", () => {
  it("refuses an inverted window", async () => {
    await expect(
      fx.client.occurrences.list({
        from: "2026-06-10T00:00:00Z",
        to: "2026-06-01T00:00:00Z",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an unreadable window bound", async () => {
    await expect(
      fx.client.occurrences.list({
        from: "yesterday",
        to: "2026-06-01T00:00:00Z",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a window past the span cap rather than clamping it", async () => {
    const from = new Date("2026-01-01T00:00:00Z");
    // One day past whatever the server's cap is, derived from the cap it
    // reports rather than from a constant copied over here.
    const probe = await fx.client.occurrences
      .list({
        from,
        to: new Date(from.getTime() + 100_000 * 86_400_000),
      })
      .then(
        () => null,
        (err: unknown) => err as ValidationError,
      );
    expect(probe).toBeInstanceOf(ValidationError);
    const maxDays = probe?.details?.max_days;
    expect(typeof maxDays).toBe("number");

    const to = new Date(
      from.getTime() + ((maxDays as number) + 1) * 86_400_000,
    );
    const err = await fx.client.occurrences.list({ from, to }).then(
      () => null,
      (e: unknown) => e as ValidationError,
    );
    // Refused, not silently narrowed to something that would have worked.
    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.status).toBe(400);
    expect(err?.code).toBe("validation_error");
  });

  it("refuses an invalid type identifier", async () => {
    await expect(
      fx.client.occurrences.list({
        from: "2026-06-01T00:00:00Z",
        to: "2026-06-30T00:00:00Z",
        // Type identifiers are dotted; a slash is not a namespace separator.
        type: "core/event",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an unauthorized caller", async () => {
    const anonymous = new MarfaClient({
      url: "http://localhost",
      apiKey: "marfa_k1_not_a_real_key",
      fetch: fx.fetch,
    });
    await expect(
      anonymous.occurrences.list({
        from: "2026-06-01T00:00:00Z",
        to: "2026-06-30T00:00:00Z",
      }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("refuses an unusable Date without reaching the network", async () => {
    // The one refusal the kit owns: `toISOString()` on an invalid Date
    // answers a RangeError, which would be the single failure from this
    // namespace that is not a MarfaError.
    const unreachable = new MarfaClient({
      url: "http://localhost",
      apiKey: "marfa_k1_test",
      fetch: () => {
        throw new Error("the kit should not have issued a request");
      },
    });
    const err = await unreachable.occurrences
      .list({
        from: new Date("not a date"),
        to: "2026-06-30T00:00:00Z",
      })
      .then(
        () => null,
        (e: unknown) => e as ValidationError,
      );

    expect(err).toBeInstanceOf(ValidationError);
    // Zero, not 400: nothing answered, and telemetry bucketed on status
    // would otherwise record a rejection by an endpoint never contacted.
    expect(err?.status).toBe(0);
    expect(err?.code).toBe("invalid_window_bound");
  });
});

describe("occurrences.list occurrence ceiling", () => {
  // What the ceiling does is the server's to assert, and the server suite
  // asserts it — including the count the assembly stops at, which nothing
  // outside the process can see. What belongs here is the half only a
  // typed client has: the refusal arrives as a `ValidationError` whose
  // `details` a caller can act on, and a read that succeeds carries the
  // same ceiling back so that caller can see it coming.
  //
  // Its own fixture: the series pass is unwindowed, so rules dense enough
  // to flood one window would be re-expanded on every read in the suite.
  let ceilingFx: KeysModeFixture;

  beforeAll(async () => {
    ceilingFx = await createKeysModeFixture();
    // Three hourly rules over a seventy-day window: 1680 occurrences each,
    // under the per-series cap that would report them individually, and
    // 5040 together — past the ceiling on the assembled result.
    for (const n of [1, 2, 3]) {
      await ceilingFx.client.items.create({
        type: "core.event",
        properties: {
          title: `Hourly ${String(n)}`,
          starts_at: "2029-01-01T00:00:00.000Z",
          recurrence: ["RRULE:FREQ=HOURLY"],
        },
      });
    }
  });

  afterAll(() => {
    ceilingFx.cleanup();
  });

  it("refuses a window holding more occurrences than the ceiling", async () => {
    const err = await ceilingFx.client.occurrences
      .list({
        from: "2029-01-01T00:00:00Z",
        to: "2029-03-12T00:00:00Z",
      })
      .then(
        () => null,
        (e: unknown) => e as ValidationError,
      );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err?.status).toBe(400);
    // Both keys survive the trip through the error mapping, which is what
    // a caller branching on the ceiling rather than on the message needs.
    expect(typeof err?.details?.max_occurrences).toBe("number");
    expect(err?.details?.found).toBeGreaterThan(
      err?.details?.max_occurrences as number,
    );
  });

  it("carries the scan block back on a window that fits", async () => {
    // The other direction, so the refusal above is not a read that simply
    // always fails — and the block that makes the ceiling visible before
    // it fires. Read off the declared type rather than a cast: a field the
    // server marks required and the client denies exists is a contract
    // that only looks kept.
    const result = await ceilingFx.client.occurrences.list({
      from: "2029-01-01T00:00:00Z",
      to: "2029-01-03T00:00:00Z",
    });
    expect(result.data).toHaveLength(3 * 48);
    expect(result.scan.occurrences).toBe(result.data.length);
    expect(result.scan.max_occurrences).toBeGreaterThan(result.data.length);
    expect(result.scan.events_read).toBeGreaterThan(0);
  });
});
