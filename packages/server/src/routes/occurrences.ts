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
import type { Storage } from "../storage/interface.js";
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
 * Types whose items this route reads. Anything declaring the event
 * shape belongs here; `compatible_with` is what makes the Google type
 * readable through the same fields.
 */
const EVENT_TYPES = ["core.event", "google.calendar.event"] as const;

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

    const items: Item[] = [];
    for (const type of wanted) {
      const page = await storage.items.list({
        spaceId,
        type,
        state: "active",
        limit: 1000,
      });
      items.push(...page.data);
    }

    // An exception names its series through parent-of, so the series is
    // resolved from the edge rather than from a property: the property
    // would be a second, drift-prone copy of the same fact.
    const exceptionsBySeries = new Map<string, RecurrenceException[]>();
    for (const item of items) {
      const originalStartsAt = stringProp(item, "original_starts_at");
      if (originalStartsAt === undefined) continue;
      const parents = await storage.edges.listToTarget(item.id, {
        edge_type: "parent-of",
      });
      const seriesId = parents.data[0]?.source_id;
      if (seriesId === undefined) continue;
      const list = exceptionsBySeries.get(seriesId) ?? [];
      list.push({ id: item.id, original_starts_at: originalStartsAt });
      exceptionsBySeries.set(seriesId, list);
    }

    const byId = new Map(items.map((item) => [item.id, item]));
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
    for (const item of items) {
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

    for (const item of items) {
      if (recurrenceProp(item).length > 0) continue;

      // An exception an expansion consumed is already shown through its
      // series; showing it here too would double it.
      if (consumedExceptions.has(item.id)) continue;

      const startsAt = stringProp(item, "starts_at");
      if (startsAt === undefined) continue;
      const at = new Date(startsAt);
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
