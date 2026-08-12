/**
 * "What is on my calendar next Tuesday."
 *
 * A recurring series is one item carrying its rule, so a plain item list
 * answers that question with the first occurrence and nothing else. This
 * route asks it properly: over the window the caller names, it returns
 * the events that actually fall there — single events by their own
 * times, and recurring series expanded from their rules, with a stored
 * exception shadowing the occurrence it replaces.
 *
 * Nothing is materialized. The window is the bound that makes an
 * unbounded rule finite, so it is required, capped, and refused rather
 * than trimmed when a caller asks for more than the cap.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidTypePattern,
  matchesTypePattern,
} from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { ItemFilters, Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemSchema } from "./_schemas.js";
import {
  expandSeries,
  RecurrenceExpansionError,
} from "../events/expand-recurrence.js";
import type {
  Occurrence,
  RecurrenceException,
} from "../events/expand-recurrence.js";

/**
 * Longest window a caller may ask for. A calendar year plus a month of
 * slack covers "the year ahead" without letting one request expand a
 * decade of daily rules.
 */
export const MAX_WINDOW_DAYS = 400;

/** Ceiling on the assembled result, across every series in the window. */
export const MAX_OCCURRENCES = 5000;

/**
 * Rows read per page while gathering the events to expand.
 *
 * 200 because that is the storage layer's own ceiling — `items.list`
 * silently clamps any larger `limit`. This route previously asked for
 * 1000 and read one page, so it saw 200 events and reported the result
 * as the whole calendar: a space's 201st event simply was not on it.
 * Naming the real number here is what stops the next reader believing
 * the request.
 */
const EVENT_PAGE_SIZE = 200;

/**
 * Ceiling on how many event rows one request will read, across every
 * pass it makes.
 *
 * The window now narrows the standalone read in SQL: `starts_at_utc`
 * carries each stored time as a normalized instant, so a range over it
 * is a range over time. Two of the three passes still cannot be
 * windowed, and this is the backstop for those. A rule written in 2019
 * produces occurrences in 2026, so every series has to be considered
 * whatever the window is; an exception moved outside the window still
 * shadows the slot it left inside it. Both are read whole.
 *
 * It refuses rather than truncating, matching `MAX_OCCURRENCES`. Reading
 * one page and stopping is what this replaces: it returned 200 with an
 * incomplete calendar, which is the failure a person cannot see.
 */
export const MAX_EVENTS_SCANNED = 20000;

/**
 * Types whose items this route reads. Anything declaring the event
 * shape belongs here; `compatible_with` is what makes the Google type
 * readable through the same fields.
 */
const EVENT_TYPES = ["core.event", "google.calendar.event"] as const;

/** Rows read so far by one request, shared across its passes so the
 *  ceiling bounds the request rather than each pass separately. */
interface ScanBudget {
  scanned: number;
}

/** The storage-side narrowing one pass applies on top of type and state. */
type EventScanNarrowing = Pick<
  ItemFilters,
  "hasProperty" | "startsAtUtcFrom" | "startsAtUtcTo"
>;

/**
 * The active events of the named types that match one pass's narrowing,
 * walked page by page rather than one page deep.
 *
 * The ceiling is a parameter rather than a closed-over constant so it is
 * reachable: a backstop nothing can drive is a backstop nobody knows the
 * shape of, and the sibling `MAX_OCCURRENCES` cap sat untested for
 * exactly that reason. It refuses rather than trimming — the single-page
 * read this replaces answered 200 with a calendar missing whatever sat
 * past row 200, which is the failure a person cannot see.
 */
