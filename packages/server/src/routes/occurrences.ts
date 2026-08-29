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
 * Four bounds do the rest of that work and none of them refuses a space
 * for being large:
 *
 *   - **Assembly stops the moment the window is over full**, so the rest
 *     of the assembly and every item fetch are saved.
 *   - **`series_errors` is capped in count and in message length**, so
 *     the other result array cannot grow without limit either. This one
 *     does refuse, and `MAX_SERIES_ERRORS` states what that costs.
 *   - **The batched reads are consumed a chunk at a time**, so nothing
 *     an id lookup returns outlives the chunk it arrived in.
 *   - **Both long loops hand the event loop back periodically** — the
 *     page walk between pages, the expansion on both a series budget and
 *     an iteration budget. `ITERATIONS_PER_YIELD` states the resulting
 *     bound on one uninterrupted stretch, in iterations.
 *
 * **What the occurrence ceiling does not bound, and it reads as though
 * it does.** All three `scanEvents` calls run to exhaustion and the
 * exceptions are grouped over every exception in the space *before* the
 * first occurrence is appended, so a refusal costs the whole read that
 * preceded it: every row scanned, every projection built, every edge
 * chunk walked. A window holding two million standalone events
 * materializes two million projections in order to answer 400. The
 * ceiling bounds the assembly and the item fetches, which is what it
 * says on the constant, and nothing before them.
 *
 * Bounding the passes too was considered and declined. A ceiling on
 * rows read is the fail-closed scan ceiling this change removed. A
 * ceiling on kept projections cannot be set safely either: a window seed
 * is dropped later if its series consumed it as an exception, so a cap
 * on seeds kept would drop meetings a healthy calendar contains, which
 * is the one outcome worth less than a slow read. The claim is corrected
 * rather than the property added.
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
import type { Item } from "@withmarfa/shared";
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
  ExpansionWork,
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
 * succeeds. It is checked as the result is assembled and before any item
 * is read, so a window that cannot be served costs neither the rest of
 * the assembly nor a single row fetch, and it is published on every
 * successful read (see `scan` on the response) so a calendar growing
 * toward it is visible before a request is refused.
 */
export const MAX_OCCURRENCES = 5000;

/**
 * Ceiling on the reported expansion failures, across every series in
 * the space.
 *
 * `series_errors` is a second result array and `MAX_OCCURRENCES`
 * structurally cannot bound it: a series that fails to expand emits no
 * occurrence, so a space can cross every other bound here at zero and
 * still return an arbitrarily long list. Measured before this existed:
 * 25,000 rows carrying a malformed rule answered 200 with a 4.8 MB JSON
 * body, built as one string in memory. Ten times that is the fail-open
 * crash this change exists to remove, relocated into the other array.
 *
 * **It refuses rather than truncating**, and the argument that talked
 * the occurrence path out of a work ceiling does not reach here. That
 * argument is that any bound either refuses a large calendar or serves
 * it with meetings silently missing. A series that errored contributed
 * no meeting by construction, so this ceiling refuses nothing a healthy
 * calendar contains and drops nothing from one that is served.
 *
 * **What it does cost, stated plainly:** unlike the occurrence ceiling,
 * this refusal is not recoverable by asking for a narrower window,
 * because the series pass is unwindowed. A space holding more than this
 * many broken rules cannot be read until the rules are repaired or
 * removed, and the refusal says so. That is the deliberate trade: five
 * hundred distinct broken rules is a corrupt import rather than a large
 * calendar, and a response nobody can hold in memory is not a better
 * answer than being told.
 */
export const MAX_SERIES_ERRORS = 500;

/**
 * Longest reported expansion-failure message.
 *
 * A count alone does not bound bytes. Most of these messages are this
 * file's own fixed strings, but the malformed-rule ones carry ical.js's
 * error text verbatim, which is as long as whatever it was handed —
 * measured at 4,072 characters from a single long property value. This
 * counts characters rather than bytes, so the byte ceiling on the array
 * is `MAX_SERIES_ERRORS` times four times this plus the item ids: a few
 * hundred kilobytes, against 4.8 MB measured without it. That product,
 * not the count alone, is what makes `MAX_SERIES_ERRORS` a bound on the
 * response rather than only on its length.
 *
 * Truncating a message loses nothing a caller needs to act: `item_id`
 * is its own field, so the row still names which series to go and look
 * at.
 */
