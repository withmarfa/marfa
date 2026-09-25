/**
 * The window read against a calendar bigger than one page.
 *
 * Its own file because the fixture is a few hundred events, and every
 * assertion in the sibling suite would pay for them.
 *
 * `items.list` clamps any limit to 200, so a route that read the single
 * page it got back would see the 200 most recent events of each type and
 * return that as the calendar, with a 200 and no indication anything was
 * missing. An instance passes 200 events without anyone noticing.
 *
 * The second half of the file goes further than a seeded fixture can and
 * drives the route over a synthetic storage: what an unbounded scan costs
 * only shows above tens of thousands of rows, and every bound that keeps
 * "slower" from meaning "out of memory" is a property of a calendar too
 * large to write to a database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../page-limits.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  gatherSeriesSeeds,
  occurrenceRoutes,
  MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS,
} from "./occurrences.js";
import { expandSeries } from "../events/expand-recurrence.js";
import type {
  ExpansionWork,
  RecurrenceSeries,
} from "../events/expand-recurrence.js";
import { createErrorHandler } from "../middleware/error-handler.js";
import type { AppEnv } from "../middleware/auth.js";
import type { ItemFilters, Storage } from "../storage/interface.js";
import type { Item } from "@withmarfa/shared";

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
    key: ctx.workingKey,
    body: {
      label: "occurrences-pagination",
      source: "occurrences-page-src",
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

// ---------------------------------------------------------------------------
// A calendar larger than any fixture worth writing to a database.
//
// The properties below only appear above tens of thousands of rows, and
// seeding that many real ones would cost minutes on a machine
// shared with CI to prove something about loops the rows play no part in.
// The route is still the thing under test: these drive `GET /occurrences`
// through the real handler, so reinstating a scan ceiling, moving the
// occurrence check back after the loops, or taking the yield out of the
// expansion loop each fails a behavioral assertion rather than a compile.
// ---------------------------------------------------------------------------

const SYNTHETIC_FROM = "2026-06-01T00:00:00Z";
const SYNTHETIC_TO = "2026-06-08T00:00:00Z";

interface SyntheticRow {
  id: string;
  properties: Record<string, unknown>;
}

interface SyntheticCalendar {
  storage: Storage;
  /** Ids handed to `items.getMany`. A refusal should reach none of them. */
  fetched: string[];
}

function syntheticRow(row: SyntheticRow): Item {
  return {
    id: row.id,
    type: "core.event",
    state: "active",
    // Not `connector:`-prefixed, so the orphan resolver answers from the
    // rows themselves and this storage needs no connection surface.
    source: "synthetic",
    properties: row.properties,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as unknown as Item;
}

/**
 * A storage serving the given rows, page by page, through the same three
 * narrowings the route asks for.
 *
 * `parents` maps an exception's id to the series it hangs under, which is
 * the whole of the edge surface this route reaches.
 */
function syntheticCalendar(
  rows: readonly SyntheticRow[],
  parents: ReadonlyMap<string, string> = new Map(),
  /** Ids the scan sees as active and the later fetch does not, which is
   *  the whole of the race between the two reads. */
  archivedOnFetch: ReadonlySet<string> = new Set(),
  /** Ids whose properties differ between the scan and the later fetch:
   *  a meeting moved while the request was in flight. The other half of
   *  the same race, and the one that renders rather than disappears. */
  movedOnFetch: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): SyntheticCalendar {
  const items = rows.map(syntheticRow);
  const byId = new Map(items.map((item) => [item.id, item]));
  const fetched: string[] = [];

  const matches = (item: Item, filters: ItemFilters): boolean => {
    if (filters.hasProperty !== undefined) {
      return item.properties[filters.hasProperty] !== undefined;
    }
    const startsAt = item.properties.starts_at;
    if (typeof startsAt !== "string") return false;
    if (filters.startsAtFrom !== undefined && startsAt < filters.startsAtFrom) {
      return false;
    }
    return !(
      filters.startsAtTo !== undefined && startsAt >= filters.startsAtTo
    );
  };

  // An edge from a superseded chunk answers a read by throwing. Retention
  // is not observable from outside, so the contract is asserted rather
  // than measured: consuming each chunk before asking for the next passes,
  // holding every chunk to read after the last does not.
  let openChunk = 0;
  const parentEdge = (seriesId: string, chunk: number): unknown => ({
    edge_type: "parent-of",
    get source_id(): string {
      if (chunk !== openChunk) {
        throw new Error(
          "an edge was read after the chunk it arrived in was superseded",
        );
      }
      return seriesId;
    },
  });

  const storage = {
    items: {
      list: (filters: ItemFilters) => {
        // Only the event type holds rows here.
        if (filters.type !== "core.event") {
          return Promise.resolve({ data: [], next_cursor: null });
        }
        const eligible = items.filter((item) => matches(item, filters));
        const offset =
          filters.cursor === undefined ? 0 : Number(filters.cursor);
        const end = Math.min(
          offset +
            Math.min(filters.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
          eligible.length,
        );
        return Promise.resolve({
          data: eligible.slice(offset, end),
          next_cursor: end < eligible.length ? String(end) : null,
        });
      },
      getMany: (ids: string[]) => {
        fetched.push(...ids);
        const out = new Map<string, Item>();
        for (const id of ids) {
          const item = byId.get(id);
          if (item === undefined) continue;
          // `getMany` excludes trashed rows and nothing else, so a row
          // that left `active` by any other transition still arrives.
          const moved = movedOnFetch.get(id);
          out.set(
            id,
            archivedOnFetch.has(id)
              ? ({ ...item, state: "archived" } as unknown as Item)
              : moved !== undefined
                ? { ...item, properties: { ...item.properties, ...moved } }
                : item,
          );
        }
        return Promise.resolve(out);
      },
    },
    edges: {
      listToTargetsBatched: (targetIds: string[]) => {
        openChunk += 1;
        const chunk = openChunk;
        const out = new Map<string, unknown[]>();
        for (const id of targetIds) {
          const seriesId = parents.get(id);
          if (seriesId !== undefined)
            out.set(id, [parentEdge(seriesId, chunk)]);
        }
        return Promise.resolve(out);
      },
    },
  } as unknown as Storage;

  return { storage, fetched };
}

/**
 * The real route over a synthetic storage.
 *
 * The error handler is the app's own, so a `MarfaError` lands on the wire
 * as its own status rather than as a 500, and the auth middleware is stood
 * in for: what is under test is the read, not the caller.
 */
function appOver(
  storage: Storage,
  /** Stands in for `MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS`. Reaching
   *  that ceiling means walking it, and at the production value that is
   *  six seconds per test on a box that also runs CI. */
  maxUnproductiveIterations?: number,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key-under-test",
      is_operator: true,
      // The maps are the whole of this key's reach, so they carry it.
      type_permissions: { "*": "write" },
      extension_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      metadata_permissions: { "*": "write" },
    } as never);
    c.set("clientIp", null as never);
    await next();
  });
  app.route(
    "/occurrences",
    occurrenceRoutes(
      storage,
      maxUnproductiveIterations === undefined
        ? {}
        : { maxUnproductiveIterations },
    ),
  );
  return app;
}

