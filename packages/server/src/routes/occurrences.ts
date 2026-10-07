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
 * every matching row stored. They are walked to exhaustion. There
 * is deliberately no ceiling on how many rows that is: a ceiling on the
 * scan cannot be recovered from, because the only move a caller knows —
 * ask for a narrower window — does not change how many rows carry a
 * rule. Such a ceiling fails closed permanently, and every call fails
 * once an instance crosses it. A large calendar should be slower, not
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
 * held at once is bounded by `MAX_OCCURRENCES` rather than by how much is
 * stored.
 *
 * Five bounds do the rest of that work and none of them refuses a calendar
 * for being large:
 *
 *   - **Assembly stops the moment the window is over full**, so the rest
 *     of the assembly and every item fetch are saved.
 *   - **`series_errors` is capped in count and in message length**, so
 *     the other result array cannot grow without limit either.
 *     `MAX_SERIES_ERRORS` states at length why trimming this array
 *     removes nothing from the calendar and trimming anything else here
 *     would.
 *   - **The batched reads are consumed a chunk at a time**, so nothing
 *     an id lookup returns outlives the chunk it arrived in.
 *   - **Both long loops hand the event loop back periodically** — the
 *     page walk between pages, the expansion on both a series budget and
 *     an iteration budget. `ITERATIONS_PER_YIELD` states the resulting
 *     bound on one uninterrupted stretch, in iterations.
 *   - **Expansion work is bounded across the whole request**, in the
 *     iterations spent on expansions that return no occurrence.
 *     `MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS` is what stops a calendar full
 *     of per-minute rules from taking hours of CPU in one request. It is
 *     the one bound here that can leave the calendar partial, and the
 *     response says so rather than stopping quietly.
 *
 * **What the occurrence ceiling does not bound, and it reads as though
 * it does.** All three `scanEvents` calls run to exhaustion and the
 * exceptions are grouped over every exception stored *before* the
 * first occurrence is appended, so a refusal costs the whole read that
 * preceded it: every row scanned, every projection built, every edge
 * chunk walked. A window holding two million standalone events
 * materializes two million projections in order to answer 400. The
 * ceiling bounds the assembly and the item fetches, which is what it
 * says on the constant, and nothing before them.
 *
 * The passes are not bounded. A ceiling on rows read is a fail-closed
 * scan ceiling, the one kind of bound this route does not have. A
 * ceiling on kept projections cannot be set safely either: a window seed
 * is dropped later if its series consumed it as an exception, so a cap
 * on seeds kept would drop meetings a healthy calendar contains, which
 * is the one outcome worth less than a slow read.
 *
 * That leaves the projections themselves growing linearly with the
 * instance's event count. It is survivable where holding whole rows is not,
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
 *     are normalized, into the `starts_at`/`ends_at` columns. Comparing the
 *     raw property text instead would reproduce exactly the bug that
 *     normalization exists to fix, because an offset-bearing stored time
 *     does not order against a `Z` one as text.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  MarfaError,
  ErrorCode,
  resolveEnforcement,
  typeAnswersSubtreeFilter,
} from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  getTypeFilter,
  readsSomeType,
} from "../middleware/auth.js";
import type { ItemFilters, Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { ItemSchema, NextCursorSchema } from "./_schemas.js";
import { MAX_PAGE_LIMIT } from "../page-limits.js";
import { assertTypeFilter } from "./_type-filter.js";
import {
  expandSeries,
  RecurrenceExpansionError,
  RecurrenceExpansionStopped,
} from "../events/expand-recurrence.js";
import { instantColumnValues } from "../storage/instant-columns.js";
import { readInstanceConfig } from "../storage/instance-config.js";
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
 * The one bound that refuses, because it is recoverable in the way a scan
 * ceiling is not: a caller asks for less time and succeeds. It is checked
 * as the result is assembled and before any item is read, so a window
 * that cannot be served costs neither the rest of the assembly nor a
 * single row fetch, and it is published on every successful read (see
 * `scan` on the response) so a calendar growing toward it is visible
 * before a request is refused.
 */
export const MAX_OCCURRENCES = 5000;

/**
 * How many rule failures the response will list, counted in entries
 * rather than in rows: one row can produce two.
 *
 * `series_errors` is a second result array and `MAX_OCCURRENCES`
 * structurally cannot bound it. A calendar of rules that all fail in the
 * parser contributes no occurrence at all, so it sits at zero against
 * every other bound here and still returns an arbitrarily long list.
 * Measured without this cap, 25,000 rows carrying a malformed rule
 * answered 200 with a 4.8 MB JSON body, built as one string in memory,
 * and ten times that is an out-of-memory crash in the other array.
 *
 * ## Why this one truncates where the rules above forbid truncating
 *
 * Every other bound in this file refuses rather than trims, and the
 * reason is that a calendar quietly missing a meeting looks exactly like
 * a correct answer. None of that reaches this array, on three counts:
 *
 *   - **No occurrence is dropped.** Nothing in `data` is derived from
 *     this list: it is a diagnostic beside the calendar, and every
 *     occurrence is appended by a path that never reads it. So capping
 *     it cannot remove a meeting, and the healthy series beside them
 *     expand and return exactly as they would have.
 *
 *     The stronger-sounding version, that a listed series contributed
 *     no occurrence, is false. Two of the shapes reported here render: a
 *     `recurrence` holding no readable property line is reported and
 *     still shows as the single event its own times describe, and a rule
 *     missing one unreadable line is reported and still contributes
 *     every occurrence it expands to.
 *   - **The response declares its own incompleteness.**
 *     `series_errors_truncated` is on the envelope beside the array, so
 *     a partial list is never mistaken for a complete one. That is the
 *     whole of what "quietly" meant.
 *   - **The true count is reported anyway**, as `scan.series_errors`, so
 *     a caller can tell 501 failures from 50,000 without the bytes of
 *     either. Diagnostics are compressible in a way meetings are not.
 *     Both numbers are entries rather than rows, which is what makes the
 *     comparison behind `series_errors_truncated` exact; a row reported
 *     twice consumes two entries of this cap, and a calendar where every
 *     broken rule is broken in two ways fits half as many rows under
 *     it.
 *
 * Refusing here would be wrong. The series pass is unwindowed, so a
 * refusal could not be recovered from by asking for a narrower window: a
 * calendar with 501 broken rules would receive no calendar at all, its
 * healthy series having expanded perfectly well. That is a fail-closed
 * scan ceiling, one array over.
 *
 * Trimming bounds the retention as well as a refusal would: accumulation
 * stops here, so the array in memory is bounded by this and by
 * `MAX_SERIES_ERROR_MESSAGE_CHARS` whatever is stored, and the request
 * still succeeds.
 */
export const MAX_SERIES_ERRORS = 500;

/**
 * Longest reported expansion-failure message.
 *
 * A count alone does not bound bytes. Most of these messages are this
 * file's own fixed strings, but the malformed-rule ones quote the stored
 * text they could not read, which is as long as whatever was stored. This
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

/** Rows read per page while gathering the events to expand: the storage
 *  layer's own ceiling, which `items.list` clamps any larger `limit` to. */
const EVENT_PAGE_SIZE = MAX_PAGE_LIMIT;

/**
 * Ids handed to one batched storage call.
 *
 * Both batched reads below build a single `IN (...)` from every id they
 * are given and neither chunks internally, so an unchunked call from
 * here turns a large calendar into a statement carrying more bind
 * parameters than SQLite will accept. The scan is uncapped, so that is
 * reachable, and a SQLite error is not an improvement on a refusal.
 */
const ID_BATCH_SIZE = 500;

/**
 * Series expanded between one yield to the event loop and the next.
 *
 * This bounds the *number of per-series parses* between yields, which
 * the iteration budget below cannot see: reading a series' lines happens
 * once per series whatever its rule says, and a rule that cannot be read
 * costs a parse and zero iterations. Both counters run, and whichever
 * trips first yields.
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
 * A series count is the wrong unit for the expansion's cost, so the loop
 * is not paced by it alone. `expandSeries` is synchronous and one call
 * walks up to `MAX_EXPANSION_ITERATIONS` — 100,000 — so 32 series
 * between yields would permit 3.2 million iterations in a single
 * uninterrupted stretch of CPU, with health checks, open streams and
 * every other request on the instance waiting behind it. That is not an
 * exotic shape: a `FREQ=MINUTELY` reminder created a year ago burns the
 * whole cap on every read, forever. Paced by series alone, 32 of them
 * between yields measured 11.5 seconds through the route, invariant in
 * the number of series because the stretch is always exactly 32
 * expansions deep.
 *
 * **The bound this buys, stated in the unit that costs:** one
 * uninterrupted stretch walks at most
 * `ITERATIONS_PER_YIELD + MAX_EXPANSION_ITERATIONS - 1` iterations —
 * 119,999 at these values. The second term is irreducible here and is
 * most of the bound: one `expandSeries` call is atomic, so a stretch can
 * always be one full expansion longer than the budget that admitted it.
 * Shrinking it means either refusing more rules or making the expansion
 * itself resumable, and a rule's phase is anchored at the series start,
 * so it cannot be resumed mid-stream.
 *
 * **What this does not bound:** the total work one request may do. It
 * paces the loop, it does not stop it, and a paced loop still runs for
 * as long as the data gives it work.
 * `MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS` stops the loop, but over one
 * part of that work rather than over the sum of it: iterations spent on
 * expansions that return no occurrence. Nothing in this file bounds
 * the total, and
 * that constant's docblock says what the remainder is worth.
 */
const ITERATIONS_PER_YIELD = 20_000;

/**
 * Rule iterations one request may spend on expansions that return no
 * occurrence, before it stops expanding.
 *
 * ## What it bounds
 *
 * The error list is trimmed rather than refused, so nothing else stops
 * one request walking every stored series. Measured through the route:
 * 40 `FREQ=MINUTELY` rules each burning `MAX_EXPANSION_ITERATIONS` took
 * 13.5 seconds, about 340 ms of CPU per rule, and nothing about that
 * number stops at 40. Fifty thousand such rules is hours of CPU on one
 * request. The event loop is fine — `ITERATIONS_PER_YIELD` hands it back
 * throughout — but a request that answers in an hour is not, and no
 * other bound in this file has anything to say about it.
 *
 * ## Why it counts only the series that contribute nothing
 *
 * Because crossing it stops the expansion, and a stop that lands on a
 * healthy series takes that series' meetings off the calendar. A budget
 * denominated in work that put nothing on the calendar is spent by
 * exactly the shape this exists to stop; a budget over all iterations
 * would instead be spent fastest by the calendar with the most meetings
 * in it.
 *
 * **The predicate is what the expansion RETURNED, not what the rule
 * produced and not what reached `data`.** The charge is `expanded.length
 * === 0` at the call site, and `data` is assembled two stages later,
 * behind a fetch and a filter this charge never consults. So a series
 * whose occurrences are all dropped after the fetch is not charged for
 * the walk that produced them.
 *
 * **That gap cannot be closed by charging later, and it is worth saying
 * why rather than leaving it as an omission.** The only filter between
 * the two is the one that drops a row deleted, trashed or moved out of
 * `active` between the scan and the fetch — a concurrent mutation, not
 * an ordinary calendar shape. Charging where `data` is assembled would
 * mean charging after the scan loop has finished and every series has
 * already been walked, which turns a ceiling that stops work into a
 * counter that reports it. The check at the head of the loop is placed
 * before the expansion for exactly that reason.
 *
 * The looseness a caller would actually notice is the one recorded
 * below under what this does not bound, and it is much larger than this
 * one: a series that does emit is never charged at all.
 *
 * Against what the rule produced, the difference is a real class rather
 * than a quibble. Three ways an expansion returns nothing:
 *
 *   - it walked and its rule put no occurrence in the window;
 *   - it hit `MAX_EXPANSION_ITERATIONS` before reaching the window;
 *   - it hit `MAX_OCCURRENCES_PER_SERIES` — **having produced
 *     occurrences, which the refusal then discarded.**
 *
 * The third is charged like the other two and should be: the expansion
 * returned nothing and the walk that made the discarded occurrences is
 * spent. Measured: one `FREQ=MINUTELY` rule starting at the opening of a
 * seven-day window is refused at 2,000 occurrences and charges 2,001
 * iterations, which `occurrences.pagination.test.ts` pins. So a charged
 * series may well have produced occurrences; what is true by construction
 * is that its expansion returned none.
 *
 * ## Why crossing it is a 200 and not a 400
 *
 * The walk is pre-window: a rule's phase is anchored at the series
 * start, so the iterations counted here are burned before the window is
 * reached and asking for a narrower window does not reduce them. A
 * refusal here would therefore be unrecoverable, a fail-closed ceiling
 * on the whole read. So the
 * read succeeds, `scan.series_unexpanded` says how many series were left
 * unexpanded, and `expansion_incomplete` says the calendar may be
 * missing what they held. Series are walked in the store's keyset order,
 * so which prefix is expanded is the same on every retry rather than
 * flickering between reads.
 *
 * ## What it does not bound, and what that costs
 *
 * **Work on series that do emit.** Those iterations are never charged
 * here at all, and this is the ordinary case rather than an exotic one.
 * The dead-history arithmetic above applies unchanged to a decade-old
 * daily rule that is still running: it walks the same few thousand
 * iterations to reach the window, it is commoner than one that ended,
 * and because it then contributes, none of that is charged. Counted
 * exactly, through the expander's own accumulator: 100 such rules over
 * a seven-day window walk 366,100 iterations and report
 * `unproductive_iterations` as zero, against 1,000 for the same hundred
 * anchored the day before the window, which return the same seven
 * hundred occurrences and the same zero. Five thousand of them — a
 * large calendar, not a contrived one — is 18 million iterations, which
 * timed at about a minute when this was measured on a wall clock, still
 * with nothing on the counter and no flag.
 *
 * What stops it being unbounded is the occurrence ceiling rather than
 * anything here — a series emitting more than once reached the window
 * sooner and walked less — so the worst case is `MAX_OCCURRENCES` series
 * emitting once each: 500 million iterations, extrapolating to about
 * half an hour, and then a 400. That is a constant rather than a bound
 * that grows with the corpus, which is the whole of what changed, and it
 * is not a small one.
 *
 * **What the number is.** Two million is twenty full per-series
 * expansions, measured at 6.0 seconds of CPU end to end through the
 * route at this value, so it is a ceiling on the shape below rather
 * than a target anything ordinary approaches. The tests exercise the
 * mechanism at a fraction of it — see `OccurrenceRouteOptions` — and
 * pin this number by equality rather than by spending it.
 *
 * **A large calendar's dead history is charged like a pathological
 * rule**, because from here the two are indistinguishable: both walk and
 * contribute nothing. A daily rule that ran for a decade and ended costs
 * about
 * 3,650 iterations on every read of a later window, so roughly 550 of
 * them fill this budget, against 20 per-minute rules. A calendar past that
 * gets a partial calendar and is told so. Narrowing that would mean
 * knowing a rule's last instant before expanding it, which is the
 * indexed column the note at the top of this file says the schema does
 * not have.
 */
export const MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS = 2_000_000;

/** Hand the event loop one turn: `setImmediate` runs after the pending
 *  I/O and timer callbacks rather than ahead of them, which a resolved
 *  promise would not, being a microtask. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The type whose items this route reads: the one declaring the event shape. */
const EVENT_TYPE = "core.event";

/** Rows read so far by one request, summed across its passes. Reported
 *  on the response rather than compared against anything: what the read
 *  cost is worth knowing, and it is not grounds for refusing. */
interface ScanBudget {
  scanned: number;
}

/** The storage-side narrowing one pass applies on top of type and state. */
type EventScanNarrowing = Pick<ItemFilters, "hasProperty" | "spanOverlaps">;

/** What every pass reads: the `type` the request names, else the event
 *  type, narrowed by the credential and the instance's source filter as
 *  `GET /items` narrows a listing. */
type EventScanScope = Pick<
  ItemFilters,
  "type" | "allowed_types" | "excluded_types" | "source_filter"
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
  /** The span the window is matched against, as the normalized columns
   *  derive it. */
  span: { start: string | null; end: string | null };
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
  scope: EventScanScope,
  budget: ScanBudget,
  narrowing: EventScanNarrowing,
  project: (item: Item) => T | undefined,
): Promise<T[]> {
  const kept: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.items.list({
      ...scope,
      state: "active",
      limit: EVENT_PAGE_SIZE,
      ...narrowing,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    budget.scanned += page.data.length;
    for (const item of page.data) {
      // A `type` filter may reach past the event types; only they unfold.
      if (!typeAnswersSubtreeFilter(item.type, EVENT_TYPE)) continue;
      const projected = project(item);
      if (projected !== undefined) kept.push(projected);
    }
    cursor = page.next_cursor ?? undefined;
    // Between pages for the same reason the expansion yields between
    // batches. On a driver that answers over a socket the await above
    // already returns the loop; on an embedded one it does not, and a
    // walk of tens of thousands of rows is then a single stretch of
    // synchronous reads and JSON parsing with every other request on
    // the process behind it.
    if (cursor !== undefined) await yieldToEventLoop();
  } while (cursor !== undefined);
  return kept;
}

/**
 * What the series pass keeps from a row: a series to expand, something
 * to report about its rule, or both.
 *
 * Both, because the two are independent. A rule with one unreadable line
 * among readable ones still expands and is still worth reporting, and a
 * row whose rule cannot be read at all still renders as a single event
 * through the window pass. Collapsing this to "expandable or broken"
 * is what made the drops below invisible: `undefined` from here is a
 * row the response says nothing about, and three classes of genuinely
 * broken row were reaching it.
 */
interface SeriesScanResult {
  /** Item id of the row, needed for a defect with no series behind it. */
  id: string;
  /** The series to expand. Absent when the rule cannot be read at all. */
  series?: RecurrenceSeries;
  /** What could not be read about this row's rule, phrased for
   *  `series_errors`. Absent when there was nothing wrong with it. */
  defect?: string;
}

/**
 * Read one scanned row as a series, and say what could not be read.
 *
 * The pass is narrowed on `recurrence` being present, so every row
 * arriving here declares a rule. Returning `undefined` therefore means
 * one thing only — the row declares *no* rule, which `[]` and a
 * serializer's `null` both are — and every other way of failing to
 * produce a series is a defect the response reports. Without that
 * distinction, a rule-bearing row with no `starts_at` would be dropped
 * here *and* by the window pass for carrying a rule, so it would appear
 * nowhere in the response and `series_errors` would count it as zero.
 * `core.event` requires only `title`, so writing one is a 201.
 *
 * `recurrence` is declared as an array of strings but validated only as
 * an array, so a non-string entry stores. One that filters the list
 * empty leaves the row rendering as a plain single event with its rule
 * silently unapplied; one among readable lines silently drops whatever
 * that line was, and an EXDATE dropped this way puts back the very
 * occurrences it existed to remove.
 */
function projectSeries(item: Item): SeriesScanResult | undefined {
  const raw = item.properties.recurrence;
  // `null` is how a serializer writes an absent optional value; the
  // storage layer coerces it away on the way in, and reading it as
  // "no rule" here rather than as a defect keeps the two agreeing.
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    return {
      id: item.id,
      defect: `Series ${item.id} has a recurrence that is not a list of RFC 5545 property lines, so no rule was applied`,
    };
  }
  // An empty list is an explicit "this does not repeat".
  if (raw.length === 0) return undefined;

  const recurrence = raw.filter(
    (line): line is string => typeof line === "string",
  );
  const dropped = raw.length - recurrence.length;
  if (recurrence.length === 0) {
    return {
      id: item.id,
      defect: `Series ${item.id} has a recurrence holding no readable property line, so no rule was applied`,
    };
  }

  const startsAt = stringProp(item, "starts_at");
  if (startsAt === undefined) {
    return {
      id: item.id,
      defect: `Series ${item.id} carries a recurrence rule but no readable starts_at to unfold it from`,
    };
  }

  return {
    id: item.id,
    series: {
      id: item.id,
      starts_at: startsAt,
      ends_at: stringProp(item, "ends_at"),
      ...(typeof item.properties.duration === "number"
        ? { duration: item.properties.duration }
        : {}),
      ...(item.properties.all_day === true ? { all_day: true } : {}),
      timezone: stringProp(item, "timezone"),
      recurrence,
    },
    ...(dropped > 0
      ? {
          defect: `Series ${item.id} has ${String(dropped)} recurrence ${dropped === 1 ? "entry that is not a property line" : "entries that are not property lines"}; ${dropped === 1 ? "it was" : "they were"} ignored and the rest of the rule was applied`,
        }
      : {}),
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
  //
  // A row whose `recurrence` holds nothing readable falls through this
  // test and renders here as the single event its own times describe,
  // which is the best answer available for it. It is not a silent one:
  // the series pass reports the unapplied rule in `series_errors`.
  if (recurrenceProp(item).length > 0) return undefined;
  const span = instantColumnValues(item.properties);
  return {
    id: item.id,
    starts_at: startsAt,
    ends_at: stringProp(item, "ends_at"),
    span: { start: span.starts_at, end: span.ends_at },
  };
}

/**
 * Whether a span overlaps `[from, to)`, as RFC 4791 reads a time range: it
 * starts before the window ends and ends after it opens. A span with no
 * length overlaps where it starts.
 */
function overlapsWindow(
  start: string | null,
  end: string | null,
  from: Date,
  to: Date,
): boolean {
  if (start === null) return false;
  const s = Date.parse(start);
  if (s >= to.getTime()) return false;
  const e = end === null ? s : Date.parse(end);
  return e > s ? e > from.getTime() : s >= from.getTime();
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
  type: string,
): Promise<RecurrenceSeries[]> {
  const scanned = await scanEvents(
    storage,
    { type },
    { scanned: 0 },
    { hasProperty: "recurrence" },
    projectSeries,
  );
  return scanned.flatMap((row) =>
    row.series !== undefined ? [row.series] : [],
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
  ids: readonly string[],
): Promise<Map<string, Item>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Item>();
  for (let i = 0; i < unique.length; i += ID_BATCH_SIZE) {
    const slice = unique.slice(i, i + ID_BATCH_SIZE);
    for (const [id, item] of await storage.items.getMany(slice)) {
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
 * included — per stored exception until the last chunk landed,
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
    // order. Iterating the returned map instead would preserve that too,
    // since it is keyed by the same ids, so the slice walk is not what
    // keeps the order.
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

const OccurrenceSchema = z
  .object({
    starts_at: z.string().describe("When the occurrence starts, in UTC."),
    ends_at: z
      .string()
      .optional()
      .describe(
        "When the occurrence ends, in UTC. A whole-day event ends at midnight in its `timezone`, or in UTC if it has none. One computed from a rule lasts as long as its series' first; any other ends at its item's `ends_at`. Absent when it has no end.",
      ),
    item: ItemSchema.describe(
      "The event: the series for an occurrence computed from its rule, otherwise the occurrence's own item.",
    ),
    series_id: z
      .string()
      .optional()
      .describe(
        "The ID of the recurring event the occurrence belongs to. Absent on an event that doesn't recur.",
      ),
    replaces: z
      .string()
      .optional()
      .describe(
        "The start, in UTC, of the computed occurrence this stored exception takes the place of. Present only on an exception.",
      ),
  })
  .describe("One time an event happens.")
  .openapi("Occurrence");

const SeriesErrorSchema = z.object({
  item_id: z.string().describe("The ID of the recurring event."),
  message: z
    .string()
    .describe("What is wrong with its rule, for a person to read."),
});

const ScanSchema = z.object({
  events_read: z
    .number()
    .int()
    .describe(
      "How many event items this request read. It grows with the size of the calendar more than with the window.",
    ),
  occurrences: z.number().int().describe("How many occurrences `data` holds."),
  max_occurrences: z
    .number()
    .int()
    .describe(
      "The most occurrences a window may hold; a window with more is refused. Compare it with `occurrences` to see a calendar approaching it.",
    ),
  series_errors: z
    .number()
    .int()
    .describe(
      "How many failures Marfa found in the recurrence rules this request read, as entries of `series_errors`, including any the list leaves out. It covers only the event types read, so `0` says nothing of the rest.",
    ),
  max_series_errors: z
    .number()
    .int()
    .describe(
      "The most entries `series_errors` holds. Past it, the list stops and `series_errors_truncated` is `true`; the read still succeeds.",
    ),
  unproductive_iterations: z
    .number()
    .int()
    .describe(
      "How many rule iterations this request spent on expansions that returned no occurrence, such as a rule that ended before the window. A rule that fails before it iterates adds nothing here.",
    ),
  max_unproductive_iterations: z
    .number()
    .int()
    .describe(
      "The most `unproductive_iterations` a request spends before it stops expanding. Iterations that return occurrences don't count, so a busy calendar doesn't reach it.",
    ),
  series_unexpanded: z
    .number()
    .int()
    .describe(
      "How many series didn't finish expanding: stopped by their own bound, and listed in `series_errors`, or never reached once `max_unproductive_iterations` was spent. Above `0`, `expansion_incomplete` is `true`.",
    ),
});

const OccurrencesResponseSchema = z
  .object({
    data: z
      .array(OccurrenceSchema)
      .describe("The occurrences that overlap the window, by start time."),
    next_cursor: NextCursorSchema.describe(
      "Always `null`: Marfa returns every occurrence in the window in one page.",
    ),
    window: z
      .object({
        from: z.string().describe("The start of the window, in UTC."),
        to: z.string().describe("The end of the window, in UTC."),
      })
      .describe("The window you asked for, in UTC."),
    // Always present: a bound that is only mentioned when it fires
    // announces itself too late to act on.
    scan: ScanSchema.describe(
      "What this read cost, and the limits that would stop it.",
    ),
    /** One entry per failure found in a rule — malformed, flooding the
     *  window, no start to unfold from, an unresolvable timezone, or a
     *  `recurrence` holding something that is not a property line. One row
     *  can produce two, so entries are the unit here and in the count
     *  beside it. The rest of the calendar still returns; failing the
     *  whole read for one bad series would make a single six-year-old
     *  meeting take the calendar down. Capped at `MAX_SERIES_ERRORS`
     *  entries, past which `series_errors_truncated` is set and
     *  `scan.series_errors` carries the real total. */
    series_errors: z
      .array(SeriesErrorSchema)
      .optional()
      .describe(
        "One entry per failure found in a recurrence rule, such as a line Marfa can't read or a timezone that doesn't resolve. One event can have several entries and still appear in `data`. Absent when there were none.",
      ),
    series_errors_truncated: z
      .boolean()
      .optional()
      .describe(
        "`true` when `series_errors` stops at `scan.max_series_errors` entries and leaves failures out. `scan.series_errors` has the total. Absent otherwise.",
      ),
    expansion_incomplete: z
      .boolean()
      .optional()
      .describe(
        "`true` when a series didn't finish expanding, so `data` may be missing occurrences; `scan.series_unexpanded` counts them. If a series has too many in the window, narrow the window; else narrow by `type` or fix the rules. Absent otherwise.",
      ),
  })
  .describe(
    "The occurrences in a time window, with what reading them cost and any rules Marfa couldn't apply.",
  )
  .openapi("OccurrencePage");

const occurrencesRoute = createRoute({
  operationId: "listOccurrences",
  method: "get",
  path: "/",
  tags: ["Items"],
  summary: "List occurrences",
  description:
    "Returns the events that overlap a time window, with each recurring event expanded into one entry per occurrence. Marfa computes occurrences when you read them and doesn't store them.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    query: z.object({
      from: z
        .string()
        .describe(
          "Window start, ISO 8601. An event overlaps the window if it starts before `to` and ends after this time. Its end is `ends_at`, else its start plus `duration`. A whole-day event fills whole days in its `timezone`, or in UTC if it has none.",
        ),
      to: z
        .string()
        .describe(
          "Window end, ISO 8601. The window can span at most 400 days. An event with no length is in the window if it starts at or after `from` and before this time.",
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Only return events of this type, or of the event types a wildcard matches.",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: OccurrencesResponseSchema },
      },
      description:
        "Returns occurrences ordered by start time. A recurring event gives an entry per occurrence, with `series_id`. A stored exception replaces its occurrence and carries `replaces`. A rule Marfa can't read or fully apply is listed in `series_errors`, and `expansion_incomplete` is `true` if an expansion didn't finish.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "unknown_type",
            "validation_error",
          ]),
        },
      },
      description:
        "- `missing_required_field`: `from` or `to` is missing.\n- `unknown_type`: `type` isn't registered.\n- `validation_error`: a time is unreadable, `to` isn't after `from`, the window is over 400 days, `type` is malformed, or the window holds more than 5,000 occurrences. Then `details` has `max_occurrences` and `found`, and `expansion_incomplete` if a series also stopped expanding.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description:
        "- `type_not_permitted`: your credential reaches no type, or `type` is a registered type you can't read with none readable under it.",
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

/** What a caller may vary about this route. */
export interface OccurrenceRouteOptions {
  /**
   * Ceiling on iterations spent on series that contribute nothing,
   * defaulting to `MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS`.
   *
   * Here so a test can reach the ceiling without spending it. Pinning a
   * bound denominated in rule iterations means walking them, and at the
   * production value that is six seconds per test on a box that also
   * runs CI. Every assertion about the behavior is written against
   * whatever value is in force — how far past the ceiling one expansion
   * may carry the total, how many series go unexpanded, what the
   * refusal carries — so a tenth of it exercises the same code and the
   * same arithmetic. The production number is pinned by a separate
   * equality check, which is the assertion that would otherwise have
   * been buried inside a slow one.
   */
  maxUnproductiveIterations?: number;
}

export function occurrenceRoutes(
  storage: Storage,
  options: OccurrenceRouteOptions = {},
) {
  const maxUnproductiveIterations =
    options.maxUnproductiveIterations ?? MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS;
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(occurrencesRoute, async (c) => {
    requireAuth(c);
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
    // The same judgment `/items`, `/search` and `/export` make, reasoned at
    // `assertTypeFilter`.
    assertTypeFilter(c, query.type);

    // Three passes, because the calendar is three different questions
    // and only one of them is about the window. Each keeps its own
    // projection of a row and never the row: see the note at the top of
    // this file for why that is what makes an unbounded scan safe.
    const budget: ScanBudget = { scanned: 0 };
    const typeFilter = getTypeFilter(c);
    const enforcement = resolveEnforcement(
      await readInstanceConfig(storage.settings),
      c.get("apiKey"),
    );
    const scope: EventScanScope = {
      type: query.type ?? EVENT_TYPE,
      allowed_types: typeFilter.allowed,
      excluded_types: typeFilter.excluded,
      source_filter: enforcement.source_filter,
    };

    // Series. Unwindowed by necessity — a rule written years ago
    // produces occurrences in any window, so the window says nothing
    // about which rules matter.
    const seriesScan = await scanEvents(
      storage,
      scope,
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
      scope,
      budget,
      { hasProperty: "original_starts_at" },
      projectException,
    );

    // Standalone events, narrowed to the window in SQL against the
    // normalized instant column. Bounded by the window, unlike the two
    // above, so this is the one pass whose size a caller can influence.
    const windowSeeds = await scanEvents(
      storage,
      scope,
      budget,
      { spanOverlaps: { from: from.toISOString(), to: to.toISOString() } },
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

    /** Iterations spent on expansions that returned no occurrence,
     *  which is the work `MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS` bounds.
     *  Not the same as "produced nothing": a series refused for flooding
     *  the window produced occurrences and the refusal discarded them.
     *  Nor the same as "reached `data`", which is assembled later behind
     *  a filter this charge does not consult. */
    let unproductiveIterations = 0;
    /** Series the ceiling stopped this request from reaching. Reported,
     *  because a stop nobody is told about is a calendar quietly missing
     *  meetings, which is the one outcome worth less than a slow read. */
    let seriesUnexpanded = 0;

    const pending: PendingOccurrence[] = [];
    /**
     * Append one occurrence, refusing the moment the window is over full.
     *
     * The check belongs at the append rather than after the loops
     * because a limit has to fail toward something bounded: a ceiling
     * that is only consulted once everything it would have refused is
     * already assembled does not make the work smaller, it only makes
     * the answer a 400. Unbounded is not slower — a calendar dense enough
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
          {
            max_occurrences: MAX_OCCURRENCES,
            found: pending.length + 1,
            // Carried on the refusal as well as on the 200, because the
            // two compose and the advice differs. Expansion can exhaust
            // its budget and the window pass then cross this ceiling, in
            // which case "narrow the window" returns a calendar that is
            // partial for a second reason the caller was never told
            // about. A caller that reads this narrows by `type` instead.
            ...(seriesUnexpanded > 0
              ? {
                  expansion_incomplete: true,
                  series_unexpanded: seriesUnexpanded,
                }
              : {}),
          },
        );
      }
      pending.push(occurrence);
    };
    const seriesErrors: { item_id: string; message: string }[] = [];
    /** Series that failed, including the ones past the list's cap. What
     *  makes the cap reportable rather than merely silent. */
    let seriesErrorCount = 0;
    /**
     * Record one series whose rule could not be read or could not be
     * fully applied, listing it while the list has room and counting it
     * either way.
     *
     * Two sources reach this. `projectSeries` reports what it can tell
     * from the row alone — a `recurrence` that is not a list, one
     * holding no readable property line, one whose readable lines have
     * no `starts_at` to unfold from, and one carrying entries that are
     * not property lines beside readable ones. `expandSeries` reports
     * its own refusals, the unresolvable timezone among them.
     *
     * **This is a list, not a guarantee.** A row listed here is a rule
     * the read could not use *or could not fully apply*: the fourth
     * projection class above is reported and still expands, contributing
     * every occurrence its readable lines produce.
     *
     * An entry names a row and a
     * thing that was wrong with its rule. It does not say the row is
     * absent from `data`, and the absence of an entry does not say the
     * row is sound. Whether some other way of being broken has no path
     * to this function is a question for whoever next goes looking, and
     * `scan.series_errors` should be read as a floor.
     *
     * **One row can arrive here twice**, and the count is in entries
     * rather than in rows because of it: a rule whose unreadable line
     * was dropped is reported by the projection and reported again if
     * expanding what was left then fails. Both are true and both name
     * the row through `item_id`, so a caller counting distinct rules
     * groups on that rather than reading the length.
     *
     * Counting past the cap costs one integer and is the difference
     * between "at least 500 failures" and "50,000", which is the
     * difference between a caller ignoring it and a caller stopping an
     * import. See `MAX_SERIES_ERRORS` for why this array is the one
     * place in this file where trimming beats refusing.
     */
    const appendSeriesError = (itemId: string, message: string): void => {
      seriesErrorCount += 1;
      if (seriesErrors.length >= MAX_SERIES_ERRORS) return;
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
    const seenSeries = new Set<string>();
    // Two budgets, one for each thing an expansion costs. See
    // `SERIES_PER_YIELD` and `ITERATIONS_PER_YIELD`; neither substitutes
    // for the other, so whichever fills first hands the loop back.
    let seriesSinceYield = 0;
    let iterationsSinceYield = 0;
    const work: ExpansionWork = { iterations: 0 };
    for (const scanned of seriesScan) {
      if (seenSeries.has(scanned.id)) continue;
      seenSeries.add(scanned.id);

      // Reported whether or not there is a series behind it, and before
      // the ceiling below, because reading a row's rule cost nothing the
      // ceiling is counting: the row is already in hand.
      if (scanned.defect !== undefined) {
        appendSeriesError(scanned.id, scanned.defect);
      }
      const seed = scanned.series;
      if (seed === undefined) continue;

      // Checked before the expansion rather than after it, so the
      // ceiling bounds the work done rather than merely reporting on it.
      // The series that crossed it has already been walked; this one and
      // everything after it are not.
      if (unproductiveIterations >= maxUnproductiveIterations) {
        seriesUnexpanded += 1;
        continue;
      }

      seriesSinceYield += 1;
      if (
        seriesSinceYield >= SERIES_PER_YIELD ||
        iterationsSinceYield >= ITERATIONS_PER_YIELD
      ) {
        seriesSinceYield = 0;
        iterationsSinceYield = 0;
        await yieldToEventLoop();
      }

      // Initialized empty rather than assigned in every path: a series
      // that threw contributed nothing, which is what both the charge below
      // and the append loop after it need to know, so the failure needs
      // no flag of its own.
      let expanded: Occurrence[] = [];
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
        if (!(err instanceof RecurrenceExpansionError)) throw err;
        appendSeriesError(seed.id, err.message);
        // Stopped by its own bound rather than refused: the series may hold
        // occurrences in this window that were never reached.
        if (err instanceof RecurrenceExpansionStopped) seriesUnexpanded += 1;
      } finally {
        // In a `finally` because the refusal above is the expensive
        // case: a rule that walks the full iteration cap and yields
        // nothing is precisely what both budgets have to charge for, and
        // an early exit from the catch would otherwise skip the charge.
        const spent = work.iterations - before;
        iterationsSinceYield += spent;
        // Charged only when the expansion returned nothing, which
        // is what keeps the total-work ceiling from being spent by a
        // calendar that is merely full of meetings. A throw leaves this
        // empty whatever the rule computed, so a series refused for
        // flooding the window is charged for the walk that produced the
        // occurrences the refusal discarded — deliberate, and stated on
        // `MAX_UNPRODUCTIVE_EXPANSION_ITERATIONS`.
        if (expanded.length === 0) unproductiveIterations += spent;
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

    // A stored exception names its series and the slot it replaced whether
    // or not this window holds that slot, so an exception shown at its own
    // time carries both even where the expansion above never reached it.
    // Only a series the scan read is named: an edge can point at a row this
    // credential may not read.
    const exceptionSlots = new Map<
      string,
      { series_id: string; replaces: string }
    >();
    for (const [seriesId, exceptions] of exceptionsBySeries) {
      if (!seenSeries.has(seriesId)) continue;
      for (const exception of exceptions) {
        const slot = Date.parse(exception.original_starts_at);
        if (Number.isNaN(slot)) continue;
        exceptionSlots.set(exception.id, {
          series_id: seriesId,
          replaces: new Date(slot).toISOString(),
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
      // The SQL does the narrowing. This is a belt: it is the
      // one place the normalized column and the stored value are read
      // against each other, so a column that ever disagreed with its row
      // shows up as a missing event rather than a wrong one.
      if (
        Number.isNaN(at.getTime()) ||
        !overlapsWindow(seed.span.start, seed.span.end, from, to)
      ) {
        continue;
      }
      appendPending({
        starts_at: at.toISOString(),
        ends_at:
          seed.ends_at !== undefined
            ? toInstantString(seed.ends_at, seed.ends_at)
            : undefined,
        item_id: seed.id,
        ...exceptionSlots.get(seed.id),
      });
    }

    // The only place a whole row is read, and it is reached only for the
    // occurrences being returned. One row can answer many occurrences, so
    // the ids are deduplicated on the way in.
    const shownById = await fetchItemsBatched(
      storage,
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
       * One rule, because the yields above widen the gap between scan
       * and fetch to the length of the whole request. A standalone row
       * rendered from the scan-time projection, beside a replacement
       * re-derived from the fetched item, would have two rows in one
       * response follow opposite rules, and a meeting moved while the
       * request was in flight would render its old slot beside the new
       * `item.properties.starts_at`, in the same object, contradicting
       * itself.
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
       * `replaces` follows — a moved instance is shown at its
       * own time, which may fall outside the window — and applying it to
       * a standalone row that moved is the same answer to the same
       * question.
       */
      const itemIsAuthority =
        occurrence.series_id === undefined || occurrence.replaces !== undefined;

      if (itemIsAuthority && occurrence.replaces !== undefined) {
        // A moved occurrence belongs to the window its own times overlap,
        // not to the one its old slot sat in. Its slot is still shadowed.
        const span = instantColumnValues(shown.properties);
        if (
          span.starts_at !== null &&
          !overlapsWindow(span.starts_at, span.ends_at, from, to)
        ) {
          continue;
        }
      }

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

        // A whole-day item is shown at the span a whole-day series places
        // each occurrence by, so a day reads the same single or repeating.
        const wholeDay =
          shown.properties.all_day === true
            ? instantColumnValues(shown.properties)
            : undefined;
        const shownEndsAt =
          wholeDay !== undefined
            ? (wholeDay.ends_at ?? undefined)
            : stringProp(shown, "ends_at");
        results.push({
          starts_at:
            wholeDay?.starts_at ??
            toInstantString(
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
    return c.json(
      {
        data: results,
        next_cursor: null,
        window: { from: from.toISOString(), to: to.toISOString() },
        scan: {
          events_read: budget.scanned,
          occurrences: results.length,
          max_occurrences: MAX_OCCURRENCES,
          series_errors: seriesErrorCount,
          max_series_errors: MAX_SERIES_ERRORS,
          unproductive_iterations: unproductiveIterations,
          max_unproductive_iterations: maxUnproductiveIterations,
          series_unexpanded: seriesUnexpanded,
        },
        ...(seriesErrors.length > 0 ? { series_errors: seriesErrors } : {}),
        ...(seriesErrorCount > seriesErrors.length
          ? { series_errors_truncated: true }
          : {}),
        ...(seriesUnexpanded > 0 ? { expansion_incomplete: true } : {}),
      },
      200,
    );
  });

  return router;
}