const MAX_SERIES_ERROR_MESSAGE_CHARS = 200;

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
 * Series expanded between one yield to the event loop and the next.
 *
 * This bounds the *number of per-series parses* between yields, which
 * the iteration budget below cannot see: building a synthetic VEVENT and
 * parsing it through ical.js happens once per series whatever its rule
 * says, and a rule that ends before it starts costs a parse and zero
 * iterations. Both counters run, and whichever trips first yields.
 *
 * It bounds the count and not the cost, and the difference is worth
 * stating rather than glossing. `recurrence` is a caller-written array,
 * so one series can carry thousands of RDATE lines and its parse is as
 * long as that array. What this guarantees is 32 parses per stretch, not
 * 32 short ones. Bounding the cost would mean bounding the property,
 * which is a write-side rule and does not belong on a read.
 */
const SERIES_PER_YIELD = 32;

/**
 * Rule iterations walked between one yield to the event loop and the
 * next.
 *
 * A series count is the wrong unit for the expansion's cost and this
 * loop used to be paced by it alone. `expandSeries` is synchronous and
 * one call walks up to `MAX_EXPANSION_ITERATIONS` — 100,000 — so 32
 * series between yields permitted 3.2 million iterations in a single
 * uninterrupted stretch of CPU, with health checks, open streams and
 * every other request on the instance waiting behind it. That is not an
 * exotic shape: a `FREQ=MINUTELY` reminder created a year ago burns the
 * whole cap on every read, forever, and 32 of them ran between yields.
 * Measured through the route at 11.5 seconds, and invariant in the
 * number of series, because it was always exactly 32 expansions deep.
 *
 * **The bound this buys, stated in the unit that costs:** one
 * uninterrupted stretch walks at most
 * `ITERATIONS_PER_YIELD + MAX_EXPANSION_ITERATIONS - 1` iterations —
 * 119,999 today. The second term is irreducible here and is most of the
 * bound: one `expandSeries` call is atomic, so a stretch can always be
 * one full expansion longer than the budget that admitted it. Shrinking
 * it means either refusing more rules or making the expansion itself
 * resumable, and a rule's phase is anchored at the series start, so it
 * cannot be resumed mid-stream.
 *
 * **What is deliberately not bounded:** the total work one request may
 * do. Iterations accumulate across every series in the space, and a
 * ceiling on the sum would refuse a calendar for being large — the
 * fail-closed scan ceiling this change removed, re-denominated. A large
 * calendar stays slower rather than refused; what this fixes is that
 * "slower" no longer means "the process stops answering for eleven
 * seconds at a time".
 */
const ITERATIONS_PER_YIELD = 20_000;

/** Hand the event loop one turn: `setImmediate` runs after the pending
 *  I/O and timer callbacks rather than ahead of them, which a resolved
 *  promise would not, being a microtask. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
 * a plain event that lands in the window.
 */
interface WindowSeed {
  id: string;
  starts_at: string;
  ends_at?: string;
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
      // Between pages for the same reason the expansion yields between
      // batches. On a driver that answers over a socket the await above
      // already returns the loop; on an embedded one it does not, and a
      // walk of tens of thousands of rows is then a single stretch of
      // synchronous reads and JSON parsing with every other request on
      // the process behind it.
      if (cursor !== undefined) await yieldToEventLoop();
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
  // A row carrying a rule belongs to the series pass, which has already
  // expanded it; this pass reaches it too because a series' own start is
  // an ordinary start. Dropped here rather than skipped later, so a row
  // this pass is certain not to use never outlives the page it arrived
  // on — the discard rule the note at the top of this file states.
  if (recurrenceProp(item).length > 0) return undefined;
  return {
    id: item.id,
    starts_at: startsAt,
    ends_at: stringProp(item, "ends_at"),
  };
}

