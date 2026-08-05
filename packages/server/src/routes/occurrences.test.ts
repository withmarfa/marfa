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

beforeAll(async () => {
  ctx = await createTestContext();
  // A member credential, not an admin: reading your own calendar is the
  // ordinary case, and it exercises the type filter rather than bypassing it.
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: "occurrences-member",
      source: "occurrences-src",
      role: "member",
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
): Promise<{ status: number; rows: OccurrenceRow[] }> {
  const res = await request(
    ctx.app,
    "GET",
    `/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`,
    { key: memberKey },
  );
  const body = (await res.json()) as { data?: OccurrenceRow[] };
  return { status: res.status, rows: body.data ?? [] };
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

  it("refuses a rule that would flood the window", async () => {
    await createEvent({
      title: "Every minute",
      starts_at: "2026-09-01T00:00:00.000Z",
      recurrence: ["RRULE:FREQ=MINUTELY"],
    });
    const { status } = await occurrences(
      "2026-09-01T00:00:00Z",
      "2026-09-30T00:00:00Z",
    );
    expect(status).toBe(400);
  });
});