async function readWindow(
  app: OpenAPIHono<AppEnv>,
  from = SYNTHETIC_FROM,
  to = SYNTHETIC_TO,
  type?: string,
): Promise<Response> {
  return await app.request(
    `/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
      (type === undefined ? "" : `&type=${encodeURIComponent(type)}`),
  );
}

describe("GET /occurrences over rule-bearing rows a hundred pages deep", () => {
  // No total of rule-bearing rows refuses the read. A refusal at a row
  // total could not be recovered from: the one move a caller knows is to
  // ask for a narrower window, and the window has no bearing on how many
  // rows carry a rule. There is no bound to sit past, so the size is a
  // walk of a hundred pages at the clamp the route reads the store by.
  const MANY_SERIES = 100 * MAX_PAGE_LIMIT;

  it("serves the window rather than refusing the read", async () => {
    const rows: SyntheticRow[] = [];
    for (let i = 0; i < MANY_SERIES; i += 1) {
      rows.push({
        id: `series-${String(i)}`,
        properties: {
          title: `ended series ${String(i)}`,
          // A rule that ran once, years before the window: read and
          // expanded like every other, contributing nothing to the answer.
          starts_at: "2019-03-04T09:00:00.000Z",
          recurrence: ["RRULE:FREQ=YEARLY;COUNT=1"],
        },
      });
    }
    for (let i = 0; i < 3; i += 1) {
      rows.push({
        id: `standalone-${String(i)}`,
        properties: {
          title: `meeting ${String(i)}`,
          starts_at: `2026-06-0${String(i + 2)}T09:00:00.000Z`,
          ends_at: `2026-06-0${String(i + 2)}T10:00:00.000Z`,
        },
      });
    }

    const res = await readWindow(appOver(syntheticCalendar(rows).storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      scan: { events_read: number };
    };
    // The three meetings actually in the window, found behind every
    // rule-bearing row a ceiling would have refused the read over.
    expect(body.data.map((r) => r.item.properties.title)).toEqual([
      "meeting 0",
      "meeting 1",
      "meeting 2",
    ]);
    // Every rule-bearing row was read, and the count is on the response so
    // the size of the read is visible rather than merely survived.
    expect(body.scan.events_read).toBeGreaterThan(MANY_SERIES);
  });
});

describe("the occurrence ceiling stops the assembly", () => {
  // Four times the ceiling. The number matters: it is what `found` would
  // report if the check ran after both loops instead of inside them.
  const IN_WINDOW = 20_000;

  function crowdedWindow(): SyntheticCalendar {
    const rows: SyntheticRow[] = [];
    for (let i = 0; i < IN_WINDOW; i += 1) {
      rows.push({
        id: `crowd-${String(i)}`,
        properties: {
          title: `crowded ${String(i)}`,
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      });
    }
    return syntheticCalendar(rows);
  }

  it("refuses on the occurrence that crosses it, not on the last one", async () => {
    const calendar = crowdedWindow();
    const res = await readWindow(appOver(calendar.storage));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { max_occurrences?: number; found?: number } };
    };
    expect(body.error.details?.max_occurrences).toBe(5000);
    // The bound has to fail toward something bounded. Assembling all
    // twenty thousand in order to report the total would make the refusal
    // cost more than the read it is refusing, so `found` is the count the
    // assembly stopped at.
    expect(body.error.details?.found).toBe(5001);
    // And no row was fetched to build an answer that was never returned.
    expect(calendar.fetched).toHaveLength(0);
  });

  it("refuses a series that floods the window on the same terms", async () => {
    // The other loop. Two hourly rules over a week are 336 occurrences,
    // so the flood has to come from the series count rather than the rule.
    const rows: SyntheticRow[] = [];
    for (let i = 0; i < 6_000; i += 1) {
      rows.push({
        id: `daily-${String(i)}`,
        properties: {
          title: `daily ${String(i)}`,
          starts_at: "2026-06-01T09:00:00.000Z",
          recurrence: ["RRULE:FREQ=DAILY;COUNT=1"],
        },
      });
    }
    const calendar = syntheticCalendar(rows);
    const res = await readWindow(appOver(calendar.storage));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { found?: number } };
    };
    expect(body.error.details?.found).toBe(5001);
    expect(calendar.fetched).toHaveLength(0);
  });

  it("still serves a window that sits under the ceiling", async () => {
    const rows: SyntheticRow[] = [];
    for (let i = 0; i < 4_000; i += 1) {
      rows.push({
        id: `roomy-${String(i)}`,
        properties: {
          title: `roomy ${String(i)}`,
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      });
    }
    const res = await readWindow(appOver(syntheticCalendar(rows).storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      scan: { occurrences: number };
    };
    expect(body.data).toHaveLength(4_000);
    expect(body.scan.occurrences).toBe(4_000);
  });
});

/** Event-loop turns taken while one window read runs. */
async function turnsDuring(rows: readonly SyntheticRow[]): Promise<number> {
  // Nothing in this request reaches a macrotask on its own: the
  // synthetic storage resolves already-settled promises, which drain as
  // microtasks. So a callback queued on the loop runs during the request
  // only where the route hands the loop back.
  let turns = 0;
  let observing = true;
  const observe = (): void => {
    if (!observing) return;
    turns += 1;
    setImmediate(observe);
  };
  setImmediate(observe);
  const res = await readWindow(appOver(syntheticCalendar(rows).storage));
  observing = false;
  expect(res.status).toBe(200);
  return turns;
}

describe("the expansion loop yields", () => {
  it("takes more turns than walking the same rows costs on its own", async () => {
    // Both loops yield, so the page walk alone already takes a few turns.
    // The calibration is the same row count with no rule on it: it walks
    // the same number of pages and expands nothing, so the difference is
    // the expansion loop's own yielding and nothing else. Without it the
    // two counts are the same, which is a synchronous walk over every
    // stored rule with every other request on the process behind it.
    const COUNT = 1_000;
    const rules: SyntheticRow[] = [];
    const plain: SyntheticRow[] = [];
    for (let i = 0; i < COUNT; i += 1) {
      rules.push({
        id: `series-${String(i)}`,
        properties: {
          title: `series ${String(i)}`,
          starts_at: "2019-03-04T09:00:00.000Z",
          recurrence: ["RRULE:FREQ=YEARLY;COUNT=1"],
        },
      });
      plain.push({
        id: `plain-${String(i)}`,
        properties: {
          title: `plain ${String(i)}`,
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      });
    }

    const walkOnly = await turnsDuring(plain);
    const walkAndExpand = await turnsDuring(rules);
    expect(walkAndExpand).toBeGreaterThan(walkOnly * 2);
  });
});

describe("the expansion loop is paced by work, not by series count", () => {
  /**
   * Under `SERIES_PER_YIELD` series, so the series budget can never
   * trip; the difference between the two fixtures is entirely how many
   * rule iterations they walk.
   *
   * This is the shape the series-only pacing missed. One `COUNT=1` rule
   * and one that walks five thousand iterations are the same number of
   * series and differ by three orders of magnitude in CPU, so a budget
   * denominated in series permitted an arbitrarily long uninterrupted
   * stretch and reported itself as bounded.
   */
  const UNDER_THE_SERIES_BUDGET = 30;

  /** Minutes before the window, so the rule terminates on its own COUNT
   *  having contributed nothing: pure pre-window walking, which is
   *  exactly what a long-lived frequent rule costs on every read. */
  function walking(iterationsEach: number): SyntheticRow[] {
    return Array.from({ length: UNDER_THE_SERIES_BUDGET }, (_, i) => ({
      id: `walker-${String(i)}`,
      properties: {
        title: `walker ${String(i)}`,
        starts_at: "2019-03-04T09:00:00.000Z",
        recurrence: [`RRULE:FREQ=MINUTELY;COUNT=${String(iterationsEach)}`],
      },
    }));
  }

  it("hands the loop back for rules that walk, not only for many rules", async () => {
    // 30 x 5,000 = 150,000 iterations against a 20,000 budget, so the
    // loop is expected to pause several times over.
    const heavy = await turnsDuring(walking(5_000));
    // The same 30 series and the same single page, walking one iteration
    // each. Nothing here should pause at all, which is what makes the
    // comparison attributable to the iterations and nothing else.
    const light = await turnsDuring(walking(1));
    expect(light).toBeLessThanOrEqual(2);
    expect(heavy).toBeGreaterThanOrEqual(light + 5);
  });
});

describe("the reported expansion failures are bounded", () => {
  // `MAX_OCCURRENCES` structurally cannot bound this array: a series that
  // fails to expand emits no occurrence, so every other ceiling here can
  // sit at zero while this one grows with the corpus.
  function broken(count: number): SyntheticRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `broken-${String(i)}`,
      properties: {
        title: `broken ${String(i)}`,
        starts_at: "2025-06-01T09:00:00.000Z",
        recurrence: ["RRULE:FREQ=NOPE;INTERVAL=x"],
      },
    }));
  }

  it("lists every failure on an instance sitting on the cap", async () => {
    const res = await readWindow(
      appOver(syntheticCalendar(broken(500)).storage),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series_errors?: { item_id: string; message: string }[];
      series_errors_truncated?: boolean;
      scan: { series_errors: number; max_series_errors: number };
    };
    expect(body.series_errors).toHaveLength(500);
    expect(body.scan.series_errors).toBe(500);
    expect(body.scan.max_series_errors).toBe(500);
    // A full list is not a truncated one, and must not claim to be.
    expect(body.series_errors_truncated).toBeUndefined();
  });

  it("caps the list and says so rather than refusing the calendar", async () => {
    // The whole point of trimming here rather than refusing: the healthy
    // series here expanded perfectly well, and an instance with 501
    // broken rules getting no calendar at all would be a fail-closed
    // ceiling on the whole read, which this route does not have.
    const rows = [
      ...broken(50_000),
      {
        id: "healthy",
        properties: {
          title: "a meeting that still works",
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      },
    ];
    const res = await readWindow(appOver(syntheticCalendar(rows).storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      series_errors?: { item_id: string; message: string }[];
      series_errors_truncated?: boolean;
      scan: { series_errors: number };
    };
    // The calendar still answers the question it was asked.
    expect(body.data.map((r) => r.item.properties.title)).toEqual([
      "a meeting that still works",
    ]);
    // The list is capped, the response says the list is capped, and the
    // true count is reported so 50,000 is distinguishable from 501.
    expect(body.series_errors).toHaveLength(500);
    expect(body.series_errors_truncated).toBe(true);
    expect(body.scan.series_errors).toBe(50_000);
  });

  it("holds the response down while unparsable rules grow without limit", async () => {
    // The retention argument the cap exists for, which trimming rather
    // than refusing does not weaken: accumulation still stops at 500
    // however many rules are broken. Measured at 4.8 MB before the cap.
    //
    // Scoped to the cheapest failure there is — `FREQ=NOPE` fails in the
    // parser, before a single rule iteration. It pins bytes and nothing
    // else, which is all a fixture this cheap can pin. The expensive
    // class, where a rule fails only after walking its cap, is pinned by
    // the expansion-budget suite below, because bytes were never what
    // made that shape dangerous.
    const res = await readWindow(
      appOver(syntheticCalendar(broken(25_000)).storage),
    );
    expect(res.status).toBe(200);
    const bytes = Buffer.byteLength(await res.text(), "utf8");
    expect(bytes).toBeLessThan(500_000);
  });

  it("bounds one message as well as the count", async () => {
    // A count alone does not bound bytes. The malformed-rule message
    // carries the parser's own text, which is as long as whatever it was
    // handed, so an instance of a few hundred broken rules could still build
    // a response nobody can hold.
    const long = "X".repeat(4_000);
    const res = await readWindow(
      appOver(
        syntheticCalendar([
          {
            id: "verbose",
            properties: {
              title: "verbose failure",
              starts_at: "2025-06-01T09:00:00.000Z",
              recurrence: [`RRULE:FREQ=DAILY;BYDAY=${long}`],
            },
          },
        ]).storage,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series_errors?: { item_id: string; message: string }[];
    };
    const [failure] = body.series_errors ?? [];
    expect(failure).toBeDefined();
    expect(failure?.message.length).toBeLessThan(long.length);
  });
});

describe("the reported failures are scoped to what the request read", () => {
  // A limit being pinned, because the field reads like an instance-wide
  // health check and is not one. A request narrowed by `type` reads that
  // type's rules and counts that type's failures, and a credential not
  // permitted the event type is in the same position permanently. Counting
  // what it did not read would mean scanning it, the cost the narrowing
  // exists to avoid, and reporting rows behind a permission the caller does
  // not hold.
  it("counts nothing for a type it did not read", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({
      id: `broken-${String(i)}`,
      properties: {
        title: `broken ${String(i)}`,
        starts_at: "2025-06-01T09:00:00.000Z",
        recurrence: ["RRULE:FREQ=NOPE;INTERVAL=x"],
      },
    }));
    const app = appOver(syntheticCalendar(rows).storage);

    const read = await readWindow(app);
    expect(
      ((await read.json()) as { scan: { series_errors: number } }).scan
        .series_errors,
    ).toBe(600);

    // The same instance, narrowed to a type this route does not read. Zero
    // here is true of what was read and says nothing about the 600 rules
    // alongside it, which is exactly what the field's description claims
    // and no more.
    const narrowed = await readWindow(
      app,
      SYNTHETIC_FROM,
      SYNTHETIC_TO,
      "core.note",
    );
    expect(narrowed.status).toBe(200);
    const body = (await narrowed.json()) as {
      series_errors?: unknown[];
      series_errors_truncated?: boolean;
      scan: { series_errors: number };
    };
    expect(body.scan.series_errors).toBe(0);
    expect(body.series_errors).toBeUndefined();
    expect(body.series_errors_truncated).toBeUndefined();
  });
});

describe("the occurrence ceiling and the broken-rule cap compose", () => {
  it("refuses an over-full window on an instance whose rules are broken", async () => {
    // Broken rules on their own are not among the reads the 400 refuses,
    // but this instance holds both: the ceiling counts what the healthy
    // rows produce and is indifferent to how many rules failed beside
    // them.
    const rows = [
      ...Array.from({ length: 600 }, (_, i) => ({
        id: `broken-${String(i)}`,
        properties: {
          title: `broken ${String(i)}`,
          starts_at: "2025-06-01T09:00:00.000Z",
          recurrence: ["RRULE:FREQ=NOPE;INTERVAL=x"],
        },
      })),
      ...Array.from({ length: 6_000 }, (_, i) => ({
        id: `plain-${String(i)}`,
        properties: {
          title: `plain ${String(i)}`,
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      })),
    ];
    const res = await readWindow(appOver(syntheticCalendar(rows).storage));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { max_occurrences?: number } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.max_occurrences).toBe(5_000);
  });
});

describe("the expansion budget bounds the walking that contributes nothing", () => {
  /**
   * A tenth of the production ceiling, handed to the route.
   *
   * Reaching a ceiling denominated in rule iterations means walking
   * them, which at the production value costs seconds a test. Every
   * assertion below is written against whatever value is in force — the
   * overshoot, the count left unexpanded, what the refusal carries — so a
   * tenth exercises the same code and the same arithmetic at a tenth of
   * the cost, and the production number is pinned by the equality below.
   */
  const BUDGET = MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS / 10;

  it("is two million iterations unless a caller says otherwise", () => {
    expect(MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS).toBe(2_000_000);
  });

  /**
   * Rules that walk their whole per-series iteration cap and contribute
   * nothing: per-minute from years before the window, so each one
   * reaches `MAX_EXPANSION_ITERATIONS` long before it reaches the
   * window and fails there.
   *
   * The expensive class, and the one refusing at the 501st failure used
   * to bound by accident. Measured through the route at about 340 ms of
   * CPU each, which is where "50,000 of them is hours" comes from.
   */
  function walkers(count: number): SyntheticRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `walker-${String(i)}`,
      properties: {
        title: `walker ${String(i)}`,
        starts_at: "2019-03-04T09:00:00.000Z",
        recurrence: ["RRULE:FREQ=MINUTELY"],
      },
    }));
  }

  /** How many walkers it takes to fill the budget, plus a few the
   *  request must therefore never reach. */
  const TO_FILL = Math.ceil(BUDGET / 100_000);

  it("stops expanding rather than walking every stored rule", async () => {
    const rows = [
      ...walkers(TO_FILL + 5),
      {
        id: "healthy",
        properties: {
          title: "a meeting that still works",
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      },
    ];
    const res = await readWindow(
      appOver(syntheticCalendar(rows).storage, BUDGET),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      expansion_incomplete?: boolean;
      scan: {
        unproductive_iterations: number;
        max_unproductive_iterations: number;
        series_unexpanded: number;
        series_errors: number;
      };
    };

    // Stopped, and stopped within one expansion of the budget: a single
    // `expandSeries` call is atomic, so the last one admitted can always
    // carry the total past the ceiling and no further.
    expect(body.scan.unproductive_iterations).toBeGreaterThanOrEqual(BUDGET);
    expect(body.scan.unproductive_iterations).toBeLessThan(BUDGET + 100_001);
    // The ceiling in force is the one reported, so a caller reading the
    // response is never comparing against a number the route is not
    // using.
    expect(body.scan.max_unproductive_iterations).toBe(BUDGET);
    // The five past the ceiling were never walked, and the response says
    // so rather than stopping quietly. A calendar that is missing part
    // of itself and does not admit it is the failure this whole file is
    // organized around.
    expect(body.scan.series_unexpanded).toBe(5);
    expect(body.expansion_incomplete).toBe(true);
    // Only the ones actually walked are reported as failures, which is
    // what makes the two numbers say different things.
    expect(body.scan.series_errors).toBe(TO_FILL);
    // The stop is on the expansion, not on the calendar: the window pass
    // still runs and its meetings still render.
    expect(body.data.map((r) => r.item.properties.title)).toEqual([
      "a meeting that still works",
    ]);
    // And the same fixture keeps the response small, which the cheap
    // byte test above cannot speak for.
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThan(
      500_000,
    );
  });

  it("charges nothing to series that produce occurrences", async () => {
    // The property that makes the ceiling safe to have at all. These
    // rules walk seven years of history before they reach the window —
    // real work, and more of it than a short rule costs — but each one
    // contributes, so none of it is charged. A budget over all
    // iterations would be spent fastest by the calendar with the most
    // meetings in it, and would then truncate that calendar.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `daily-${String(i)}`,
      properties: {
        title: `daily ${String(i)}`,
        starts_at: "2019-03-04T09:00:00.000Z",
        recurrence: ["RRULE:FREQ=DAILY"],
      },
    }));
    const res = await readWindow(appOver(syntheticCalendar(rows).storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      expansion_incomplete?: boolean;
      scan: { unproductive_iterations: number; series_unexpanded: number };
    };
    // Seven days of window, thirty rules, every occurrence present.
    expect(body.data).toHaveLength(30 * 7);
    expect(body.scan.unproductive_iterations).toBe(0);
    expect(body.scan.series_unexpanded).toBe(0);
    expect(body.expansion_incomplete).toBeUndefined();
  });

  it("charges nothing to an unreadable rule, which never iterates", async () => {
    // The counter is credited from the expansion's iteration count, and
    // a rule that fails in the parser has not iterated. Five hundred of
    // them are five hundred reported failures and a budget still at
    // zero, which is what the field's description says. Cheap in
    // practice, since a failed parse is microseconds, so this holds the
    // description to the code rather than closing a hole.
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `unparsable-${String(i)}`,
      properties: {
        title: `unparsable ${String(i)}`,
        starts_at: "2025-06-01T09:00:00.000Z",
        recurrence: ["RRULE:FREQ=NOPE;INTERVAL=x"],
      },
    }));
    const res = await readWindow(appOver(syntheticCalendar(rows).storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scan: { series_errors: number; unproductive_iterations: number };
    };
    expect(body.scan.series_errors).toBe(500);
    expect(body.scan.unproductive_iterations).toBe(0);
  });

  it("charges a series that produced occurrences and had them discarded", async () => {
    // The other direction, and the one an audit asking "what charges
    // zero unexpectedly" walks straight past. A rule flooding the window
    // is refused by `MAX_OCCURRENCES_PER_SERIES` — a third ceiling —
    // after producing two thousand occurrences, and the refusal throws
    // them away. `expanded` is empty after any throw, so the walk is
    // charged.
    //
    // Charging it is right: none of that reached `data` and the walk is
    // spent either way. The counter covers series that contributed no
    // occurrence, not series that produced none.
    const res = await readWindow(
      appOver(
        syntheticCalendar([
          {
            id: "flooder",
            properties: {
              title: "every minute, all week",
              starts_at: SYNTHETIC_FROM,
              recurrence: ["RRULE:FREQ=MINUTELY"],
            },
          },
        ]).storage,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      series_errors?: { item_id: string; message: string }[];
      scan: { series_errors: number; unproductive_iterations: number };
    };
    // Two thousand produced, none contributed.
    expect(body.data).toHaveLength(0);
    expect(body.scan.series_errors).toBe(1);
    expect(body.series_errors?.[0]?.message).toContain("occurrences");
    // One iteration past the per-series occurrence ceiling, exactly.
    expect(body.scan.unproductive_iterations).toBe(2_001);
  });

  it("charges nothing for walking that a caller can count exactly", async () => {
    // The hole in the ceiling, exhibited. Both fixtures are a hundred
    // daily rules contributing seven occurrences each, so both are
    // charged nothing; they differ only in how far they walk to reach
    // the window. A decade-old rule that is still running walks its
    // whole history on every read, which is the ordinary shape of a
    // long-lived calendar rather than a contrived one.
    //
    // No test fails when prose overstates the budget as a bound on a
    // request's total work. This one holds a counterexample in the exact
    // unit the bound is denominated in, so a reader who doubts the claim
    // has a number to cite rather than a stopwatch to argue about.
    const daily = (anchor: string, prefix: string): SyntheticRow[] =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `${prefix}-${String(i)}`,
        properties: {
          title: `${prefix} ${String(i)}`,
          starts_at: anchor,
          recurrence: ["RRULE:FREQ=DAILY"],
        },
      }));

    // Ten years of history before the window.
    const far = daily("2016-06-01T09:00:00.000Z", "far");
    // The same rules, anchored the day before it.
    const near = daily("2026-05-31T09:00:00.000Z", "near");

    const charged = async (rows: SyntheticRow[]): Promise<number> => {
      const res = await readWindow(appOver(syntheticCalendar(rows).storage));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: OccurrenceRow[];
        expansion_incomplete?: boolean;
        scan: { unproductive_iterations: number };
      };
      // Same calendar either way: a hundred rules, seven days.
      expect(body.data).toHaveLength(700);
      expect(body.expansion_incomplete).toBeUndefined();
      return body.scan.unproductive_iterations;
    };

    expect(await charged(far)).toBe(0);
    expect(await charged(near)).toBe(0);

    // What the budget saw none of, in its own unit. `expandSeries`
    // accumulates iterations for exactly this purpose and is
    // deterministic, so these are equalities rather than a wall clock
    // and a ratio that a loaded machine can move.
    const walked = (rows: SyntheticRow[]): number => {
      const work: ExpansionWork = { iterations: 0 };
      for (const row of rows) {
        const series: RecurrenceSeries = {
          id: row.id,
          starts_at: row.properties.starts_at as string,
          recurrence: row.properties.recurrence as string[],
        };
        expandSeries(
          series,
          new Date(SYNTHETIC_FROM),
          new Date(SYNTHETIC_TO),
          [],
          work,
        );
      }
      return work.iterations;
    };

    expect(walked(far)).toBe(366_000);
    expect(walked(near)).toBe(900);
  });

  it("says on the refusal that expansion was already truncated", async () => {
    // The two ceilings compose, and the advice differs. Expansion spends
    // its budget on rules that contribute nothing, the window pass then
    // crosses the occurrence ceiling, and the caller is told to narrow
    // the window — which returns a calendar already missing whatever the
    // unexpanded series held. Without this the caller learns that only
    // by comparing two responses, and only if they thought to.
    const rows = [
      ...walkers(TO_FILL + 5),
      ...Array.from({ length: 6_000 }, (_, i) => ({
        id: `plain-${String(i)}`,
        properties: {
          title: `plain ${String(i)}`,
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      })),
    ];
    const res = await readWindow(
      appOver(syntheticCalendar(rows).storage, BUDGET),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: {
          max_occurrences?: number;
          expansion_incomplete?: boolean;
          series_unexpanded?: number;
        };
      };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.max_occurrences).toBe(5_000);
    expect(body.error.details?.expansion_incomplete).toBe(true);
    expect(body.error.details?.series_unexpanded).toBe(5);
  });
});

describe("a row's time and the item it renders cannot disagree", () => {
  // The scan projects a time, the item is fetched at the end, and the
  // yields in between widen that gap from microseconds to the length of
  // the whole request. A meeting moved inside that gap could render the
  // slot the scan saw beside the item's new `starts_at`, in one object, so
  // a row takes its time from the item it renders.
  it("shows a standalone row at the time its own item carries", async () => {
    const calendar = syntheticCalendar(
      [
        {
          id: "moved",
          properties: {
            title: "moved while the request was in flight",
            starts_at: "2026-06-03T09:00:00.000Z",
            ends_at: "2026-06-03T10:00:00.000Z",
          },
        },
      ],
      new Map(),
      new Set(),
      new Map([
        [
          "moved",
          {
            starts_at: "2026-06-03T14:30:00.000Z",
            ends_at: "2026-06-03T15:30:00.000Z",
          },
        ],
      ]),
    );
    const res = await readWindow(appOver(calendar.storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { starts_at: string; ends_at?: string; item: Item }[];
    };
    const [row] = body.data;
    expect(row?.starts_at).toBe("2026-06-03T14:30:00.000Z");
    expect(row?.ends_at).toBe("2026-06-03T15:30:00.000Z");
    // The whole point: the two halves of the row agree.
    expect(row?.item.properties.starts_at).toBe(row?.starts_at);
  });

  it("shows a row moved out of the window at its new time, not its old slot", async () => {
    // The direction chosen deliberately, so changing it has to be
    // deliberate too. The window selects which rows appear; it does not
    // constrain what time they are shown at. That is already how
    // `replaces` behaves — a stored exception moved outside the window is
    // shown at its own time rather than dropped — and a standalone row
    // that moved is the same question with the same answer.
    //
    // The alternative is to re-check the window after the fetch and drop
    // the row, which loses a meeting that exists in order to honor a
    // filter that was already applied when it was selected.
    const calendar = syntheticCalendar(
      [
        {
          id: "escaped",
          properties: {
            title: "moved clean out of the window",
            starts_at: "2026-06-03T09:00:00.000Z",
          },
        },
      ],
      new Map(),
      new Set(),
      // A month past SYNTHETIC_TO, so no reading of the window contains it.
      new Map([["escaped", { starts_at: "2026-07-15T09:00:00.000Z" }]]),
    );
    const res = await readWindow(appOver(calendar.storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { starts_at: string; item: Item }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.starts_at).toBe("2026-07-15T09:00:00.000Z");
    // Still the property that matters: the two halves of the row agree.
    expect(body.data[0]?.item.properties.starts_at).toBe(
      body.data[0]?.starts_at,
    );
  });

  it("shows a computed series occurrence at the slot the rule produced", async () => {
    // The exemption, and the reason the rule is "the item is the
    // authority for its own times" rather than "always re-read": the item
    // here is the series, and its `starts_at` is the rule's anchor rather
    // than this slot. Re-deriving would collapse every occurrence onto
    // the anchor.
    const res = await readWindow(
      appOver(
        syntheticCalendar([
          {
            id: "weekly",
            properties: {
              title: "weekly stand-up",
              starts_at: "2026-06-01T09:00:00.000Z",
              recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
            },
          },
        ]).storage,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { starts_at: string; series_id?: string; item: Item }[];
    };
    expect(body.data.map((r) => r.starts_at)).toEqual([
      "2026-06-01T09:00:00.000Z",
    ]);
    expect(body.data[0]?.series_id).toBe("weekly");
  });
});

describe("an item that leaves `active` mid-request", () => {
  it("is dropped rather than rendered in a state this route never emits", async () => {
    // The scans select on `state: "active"` and the item read that
    // follows them does not, so between the two an archived row would
    // otherwise come back inside a 200 carrying a state no occurrence has
    // ever had.
    const rows: SyntheticRow[] = [
      {
        id: "stays",
        properties: {
          title: "still on the calendar",
          starts_at: "2026-06-03T09:00:00.000Z",
        },
      },
      {
        id: "archived",
        properties: {
          title: "filed away mid-request",
          starts_at: "2026-06-04T09:00:00.000Z",
        },
      },
    ];
    const calendar = syntheticCalendar(rows, new Map(), new Set(["archived"]));
    const res = await readWindow(appOver(calendar.storage));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: OccurrenceRow[];
      scan: { occurrences: number };
    };
    expect(body.data.map((r) => r.item.id)).toEqual(["stays"]);
    // And the count on the response agrees with what was returned.
    expect(body.scan.occurrences).toBe(1);
  });
});

describe("the exception edges are consumed a chunk at a time", () => {
  it("reads an edge before the next chunk supersedes it", async () => {
    // Past `ID_BATCH_SIZE`, so the edges arrive in several chunks. Holding
    // them all to read after the last is what this fixture refuses, and it
    // is what returning the edges rather than the grouping would require.
    const rows: SyntheticRow[] = [
      {
        id: "series",
        properties: {
          title: "the standup",
          starts_at: "2026-06-01T09:00:00.000Z",
          ends_at: "2026-06-01T09:15:00.000Z",
          recurrence: ["RRULE:FREQ=DAILY"],
        },
      },
    ];
    const parents = new Map<string, string>();
    // One moved instance inside the window, and a long tail of instances
    // moved years ago — the ordinary shape of a series somebody has been
    // rescheduling for a while.
    rows.push({
      id: "moved",
      properties: {
        title: "the standup, moved",
        starts_at: "2026-06-03T15:00:00.000Z",
        original_starts_at: "2026-06-03T09:00:00.000Z",
      },
    });
    parents.set("moved", "series");
    for (let i = 0; i < 1_200; i += 1) {
      const id = `stale-${String(i)}`;
      rows.push({
        id,
        properties: {
          title: `moved long ago ${String(i)}`,
          starts_at: "2019-03-04T09:00:00.000Z",
          original_starts_at: "2019-03-04T09:00:00.000Z",
        },
      });
      parents.set(id, "series");
    }

    const res = await readWindow(
      appOver(syntheticCalendar(rows, parents).storage),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: OccurrenceRow[] };
    const replacement = body.data.find((r) => r.replaces !== undefined);
    // The grouping survived the chunking: the moved instance shadows the
    // computed one and shows at its own time.
    expect(replacement?.starts_at).toBe("2026-06-03T15:00:00.000Z");
    expect(replacement?.replaces).toBe("2026-06-03T09:00:00.000Z");
    expect(
      body.data.filter((r) => r.starts_at === "2026-06-03T09:00:00.000Z"),
    ).toHaveLength(0);
  });
});

describe("the unwindowed scan", () => {
  it("keeps the expansion's input rather than the row", async () => {
    // The property that makes an unbounded walk affordable, and the one a
    // regression would quietly undo: accumulating rows instead still
    // returns the right answer, just at kilobytes each instead of a couple
    // of hundred bytes. Nothing else would notice.
    const rows: SyntheticRow[] = [];
    for (let i = 0; i < 3; i += 1) {
      rows.push({
        id: `series-${String(i)}`,
        properties: {
          title: `synthetic ${String(i)}`,
          starts_at: "2026-06-01T09:00:00.000Z",
          ends_at: "2026-06-01T09:30:00.000Z",
          timezone: "Europe/London",
          recurrence: ["RRULE:FREQ=WEEKLY"],
          // Stands in for the blob a mirrored event really carries, which
          // is what makes retaining rows rather than projections expensive.
          description: "x".repeat(2048),
        },
      });
    }
    const seeds = await gatherSeriesSeeds(syntheticCalendar(rows).storage, [
      "core.event",
    ]);
    expect(seeds).toHaveLength(3);
    expect(Object.keys(seeds[0] ?? {}).sort()).toEqual([
      "ends_at",
      "id",
      "recurrence",
      "starts_at",
      "timezone",
    ]);
    expect(seeds[0]).not.toHaveProperty("properties");
  });

  it("reads the fixture's own series against real storage", async () => {
    // The synthetic storages above prove the loops; this proves they are
    // wired to a real store with a real narrowing behind them.
    const seeds = await gatherSeriesSeeds(ctx.storage, ["core.event"]);
    expect(seeds.length).toBeGreaterThanOrEqual(2);
    expect(seeds.every((seed) => seed.recurrence.length > 0)).toBe(true);
  });
});
