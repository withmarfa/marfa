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
 *
 * ## What the read is bounded by, and what it is not
 *
 * Two of the three passes cannot be narrowed by the window and so read
 * every matching row in the space. They are walked to exhaustion. There
 * is deliberately no ceiling on how many rows that is: a ceiling on the
 * scan cannot be recovered from, because the only move a caller knows —
 * ask for a narrower window — does not change how many rows carry a
 * rule. Such a ceiling fails closed permanently, and every call fails
 * once a space crosses it. A large calendar should be slower, not
 * refused.
 *
 * What keeps "slower" from meaning "out of memory" is that a scanned row
 * is projected the moment it arrives and the row itself is dropped. The
 * two unwindowed passes retain exactly `RecurrenceSeries` and
 * `RecurrenceException` — the expander's own inputs, and nothing else.
 * An event's `properties` is the upstream record in full, attendees and
 * description and conference data included, so retaining the projection
 * rather than the row is the difference between a couple of hundred
 * bytes and several kilobytes each. Whole items are read exactly once,
 * for the occurrences actually being returned, after the occurrence
 * ceiling has already refused anything larger — so the number of items
 * held at once is bounded by `MAX_OCCURRENCES` rather than by the size
 * of the space.
 *
 * That leaves the projections themselves growing linearly with the
 * space's event count. It is survivable where holding whole rows is not,
 * and it is not free. Two follow-ups would remove the growth rather than
 * shrink it, and neither is possible against the schema as it stands:
 *
 *   - **Narrow the series pass by each rule's own bounds**, so a rule
 *     that ended before the window is never read. It needs the rule's
 *     first and last instant as indexed columns; a rule is stored as
 *     RFC 5545 text, and computing its bounds is the expansion this
 *     pass exists to feed.
 *   - **Narrow the exception pass by the window.** `original_starts_at`
 *     has no normalized or indexed column — only `starts_at`/`ends_at`
 *     are normalized, into `starts_at_utc`/`ends_at_utc`. Comparing the
 *     raw property text instead would reproduce exactly the bug that
 *     normalization exists to fix, because an offset-bearing stored time
 *     does not order against a `Z` one as text.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  isValidTypePattern,
  matchesTypePattern,
} from "@withmarfa/shared";
import type { Edge, Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, getTypeFilter } from "../middleware/auth.js";
import type { ItemFilters, Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemSchema } from "./_schemas.js";
import { resolveOrphanScope, withOrphanState } from "./_orphaned.js";
import {
  expandSeries,
  RecurrenceExpansionError,
} from "../events/expand-recurrence.js";
import type {
  Occurrence,
  RecurrenceException,
  RecurrenceSeries,
} from "../events/expand-recurrence.js";

/**
 * Longest window a caller may ask for. A calendar year plus a month of
 * slack covers "the year ahead" without letting one request expand a
 * decade of daily rules.
 */
export const MAX_WINDOW_DAYS = 400;

/**
 * Ceiling on the assembled result, across every series in the window.
 *
 * The one bound that still refuses, and it is recoverable in the way the
 * removed scan ceiling was not: a caller asks for less time and
 * succeeds. It is checked before any item is read, so a window that
 * cannot be served costs the assembly and no row fetches, and it is
 * published on every successful read (see `scan` on the response) so a
 * calendar growing toward it is visible before a request is refused.
 */
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
 * Ids handed to one batched storage call.
 *
 * Both batched reads below build a single `IN (...)` from every id they
 * are given and neither chunks internally, so an unchunked call from
 * here turns a large calendar into a statement carrying more bind
 * parameters than SQLite will accept. While the scan was capped that was
 * unreachable; without the cap it is the failure that would replace the
 * one being removed, and a different error is not an improvement on a
 * refusal.
 */
const ID_BATCH_SIZE = 500;

/**
 * Types whose items this route reads. Anything declaring the event
 * shape belongs here; `compatible_with` is what makes the Google type
 * readable through the same fields.
 */