/**
 * The series pass's walk, exposed so a test can drive it against a
 * storage serving more rows than any single page.
 *
 * Exported for the one property the route's own response cannot show:
 * that what the walk retains is the projection and not the row. That the
 * walk runs to exhaustion is visible from outside, on `scan.events_read`,
 * and is asserted there.
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

/**
 * Items for the given ids, read in batches. See `ID_BATCH_SIZE`.
 *
 * Narrowed to `active` because that is what the scans selected on.
 * `getMany` excludes trashed rows and nothing else, so an item archived
 * between a scan and this read would otherwise be rendered inside a 200
 * carrying a state this route has never emitted.
 */
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
      if (item.state !== "active") continue;
      out.set(id, item);
    }
  }
  return out;
}

/**
 * Exceptions grouped under the series each one shadows, read in batches.
 * See `ID_BATCH_SIZE`.
 *
 * An exception names its series through `parent-of`, so the series is
 * resolved from the edge rather than from a property: the property would
 * be a second, drift-prone copy of the same fact.
 *
 * Each chunk is consumed before the next is asked for, and the only
 * thing kept from an edge is the id at the far end of it. Returning the
 * edges instead would hold one fully hydrated row — `properties`
 * included — per exception in the space until the last chunk landed,
 * which is the retention chunking exists to avoid rather than one it
 * merely reshapes.
 *
 * Ids are deduplicated on the way in, as the item read beside this one
 * does: a repeated id is a repeated bind parameter, and it would put the
 * same exception under its series twice.
 */
async function groupExceptionsBySeries(
  storage: Storage,
  exceptions: readonly RecurrenceException[],
): Promise<Map<string, RecurrenceException[]>> {
  const byId = new Map<string, RecurrenceException>();
  for (const exception of exceptions) byId.set(exception.id, exception);
  const ids = [...byId.keys()];

  const bySeries = new Map<string, RecurrenceException[]>();
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const slice = ids.slice(i, i + ID_BATCH_SIZE);
    const chunk = await storage.edges.listToTargetsBatched(
      slice,
      // One parent is all a `parent-of` exception has; asking for a
      // second would only widen what a malformed graph could return.
      1,
    );
    // Walked over the slice rather than over the map the store answered
    // with, because that is what makes each chunk's edges unreachable
    // once the next chunk is asked for — the retention property this
    // function exists for, not a determinism one.
    //
    // Determinism is real here and comes from somewhere else: the scan
    // hands these ids over in the store's keyset order, which is a total
    // order and identical in both dialects. Iterating the returned map
    // instead would preserve that too, since it is keyed by the same
    // ids. An earlier version of this comment credited the slice walk
    // with fixing a dialect-dependent resolution that never existed,
    // which points the next reader at the wrong fragile part.
    for (const exceptionId of slice) {
      const seriesId = chunk
        .get(exceptionId)
        ?.find((edge) => edge.edge_type === "parent-of")?.source_id;
      if (seriesId === undefined) continue;
      const exception = byId.get(exceptionId);
      if (exception === undefined) continue;
      const list = bySeries.get(seriesId) ?? [];
      list.push(exception);
      bySeries.set(seriesId, list);
    }
  }
  return bySeries;
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
   *  single six-year-old meeting take the calendar down. Bounded by
   *  `MAX_SERIES_ERRORS`, past which the read is refused instead. */
  series_errors: z.array(SeriesErrorSchema).optional(),
});

