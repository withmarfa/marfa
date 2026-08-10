/**
 * The window read against a calendar bigger than one page.
 *
 * Its own file because the fixture is a few hundred events, and every
 * assertion in the sibling suite would pay for them.
 *
 * The route asked the storage layer for 1000 rows and read the single
 * page it got back. `items.list` clamps any limit to 200, so what it
 * actually saw was the 200 most recent events of each type — and it
 * returned that as the calendar, with a 200 and no indication anything
 * was missing. A space passes 200 events without anyone noticing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { MAX_EVENTS_SCANNED, gatherEventItems } from "./occurrences.js";

let ctx: TestContext;
let memberKey: string;

interface OccurrenceRow {
  starts_at: string;
  item: { id: string; properties: Record<string, unknown> };
  series_id?: string;
  replaces?: string;
}

beforeAll(async () => {
  ctx = await createTestContext();
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: "occurrences-pagination",
      source: "occurrences-page-src",
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

async function occurrences(
  from: string,
  to: string,
): Promise<{ status: number; rows: OccurrenceRow[]; body: unknown }> {
  const res = await request(
    ctx.app,
    "GET",
    `/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { key: memberKey },
  );
  const body = (await res.json()) as { data?: OccurrenceRow[] };
  return { status: res.status, rows: body.data ?? [], body };
}

describe("GET /occurrences past the first page", () => {
  const FROM = "2026-06-01T00:00:00Z";
  const TO = "2026-06-08T00:00:00Z";

  beforeAll(async () => {
    // The one event inside the window is created FIRST, so the default
    // newest-first ordering puts it last — past the first page, which is
    // exactly where the single-page read could not see it.
    const inWindow = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: {
        type: "core.event",
        properties: {
          title: "the meeting past the first page",
          starts_at: "2026-06-03T09:00:00.000Z",
          ends_at: "2026-06-03T10:00:00.000Z",
        },
      },
    });
    expect(inWindow.status).toBe(201);

    // Filler outside the window: enough to push the row above past one
    // page, in two bulk writes so the fixture stays quick.
    for (let batch = 0; batch < 2; batch += 1) {
      const items = Array.from({ length: 150 }, (_, i) => ({
        type: "core.event",
        properties: {
          title: `filler ${String(batch)}-${String(i)}`,
          // A year away, so none of these can land in the window.
          starts_at: "2027-01-04T09:00:00.000Z",
        },
      }));
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: memberKey,
        body: { items },
      });
      expect(res.status).toBe(200);
    }
  });

  it("finds an event that sits past the first page of a type", async () => {
    const { status, rows } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    const titles = rows.map((r) => r.item.properties.title);
    expect(titles).toContain("the meeting past the first page");
    // And nothing from outside the window came along with it.
    expect(rows).toHaveLength(1);
  });

  it("expands a series that sits past the first page", async () => {
    // A rule is the harder half: a series the read never sees produces no
    // occurrences at all, so the calendar is missing a repeating meeting
    // rather than a single one.
    const res = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: {
        type: "core.event",
        properties: {
          title: "weekly past the first page",
          starts_at: "2025-01-06T11:00:00.000Z",
          ends_at: "2025-01-06T11:30:00.000Z",
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        },
      },
    });
    expect(res.status).toBe(201);

    // Push it past the first page too.
    const items = Array.from({ length: 60 }, (_, i) => ({
      type: "core.event",
      properties: {
        title: `filler-b ${String(i)}`,
        starts_at: "2027-02-04T09:00:00.000Z",
      },
    }));
    const bulk = await request(ctx.app, "POST", "/items/bulk", {
      key: memberKey,
      body: { items },
    });
    expect(bulk.status).toBe(200);

    const { status, rows } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    const weekly = rows.filter(
      (r) => r.item.properties.title === "weekly past the first page",
    );
    expect(weekly).toHaveLength(1);
    expect(weekly[0]?.starts_at).toBe("2026-06-01T11:00:00.000Z");
    expect(weekly[0]?.series_id).toBeDefined();
  });

  it("resolves an exception whose series sits on a different page", async () => {
    // Series and exception are separate rows and land on separate pages
    // once a calendar is big enough. The exception is only a shadow if
    // both are in hand; with one of them missing the moved meeting either
    // vanishes or doubles.
    const series = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: {
        type: "core.event",
        properties: {
          title: "daily with a moved day",
          starts_at: "2026-06-02T08:00:00.000Z",
          ends_at: "2026-06-02T08:30:00.000Z",
          recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
        },
      },
    });
    expect(series.status).toBe(201);
    const seriesId = ((await series.json()) as { item: { id: string } }).item
      .id;

    // Filler between the two, so they cannot share a page.
    const items = Array.from({ length: 210 }, (_, i) => ({
      type: "core.event",
      properties: {
        title: `filler-c ${String(i)}`,
        starts_at: "2027-03-04T09:00:00.000Z",
      },
    }));
    const bulk = await request(ctx.app, "POST", "/items/bulk", {
      key: memberKey,
      body: { items },
    });
    expect(bulk.status).toBe(200);

    const moved = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: {
        type: "core.event",
        properties: {
          title: "moved to the afternoon",
          starts_at: "2026-06-03T15:00:00.000Z",
          ends_at: "2026-06-03T15:30:00.000Z",
          original_starts_at: "2026-06-03T08:00:00.000Z",
        },
        edges: { "parent-of": [] },
      },
    });
    expect(moved.status).toBe(201);
    const movedId = ((await moved.json()) as { item: { id: string } }).item.id;
    // parent-of runs series → exception.
    const edge = await request(ctx.app, "POST", "/edges", {
      key: memberKey,
      body: {
        source_id: seriesId,
        target_id: movedId,
        edge_type: "parent-of",
      },
    });
    expect(edge.status).toBe(201);

    const { status, rows } = await occurrences(FROM, TO);
    expect(status).toBe(200);
    const fromSeries = rows.filter((r) => r.series_id === seriesId);
    // Three days, the middle one moved: the moved row shows once at its
    // own time and carries `replaces`, and no ghost sits at 08:00.
    expect(fromSeries.map((r) => r.starts_at).sort()).toEqual([
      "2026-06-02T08:00:00.000Z",
      "2026-06-03T15:00:00.000Z",
      "2026-06-04T08:00:00.000Z",
    ]);
    const replacement = fromSeries.find((r) => r.replaces !== undefined);
    expect(replacement?.item.properties.title).toBe("moved to the afternoon");
    // And it is not also listed as a standalone event.
    expect(rows.filter((r) => r.item.id === movedId)).toHaveLength(1);
  });
});

describe("the scan ceiling", () => {
  it("refuses rather than returning a partial calendar", async () => {
    // Driven at a ceiling a test can reach, against the same walk the
    // route runs. The direction of failure is the whole point: the read
    // this replaces answered 200 with whatever fitted in one page.
    await expect(
      gatherEventItems(ctx.storage, undefined, ["core.event"], 5),
    ).rejects.toThrow(/more than 5 events/);
  });

  it("returns everything when the ceiling is not reached", async () => {
    // The other direction, so the refusal above is not simply a function
    // that always throws.
    const all = await gatherEventItems(
      ctx.storage,
      undefined,
      ["core.event"],
      MAX_EVENTS_SCANNED,
    );
    // More than one page — the fixtures above put several hundred rows in.
    expect(all.length).toBeGreaterThan(200);
  });
});