const EVENT_TYPES = ["core.event", "google.calendar.event"] as const;

/** Rows read so far by one request, summed across its passes. Reported
 *  on the response rather than compared against anything: what the read
 *  cost is worth knowing, and it is no longer grounds for refusing. */
interface ScanBudget {
  scanned: number;
}

/** The storage-side narrowing one pass applies on top of type and state. */
type EventScanNarrowing = Pick<
  ItemFilters,
  "hasProperty" | "startsAtUtcFrom" | "startsAtUtcTo"
>;

/**
 * What the window pass keeps from a row.
 *
 * Its own shape rather than one of the expander's because this pass asks
 * a different question: not how a rule unfolds, but whether this row is
 * a plain event that lands in the window. `has_recurrence` is resolved
 * here so the rule text does not have to be carried forward merely to be
 * tested for emptiness later.
 */
interface WindowSeed {
  id: string;
  starts_at: string;
  ends_at?: string;
  has_recurrence: boolean;
}

/**
 * The active events of the named types that match one pass's narrowing,
 * walked page by page to exhaustion and projected as they arrive.
 *
 * `project` returning `undefined` drops the row, which is how a pass
 * discards what it cannot use at the point the row is in hand rather
 * than carrying it to a later loop to be skipped there. No page's items
 * outlive the page: that is the whole reason this is generic rather
 * than returning `Item[]`.
 */
async function scanEvents<T>(
  storage: Storage,
  spaceId: string | undefined,
  types: readonly string[],
  budget: ScanBudget,
  narrowing: EventScanNarrowing,
  project: (item: Item) => T | undefined,
): Promise<T[]> {
  const kept: T[] = [];
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
      budget.scanned += page.data.length;
      for (const item of page.data) {
        const projected = project(item);
        if (projected !== undefined) kept.push(projected);
      }
      cursor = page.has_more ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
  return kept;
}

function projectSeries(item: Item): RecurrenceSeries | undefined {
  const recurrence = recurrenceProp(item);
  const startsAt = stringProp(item, "starts_at");
  // A row carrying the key but no usable rule, or no anchor to unfold it
  // from, contributes nothing. Dropped here rather than in the expansion
  // loop so it is never retained in the first place.
  if (recurrence.length === 0 || startsAt === undefined) return undefined;
  return {
    id: item.id,
    starts_at: startsAt,
    ends_at: stringProp(item, "ends_at"),
    timezone: stringProp(item, "timezone"),
    recurrence,
  };
}

function projectException(item: Item): RecurrenceException | undefined {
  const originalStartsAt = stringProp(item, "original_starts_at");
  if (originalStartsAt === undefined) return undefined;
  return { id: item.id, original_starts_at: originalStartsAt };
}

function projectWindow(item: Item): WindowSeed | undefined {
  const startsAt = stringProp(item, "starts_at");
  if (startsAt === undefined) return undefined;
  return {
    id: item.id,
    starts_at: startsAt,
    ends_at: stringProp(item, "ends_at"),
    has_recurrence: recurrenceProp(item).length > 0,
  };
}

/**
 * The series pass's walk, exposed so a test can drive it against a
 * storage serving more rows than any single page.
 *
 * Exported for two properties that are otherwise unobservable: that the
 * walk runs to exhaustion rather than stopping at a ceiling, and that
 * what it retains is the projection rather than the row.
 */
export async function gatherSeriesSeeds(
  storage: Storage,
  spaceId: string | undefined,
  types: readonly string[],
): Promise<RecurrenceSeries[]> {
  return await scanEvents(
    storage,
    spaceId,
    types,
    { scanned: 0 },
    { hasProperty: "recurrence" },
    projectSeries,
  );
}