async function scanEvents(
  storage: Storage,
  spaceId: string | undefined,
  types: readonly string[],
  maxScanned: number,
  budget: ScanBudget,
  narrowing: EventScanNarrowing = {},
): Promise<Item[]> {
  const items: Item[] = [];
  for (const type of types) {
    let cursor: string | undefined;
    do {
      const page = await storage.items.list({
        spaceId,
        type,
        state: "active",
        limit: EVENT_PAGE_SIZE,
        ...narrowing,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      items.push(...page.data);
      budget.scanned += page.data.length;
      if (budget.scanned > maxScanned) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `This space holds more than ${String(maxScanned)} events; the calendar cannot be assembled in one read`,
          { max_events_scanned: maxScanned },
        );
      }
      cursor = page.has_more ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
  return items;
}

/**
 * Every active event of the named types in the space, unnarrowed.
 *
 * The unbounded walk the ceiling exists to bound, exposed so the ceiling
 * itself is reachable from a test.
 */
export async function gatherEventItems(
  storage: Storage,
  spaceId: string | undefined,
  types: readonly string[],
  maxScanned: number,
): Promise<Item[]> {
  return await scanEvents(storage, spaceId, types, maxScanned, { scanned: 0 });
}

const OccurrenceSchema = z.object({
  starts_at: z.string(),
  ends_at: z.string().optional(),
  item: ItemSchema,
  /** Present when this came from expanding a rule rather than from the
   *  item's own times. */
  series_id: z.string().optional(),
  /** Present when a stored exception replaced a computed occurrence;
   *  carries the start of the occurrence it replaced. */
  replaces: z.string().optional(),
});

const SeriesErrorSchema = z.object({
  item_id: z.string(),
  message: z.string(),
});

const OccurrencesResponseSchema = z.object({
  data: z.array(OccurrenceSchema),
  window: z.object({ from: z.string(), to: z.string() }),
  /** One entry per series that could not expand — a malformed rule, or
   *  a rule that floods the window. The rest of the calendar still
   *  returns; failing the whole read for one bad series would make a
   *  single six-year-old meeting take the calendar down. */
  series_errors: z.array(SeriesErrorSchema).optional(),
});

const occurrencesRoute = createRoute({
  operationId: "listOccurrences",
  method: "get",
  path: "/",
  tags: ["Items"],
  summary: "List event occurrences in a window",
  description:
    "Returns the events that fall inside a time window, expanding recurring series from their rules at read time rather than storing occurrences. Single events appear by their own times; a series contributes one entry per occurrence in the window, carrying `series_id`; a stored exception replaces the occurrence it was recorded against and carries `replaces`. The window is required and bounded — a request wider than the cap is refused rather than silently trimmed. A series that cannot expand (a malformed rule, or one that floods the window) is reported in `series_errors` while the rest of the calendar still returns.",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      from: z.string().describe("Window start, ISO 8601. Inclusive."),
      to: z.string().describe("Window end, ISO 8601. Exclusive."),
      type: z
        .string()
        .optional()
        .describe(
          "Restrict to one event type. Defaults to every event type the caller can read.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: OccurrencesResponseSchema },
      },
      description: "Occurrences in the window, ordered by start time",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Missing, unreadable, inverted, or over-long window",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

function readInstant(raw: string, field: string): Date {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `${field} is not a readable ISO 8601 timestamp`,
      { [field]: raw },
    );
  }
  return at;
}

function stringProp(item: Item, key: string): string | undefined {
  const value = item.properties[key];
  return typeof value === "string" ? value : undefined;
}

function recurrenceProp(item: Item): string[] {
  const value = item.properties.recurrence;
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is string => typeof line === "string");
}

/** Stored times may be offset-bearing; the response speaks ISO UTC
 *  throughout, not least because the final ordering compares the
 *  strings. An unreadable stored value falls back to the given one. */
function toInstantString(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? fallback : at.toISOString();
}

export function occurrenceRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(occurrencesRoute, async (c) => {
    requireAuth(c);
    const credential = c.get("apiKey");
    const spaceId = credential?.space_id;
    const query = c.req.valid("query");

    const from = readInstant(query.from, "from");
    const to = readInstant(query.to, "to");
    if (to <= from) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "The window's end must be after its start",
        { from: query.from, to: query.to },
      );
    }
    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (spanDays > MAX_WINDOW_DAYS) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `The window may span at most ${String(MAX_WINDOW_DAYS)} days; this one spans ${String(Math.ceil(spanDays))}`,
        { from: query.from, to: query.to, max_days: MAX_WINDOW_DAYS },
      );
    }
    if (query.type !== undefined && !isValidTypePattern(query.type)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    // The caller's own type permissions still decide what is readable;
    // this route narrows to event types on top of that rather than
    // instead of it.
    // `getTypeFilter` returns the credential's permission patterns, not
    // concrete type ids, so the narrowing has to go through the pattern
    // matcher rather than a membership test.
    const allowed = getTypeFilter(c);
    const wanted = (
      query.type !== undefined
        ? EVENT_TYPES.filter((t) => t === query.type)
        : EVENT_TYPES
    ).filter((t) => allowed === undefined || matchesTypePattern(t, allowed));
    if (wanted.length === 0) {
      return c.json(
        {
          data: [],
          window: { from: from.toISOString(), to: to.toISOString() },
        },
        200,
      );
    }

    // Three passes, because the calendar is three different questions
    // and only one of them is about the window.
    //
    // The ceiling is shared across all three: it bounds the request, not
    // each pass, so a space cannot slip past it by splitting its events
    // between them.
    const budget: ScanBudget = { scanned: 0 };

    // Series. Unwindowed by necessity — a rule written years ago
    // produces occurrences in any window, so the window says nothing
    // about which rules matter.
    const seriesItems = await scanEvents(
      storage,
      spaceId,
      wanted,
      MAX_EVENTS_SCANNED,
      budget,
      { hasProperty: "recurrence" },
    );

    // Exceptions. Unwindowed for the opposite reason — an exception
    // whose own time was moved outside the window still shadows the
    // occurrence it replaced inside it, so narrowing this pass would put
    // a ghost back on the calendar at a slot nobody is at.
    const exceptionItems = await scanEvents(
      storage,
      spaceId,
      wanted,
      MAX_EVENTS_SCANNED,
      budget,
      { hasProperty: "original_starts_at" },
    );

    // Standalone events, narrowed to the window in SQL against the
    // normalized instant column.
    const windowItems = await scanEvents(
      storage,
      spaceId,
      wanted,
      MAX_EVENTS_SCANNED,
      budget,
      {
        startsAtUtcFrom: from.toISOString(),
        startsAtUtcTo: to.toISOString(),
      },
    );

    // An exception names its series through parent-of, so the series is
    // resolved from the edge rather than from a property: the property
    // would be a second, drift-prone copy of the same fact.
    //
    // Batched, because the per-item form issued one query per exception
    // and an exception is an ordinary shape — a calendar where several
    // hundred meetings have each been moved once is a busy calendar, not
    // a pathological one.
    const exceptionsBySeries = new Map<string, RecurrenceException[]>();
    if (exceptionItems.length > 0) {
      const parentsByException = await storage.edges.listToTargetsBatched(
        exceptionItems.map((item) => item.id),
        // One parent is all a `parent-of` exception has; asking for a
        // second would only widen what a malformed graph could return.
        1,
      );
      for (const item of exceptionItems) {
        const originalStartsAt = stringProp(item, "original_starts_at");
        if (originalStartsAt === undefined) continue;
        const seriesId = (parentsByException.get(item.id) ?? []).find(
          (edge) => edge.edge_type === "parent-of",
        )?.source_id;
        if (seriesId === undefined) continue;
        const list = exceptionsBySeries.get(seriesId) ?? [];
        list.push({ id: item.id, original_starts_at: originalStartsAt });
        exceptionsBySeries.set(seriesId, list);
      }
    }

    // One row can answer more than one pass — a series whose own start
    // falls in the window is in the first and the third — so the three
    // results are folded into one map keyed on id. Everything below
    // reads a row through this, so nothing is expanded or shown twice.
    const byId = new Map<string, Item>();
    for (const item of [...seriesItems, ...exceptionItems, ...windowItems]) {
      byId.set(item.id, item);
    }
    const results: {
      starts_at: string;
      ends_at?: string;
      item: Item;
      series_id?: string;
      replaces?: string;
    }[] = [];
    const seriesErrors: { item_id: string; message: string }[] = [];
    // Exceptions an expansion actually consumed. Only these are hidden
    // from the standalone pass: an exception whose slot fell outside the
    // window, or whose series could not expand, still deserves to appear
    // at its own time rather than vanish.
    const consumedExceptions = new Set<string>();

    // Series first, standalone second, because only the expansion knows
    // which stored exceptions it consumed.
    const expandedSeries = new Set<string>();
    for (const item of seriesItems) {
      if (expandedSeries.has(item.id)) continue;
      expandedSeries.add(item.id);
      const recurrence = recurrenceProp(item);
      const startsAt = stringProp(item, "starts_at");
      if (recurrence.length === 0 || startsAt === undefined) continue;

      let expanded: Occurrence[];
      try {
        expanded = expandSeries(
          {
            id: item.id,
            starts_at: startsAt,
            ends_at: stringProp(item, "ends_at"),
            timezone: stringProp(item, "timezone"),
            recurrence,
          },
          from,
          to,
          exceptionsBySeries.get(item.id) ?? [],
        );
      } catch (err) {
        // One series that cannot expand degrades that series, never the
        // whole read: a calendar with one malformed rule is still a
        // calendar. Anything not the expander's own error type is a
        // genuine bug and stays loud.
        if (err instanceof RecurrenceExpansionError) {
          seriesErrors.push({ item_id: item.id, message: err.message });
          continue;
        }
        throw err;
      }
      for (const occurrence of expanded) {
        const shown = byId.get(occurrence.item_id);
        if (!shown) continue;
        if (occurrence.replaces !== undefined) {
          consumedExceptions.add(occurrence.item_id);
        }
        const shownEndsAt = stringProp(shown, "ends_at");
        results.push({
          // A replacement is shown at its own times, which is the
          // whole point of having moved it.
          starts_at:
            occurrence.replaces !== undefined
              ? toInstantString(
                  stringProp(shown, "starts_at"),
                  occurrence.starts_at,
                )
              : occurrence.starts_at,
          ...(occurrence.replaces !== undefined
            ? shownEndsAt !== undefined
              ? { ends_at: toInstantString(shownEndsAt, shownEndsAt) }
              : {}
            : occurrence.ends_at !== undefined
              ? { ends_at: occurrence.ends_at }
              : {}),
          item: shown,
          series_id: item.id,
          ...(occurrence.replaces !== undefined
            ? { replaces: occurrence.replaces }
            : {}),
        });
      }
    }

    const shownStandalone = new Set<string>();
    for (const item of windowItems) {
      if (shownStandalone.has(item.id)) continue;
      shownStandalone.add(item.id);

      // A row carrying a rule was already read and expanded by the first
      // pass; the window scan reaches it too, because a series' own
      // start is an ordinary start.
      if (recurrenceProp(item).length > 0) continue;

      // An exception an expansion consumed is already shown through its
      // series; showing it here too would double it.
      if (consumedExceptions.has(item.id)) continue;

      const startsAt = stringProp(item, "starts_at");
      if (startsAt === undefined) continue;
      const at = new Date(startsAt);
      // The SQL does the narrowing now. This stays as a belt: it is the
      // one place the normalized column and the stored value are read
      // against each other, so a column that ever disagreed with its row
      // shows up as a missing event rather than a wrong one.
      if (Number.isNaN(at.getTime()) || at < from || at >= to) continue;
      const endsAt = stringProp(item, "ends_at");
      results.push({
        starts_at: at.toISOString(),
        ...(endsAt !== undefined
          ? { ends_at: toInstantString(endsAt, endsAt) }
          : {}),
        item,
      });
    }

    if (results.length > MAX_OCCURRENCES) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `This window holds more than ${String(MAX_OCCURRENCES)} occurrences; narrow it`,
        { max_occurrences: MAX_OCCURRENCES, found: results.length },
      );
    }

    results.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return c.json(
      {
        data: results,
        window: { from: from.toISOString(), to: to.toISOString() },
        ...(seriesErrors.length > 0 ? { series_errors: seriesErrors } : {}),
      },
      200,
    );
  });

  return router;
}