const occurrencesRoute = createRoute({
  operationId: "listOccurrences",
  method: "get",
  path: "/",
  tags: ["Items"],
  summary: "List event occurrences in a window",
  description:
    "Returns the events that fall inside a time window, expanding recurring series from their rules at read time rather than storing occurrences. Single events appear by their own times; a series contributes one entry per occurrence in the window, carrying `series_id`; a stored exception replaces the occurrence it was recorded against and carries `replaces`. A row is shown at the times its own item carries; only a computed series occurrence, whose time the item does not hold, is shown at the time the rule produced. Three bounds apply and all three refuse rather than silently trimming: the window may not be longer than `max_days`, the assembled result may not exceed `max_occurrences`, and the space may not hold more than `max_series_errors` rules that fail to expand. The second depends on what the window holds, so a window well inside the length limit can still be refused for being too full; `scan.max_occurrences` is reported on every successful read so the ceiling is visible before it is reached. A series that cannot expand (a malformed rule, or one that floods the window) is reported in `series_errors` while the rest of the calendar still returns.",
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
        "A missing, unreadable or inverted window; a window longer than `max_days`; an invalid type identifier; a window whose occurrences exceed `max_occurrences`; or a space holding more than `max_series_errors` rules that cannot be expanded. The last two can refuse a window that is otherwise perfectly valid, because they depend on what the space and the window hold rather than on how long the window is. Each carries its own ceiling plus `found`, where `found` is the count the read stopped at rather than the true total: the read is abandoned as soon as a ceiling is crossed instead of continuing in order to report how far past it the space went. Narrowing the window recovers from the occurrence ceiling; it does not recover from the series-error ceiling, which is unwindowed by nature and asks for the broken rules to be repaired or removed.",
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

    // Batched, because the per-item form issued one query per exception
    // and an exception is an ordinary shape — a calendar where several
    // hundred meetings have each been moved once is a busy calendar, not
    // a pathological one.
    const exceptionsBySeries = await groupExceptionsBySeries(
      storage,
      exceptionSeeds,
    );

    const pending: PendingOccurrence[] = [];
    /**
     * Append one occurrence, refusing the moment the window is over full.
     *
     * The check belongs at the append rather than after the loops
     * because a limit has to fail toward something bounded: a ceiling
     * that is only consulted once everything it would have refused is
     * already assembled does not make the work smaller, it only makes
     * the answer a 400. Unbounded is not slower — a space dense enough
     * to cross this by orders of magnitude would build every occurrence
     * it holds in order to produce a refusal the first `MAX_OCCURRENCES`
     * plus one already justified.
     *
     * `found` is therefore the count at the refusal rather than the
     * window's true total, which is the price of not assembling it.
     */
    const appendPending = (occurrence: PendingOccurrence): void => {
      if (pending.length >= MAX_OCCURRENCES) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `This window holds more than ${String(MAX_OCCURRENCES)} occurrences; narrow it`,
          { max_occurrences: MAX_OCCURRENCES, found: pending.length + 1 },
        );
      }
      pending.push(occurrence);
    };
    const seriesErrors: { item_id: string; message: string }[] = [];
    /**
     * Record one series that could not expand, refusing once the space
     * holds more broken rules than a response can carry.
     *
     * Refused at the append for the same reason `appendPending` is: a
     * ceiling consulted after the loop has already built everything it
     * would have refused makes the answer a 400 without making the work
     * smaller. See `MAX_SERIES_ERRORS` for why refusing beats truncating
     * on this array specifically, and for what the refusal costs.
     */
    const appendSeriesError = (itemId: string, message: string): void => {
      if (seriesErrors.length >= MAX_SERIES_ERRORS) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `More than ${String(MAX_SERIES_ERRORS)} series in this space carry a rule that cannot be expanded; repair or remove them`,
          {
            max_series_errors: MAX_SERIES_ERRORS,
            found: seriesErrors.length + 1,
          },
        );
      }
      seriesErrors.push({
        item_id: itemId,
        message:
          message.length > MAX_SERIES_ERROR_MESSAGE_CHARS
            ? `${message.slice(0, MAX_SERIES_ERROR_MESSAGE_CHARS)}…`
            : message,
      });
    };
    // Exceptions an expansion actually consumed. Only these are hidden
    // from the standalone pass: an exception whose slot fell outside the
    // window, or whose series could not expand, still deserves to appear
    // at its own time rather than vanish.
    const consumedExceptions = new Set<string>();

    // Series first, standalone second, because only the expansion knows
    // which stored exceptions it consumed.
    const expandedSeries = new Set<string>();
    // Two budgets, one for each thing an expansion costs. See
    // `SERIES_PER_YIELD` and `ITERATIONS_PER_YIELD`; neither substitutes
    // for the other, so whichever fills first hands the loop back.
    let seriesSinceYield = 0;
    let iterationsSinceYield = 0;
    const work: ExpansionWork = { iterations: 0 };
    for (const seed of seriesSeeds) {
      if (expandedSeries.has(seed.id)) continue;
      expandedSeries.add(seed.id);

      seriesSinceYield += 1;
      if (
        seriesSinceYield >= SERIES_PER_YIELD ||
        iterationsSinceYield >= ITERATIONS_PER_YIELD
      ) {
        seriesSinceYield = 0;
        iterationsSinceYield = 0;
        await yieldToEventLoop();
      }

      let expanded: Occurrence[];
      const before = work.iterations;
      try {
        expanded = expandSeries(
          seed,
          from,
          to,
          exceptionsBySeries.get(seed.id) ?? [],
          work,
        );
      } catch (err) {
        // One series that cannot expand degrades that series, never the
        // whole read: a calendar with one malformed rule is still a
        // calendar. Anything not the expander's own error type is a
        // genuine bug and stays loud.
        if (err instanceof RecurrenceExpansionError) {
          appendSeriesError(seed.id, err.message);
          continue;
        }
        throw err;
      } finally {
        // In a `finally` because the refusal above is the expensive
        // case: a rule that walks the full iteration cap and yields
        // nothing is precisely what the budget has to charge for, and
        // the `continue` in the catch would otherwise skip the charge.
        iterationsSinceYield += work.iterations - before;
      }
      for (const occurrence of expanded) {
        if (occurrence.replaces !== undefined) {
          consumedExceptions.add(occurrence.item_id);
        }
        appendPending({
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

      // An exception an expansion consumed is already shown through its
      // series; showing it here too would double it.
      if (consumedExceptions.has(seed.id)) continue;

      const at = new Date(seed.starts_at);
      // The SQL does the narrowing now. This stays as a belt: it is the
      // one place the normalized column and the stored value are read
      // against each other, so a column that ever disagreed with its row
      // shows up as a missing event rather than a wrong one.
      if (Number.isNaN(at.getTime()) || at < from || at >= to) continue;
      appendPending({
        starts_at: at.toISOString(),
        ends_at:
          seed.ends_at !== undefined
            ? toInstantString(seed.ends_at, seed.ends_at)
            : undefined,
        item_id: seed.id,
      });
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
      // Deleted, trashed or moved out of `active` between the scan and
      // this read. Dropping it is the right direction: a meeting removed
      // or filed away a moment ago should not render.
      if (shown === undefined) continue;

      /**
       * One rule decides what time a row is shown at: **the fetched
       * item is the authority for its own times, and only a computed
       * occurrence — which the item does not carry a time for — comes
       * from the expansion.**
       *
       * Two rules used to apply. A standalone row and a computed one
       * were both rendered from the scan-time projection while a
       * replacement re-derived from the fetched item, so two rows in one
       * response followed opposite rules. That was survivable while the
       * gap between scan and fetch was microseconds. It is not now: the
       * yields above widen that gap to the length of the whole request,
       * so a meeting moved while the request was in flight rendered its
       * old slot beside the new `item.properties.starts_at`, in the same
       * object, contradicting itself.
       *
       * A computed occurrence is exempt because there is nothing to
       * re-derive: the item is the series, and its `starts_at` is the
       * rule's anchor rather than this slot. That leaves one residual,
       * which nothing cheap fixes — a series rescheduled mid-request
       * shows slots computed from the anchor it had when it was read.
       * Re-expanding at render time would mean holding every seed and
       * repeating the walk this route is trying to bound.
       *
       * The window stays a filter over which rows appear, not a
       * constraint on what time they are shown at. That is the rule
       * `replaces` already followed — a moved instance is shown at its
       * own time, which may fall outside the window — and applying it to
       * a standalone row that moved is the same answer to the same
       * question.
       */
      const itemIsAuthority =
        occurrence.series_id === undefined || occurrence.replaces !== undefined;

      if (itemIsAuthority) {
        // The fallback is load-bearing rather than incidental: a row
        // with no readable `starts_at` of its own is shown at the slot
        // it was found at. For a replacement that means `starts_at` and
        // `replaces` come back equal and the row reads as "moved to
        // where it already was", which is the truthful rendering — such
        // a row replaced its slot's content and not its time. Dropping
        // the row would lose a meeting; dropping `replaces` when it
        // matches would trade a redundant field for the only signal a
        // caller has that this is a stored replacement rather than a
        // computed occurrence.
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
          ...(occurrence.replaces !== undefined
            ? { replaces: occurrence.replaces }
            : {}),
        });
        continue;
      }

      results.push({
        starts_at: occurrence.starts_at,
        ...(occurrence.ends_at !== undefined
          ? { ends_at: occurrence.ends_at }
          : {}),
        item: shown,
        series_id: occurrence.series_id,
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