/** Items for the given ids, read in batches. See `ID_BATCH_SIZE`. */
async function fetchItemsBatched(
  storage: Storage,
  spaceId: string | undefined,
  ids: readonly string[],
): Promise<Map<string, Item>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Item>();
  for (let i = 0; i < unique.length; i += ID_BATCH_SIZE) {
    const slice = unique.slice(i, i + ID_BATCH_SIZE);
    for (const [id, item] of await storage.items.getMany(slice, spaceId)) {
      out.set(id, item);
    }
  }
  return out;
}

/** Parent edges for the given ids, read in batches. See `ID_BATCH_SIZE`. */
async function fetchParentsBatched(
  storage: Storage,
  ids: readonly string[],
): Promise<Map<string, Edge[]>> {
  const out = new Map<string, Edge[]>();
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const slice = ids.slice(i, i + ID_BATCH_SIZE);
    const page = await storage.edges.listToTargetsBatched(
      slice,
      // One parent is all a `parent-of` exception has; asking for a
      // second would only widen what a malformed graph could return.
      1,
    );
    for (const [id, edges] of page) out.set(id, edges);
  }
  return out;
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

const ScanSchema = z.object({
  events_read: z
    .number()
    .int()
    .describe(
      "Event rows this request read, summed across its passes. Two of the three cannot be narrowed by the window, so this grows with the size of the calendar rather than with the window asked for.",
    ),
  occurrences: z
    .number()
    .int()
    .describe("Occurrences returned, the length of `data`."),
  max_occurrences: z
    .number()
    .int()
    .describe(
      "Ceiling `occurrences` is refused at. Reported on every successful read so a calendar approaching it is visible before a request is refused, rather than only once one is.",
    ),
});

const OccurrencesResponseSchema = z.object({
  data: z.array(OccurrenceSchema),
  window: z.object({ from: z.string(), to: z.string() }),
  /** What this read cost and what would stop it. Always present: a bound
   *  that is only mentioned when it fires announces itself too late to
   *  act on. */
  scan: ScanSchema,
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
    "Returns the events that fall inside a time window, expanding recurring series from their rules at read time rather than storing occurrences. Single events appear by their own times; a series contributes one entry per occurrence in the window, carrying `series_id`; a stored exception replaces the occurrence it was recorded against and carries `replaces`. Two bounds apply and both refuse rather than silently trimming: the window may not be longer than `max_days`, and the assembled result may not exceed `max_occurrences`. The second depends on what the window holds, so a window well inside the length limit can still be refused for being too full; `scan.max_occurrences` is reported on every successful read so the ceiling is visible before it is reached. A series that cannot expand (a malformed rule, or one that floods the window) is reported in `series_errors` while the rest of the calendar still returns.",
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
      description:
        "A missing, unreadable or inverted window; a window longer than `max_days`; an invalid type identifier; or a window whose occurrences exceed `max_occurrences`. The last of these can refuse a window that is otherwise perfectly valid, because it depends on what the window holds rather than on how long it is — the response carries `max_occurrences` and `found` so the caller can narrow by an informed amount.",
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

/**
 * One occurrence before its item is in hand.
 *
 * Carries the item's id rather than the item, which is what lets the
 * occurrence ceiling refuse an over-full window without a single row
 * having been read. For a replacement, `starts_at` here is the computed
 * slot; the time actually shown comes from the stored item and is
 * resolved once the items arrive.
 */
interface PendingOccurrence {
  starts_at: string;
  ends_at?: string;
  item_id: string;
  series_id?: string;
  replaces?: string;
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
          scan: {
            events_read: 0,
            occurrences: 0,
            max_occurrences: MAX_OCCURRENCES,
          },
        },
        200,
      );
    }

    // Three passes, because the calendar is three different questions
    // and only one of them is about the window. Each keeps its own
    // projection of a row and never the row: see the note at the top of
    // this file for why that is what makes an unbounded scan safe.
    const budget: ScanBudget = { scanned: 0 };

    // Series. Unwindowed by necessity — a rule written years ago
    // produces occurrences in any window, so the window says nothing
    // about which rules matter.
    const seriesSeeds = await scanEvents(
      storage,
      spaceId,
      wanted,
      budget,
      { hasProperty: "recurrence" },
      projectSeries,
    );

    // Exceptions. Unwindowed for the opposite reason — an exception
    // whose own time was moved outside the window still shadows the
    // occurrence it replaced inside it, so narrowing this pass would put
    // a ghost back on the calendar at a slot nobody is at.
    const exceptionSeeds = await scanEvents(
      storage,
      spaceId,
      wanted,
      budget,
      { hasProperty: "original_starts_at" },
      projectException,
    );

    // Standalone events, narrowed to the window in SQL against the
    // normalized instant column. Bounded by the window, unlike the two
    // above, so this is the one pass whose size a caller can influence.
    const windowSeeds = await scanEvents(
      storage,
      spaceId,
      wanted,
      budget,
      {
        startsAtUtcFrom: from.toISOString(),
        startsAtUtcTo: to.toISOString(),
      },
      projectWindow,
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
    if (exceptionSeeds.length > 0) {
      const parentsByException = await fetchParentsBatched(
        storage,
        exceptionSeeds.map((seed) => seed.id),
      );
      for (const seed of exceptionSeeds) {
        const seriesId = (parentsByException.get(seed.id) ?? []).find(
          (edge) => edge.edge_type === "parent-of",
        )?.source_id;
        if (seriesId === undefined) continue;
        const list = exceptionsBySeries.get(seriesId) ?? [];
        list.push(seed);
        exceptionsBySeries.set(seriesId, list);
      }
    }

    const pending: PendingOccurrence[] = [];
    const seriesErrors: { item_id: string; message: string }[] = [];
    // Exceptions an expansion actually consumed. Only these are hidden
    // from the standalone pass: an exception whose slot fell outside the
    // window, or whose series could not expand, still deserves to appear
    // at its own time rather than vanish.
    const consumedExceptions = new Set<string>();

    // Series first, standalone second, because only the expansion knows
    // which stored exceptions it consumed.
    const expandedSeries = new Set<string>();
    for (const seed of seriesSeeds) {
      if (expandedSeries.has(seed.id)) continue;
      expandedSeries.add(seed.id);

      let expanded: Occurrence[];
      try {
        expanded = expandSeries(
          seed,
          from,
          to,
          exceptionsBySeries.get(seed.id) ?? [],
        );
      } catch (err) {
        // One series that cannot expand degrades that series, never the
        // whole read: a calendar with one malformed rule is still a
        // calendar. Anything not the expander's own error type is a
        // genuine bug and stays loud.
        if (err instanceof RecurrenceExpansionError) {
          seriesErrors.push({ item_id: seed.id, message: err.message });
          continue;
        }
        throw err;
      }
      for (const occurrence of expanded) {
        if (occurrence.replaces !== undefined) {
          consumedExceptions.add(occurrence.item_id);
        }
        pending.push({
          starts_at: occurrence.starts_at,
          ends_at: occurrence.ends_at,
          item_id: occurrence.item_id,
          series_id: seed.id,
          replaces: occurrence.replaces,
        });
      }
    }

    const shownStandalone = new Set<string>();
    for (const seed of windowSeeds) {
      if (shownStandalone.has(seed.id)) continue;
      shownStandalone.add(seed.id);

      // A row carrying a rule was already read and expanded by the first
      // pass; the window scan reaches it too, because a series' own
      // start is an ordinary start.
      if (seed.has_recurrence) continue;

      // An exception an expansion consumed is already shown through its
      // series; showing it here too would double it.
      if (consumedExceptions.has(seed.id)) continue;

      const at = new Date(seed.starts_at);
      // The SQL does the narrowing now. This stays as a belt: it is the
      // one place the normalized column and the stored value are read
      // against each other, so a column that ever disagreed with its row
      // shows up as a missing event rather than a wrong one.
      if (Number.isNaN(at.getTime()) || at < from || at >= to) continue;
      pending.push({
        starts_at: at.toISOString(),
        ends_at:
          seed.ends_at !== undefined
            ? toInstantString(seed.ends_at, seed.ends_at)
            : undefined,
        item_id: seed.id,
      });
    }

    // Checked before the items are read, so an over-full window costs the
    // assembly and no row fetches at all.
    if (pending.length > MAX_OCCURRENCES) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `This window holds more than ${String(MAX_OCCURRENCES)} occurrences; narrow it`,
        { max_occurrences: MAX_OCCURRENCES, found: pending.length },
      );
    }

    // The only place a whole row is read, and it is reached only for the
    // occurrences being returned. One row can answer many occurrences, so
    // the ids are deduplicated on the way in.
    const shownById = await fetchItemsBatched(
      storage,
      spaceId,
      pending.map((occurrence) => occurrence.item_id),
    );

    const results: {
      starts_at: string;
      ends_at?: string;
      item: Item;
      series_id?: string;
      replaces?: string;
    }[] = [];
    for (const occurrence of pending) {
      const shown = shownById.get(occurrence.item_id);
      // Deleted between the scan and this read. Dropping it is the right
      // direction — a meeting removed a moment ago should not render —
      // and it is the only way the two can disagree.
      if (shown === undefined) continue;
      if (occurrence.replaces !== undefined) {
        // A replacement is shown at its own times, which is the whole
        // point of having moved it.
        //
        // The fallback is load-bearing rather than incidental: an
        // exception with no readable `starts_at` of its own is shown at
        // the slot it replaced, so `starts_at` and `replaces` come back
        // equal and the row reads as "moved to where it already was".
        // That is the truthful rendering — such a row replaced its
        // slot's content and not its time — and it is preferred to the
        // two alternatives. Dropping the row loses a meeting. Dropping
        // `replaces` when it matches would trade a redundant field for
        // the only signal a caller has that this is a stored
        // replacement rather than a computed occurrence.
        const shownEndsAt = stringProp(shown, "ends_at");
        results.push({
          starts_at: toInstantString(
            stringProp(shown, "starts_at"),
            occurrence.starts_at,
          ),
          ...(shownEndsAt !== undefined
            ? { ends_at: toInstantString(shownEndsAt, shownEndsAt) }
            : {}),
          item: shown,
          ...(occurrence.series_id !== undefined
            ? { series_id: occurrence.series_id }
            : {}),
          replaces: occurrence.replaces,
        });
        continue;
      }
      results.push({
        starts_at: occurrence.starts_at,
        ...(occurrence.ends_at !== undefined
          ? { ends_at: occurrence.ends_at }
          : {}),
        item: shown,
        ...(occurrence.series_id !== undefined
          ? { series_id: occurrence.series_id }
          : {}),
      });
    }

    results.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    // One resolution for the whole window — see `_orphaned.ts`. A calendar
    // is the surface where this matters most: an events corpus is usually
    // somebody else's, mirrored, and a disconnected calendar that keeps
    // rendering looks current right up until somebody misses a meeting.
    // The same row can occur many times in one window, so the scope is
    // resolved from the distinct rows and applied to the occurrences.
    const orphanScope = await resolveOrphanScope(storage, [
      ...shownById.values(),
    ]);
    return c.json(
      {
        data: results.map((occurrence) => ({
          ...occurrence,
          item: withOrphanState(occurrence.item, orphanScope),
        })),
        window: { from: from.toISOString(), to: to.toISOString() },
        scan: {
          events_read: budget.scanned,
          occurrences: results.length,
          max_occurrences: MAX_OCCURRENCES,
        },
        ...(seriesErrors.length > 0 ? { series_errors: seriesErrors } : {}),
      },
      200,
    );
  });

  return router;
}
