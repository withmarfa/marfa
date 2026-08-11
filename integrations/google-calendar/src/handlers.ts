/**
 * Google Calendar bidirectional handlers.
 *
 * Two triggers, one shared echo-suppression + mapping store:
 *
 * - SCHEDULE (10-minute incremental sync, inbound):
 *     Calls Calendar's `events.list` with the stored `syncToken`
 *     (opaque). For each returned event:
 *       - If `status === "cancelled"` → trash the matching Marfa
 *         item if we know its id.
 *       - Else compute `(external_id, content_hash)`. If
 *         echo.shouldSkipReactive(...) → skip (we wrote this
 *         ourselves recently).
 *       - Else upsert as the connection's configured target type.
 *         Record the mapping in the cursor.
 *     Follow `nextPageToken` through every page of the sweep and
 *     store the `nextSyncToken` the final page carries.
 *
 * - ITEM-EVENT (outbound, fires on mutations of the types this
 *   integration targets):
 *     - The reactive bridge already filters self-events; double-check
 *       defensively against `cycle`.
 *     - If we're inside the lag window for this external_id,
 *       defer (return ok=false retry=true).
 *     - For created items: POST to Calendar with a deterministic
 *       client-supplied `id` derived from the Marfa item id.
 *       On 200/201, record mapping + echo.trackOutboundWrite. On
 *       409 (Calendar already has an event with that id from a
 *       prior attempt that didn't persist its cursor write), GET
 *       the event for its current state and record the mapping
 *       idempotently.
 *     - For updated items: PATCH the Calendar event referenced
 *       by the mapping.
 *     - For trashed-state transitions: DELETE the Calendar
 *       event.
 *     - On Calendar 4xx (other than the 409 idempotency case),
 *       surface as `system.activity` with severity action_required
 *       (per partial_write_mode: accept-partial).
 *     - On Calendar 5xx, return retry=true.
 *
 * Idempotency: Cloudflare Queues whole-batch retry semantics mean a
 * transient failure between a successful Calendar POST and the
 * cursor-write produces a duplicate Calendar event on retry. The fix
 * is a deterministic client-supplied `id` on the POST: Calendar
 * accepts a custom `id` (5–1024 chars, base32hex alphabet — hex is a
 * subset, so a SHA-256 hex digest is valid) and returns 409 on
 * conflict, which the handler recognizes as "I already created this
 * event, fetch its current state and record the mapping". The handler
 * therefore produces at most one Calendar event per item id,
 * regardless of retry count.
 */
import {
  registerScheduleHandler,
  registerItemEventHandler,
  registerWebhookHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type ItemEventMessage,
  type WebhookHandlerInput,
  type HandlerResult,
  type CreateItemInput,
  type ItemResource,
} from "@withmarfa/runtime-sdk";
import {
  dateInZoneToInstant,
  declaredConfigurationDefault,
  instantToDateInZone,
} from "@withmarfa/shared";
import {
  CALENDAR_API_BASE,
  DEFAULT_CALENDAR_ID,
  GOOGLE_CALENDAR_MANIFEST,
} from "./manifest.js";

/**
 * The target type an unconfigured connection writes, read from the manifest
 * rather than restated so the two cannot drift.
 *
 * Only reachable for a connection installed before the manifest's declared
 * defaults were written into `configuration` at install time. Every new
 * install carries an explicit `target_type`, so this is a floor for old rows
 * rather than a decision made here.
 */
const DEFAULT_TARGET_TYPE =
  declaredConfigurationDefault(GOOGLE_CALENDAR_MANIFEST, "target_type") ??
  "google.calendar.event";

const CURSOR_KEY = "main";

interface CalendarCursor {
  /** Opaque sync token from Calendar's incremental-sync API (single-
   *  calendar mode only — populated when no `selected_calendar_ids`
   *  is configured). Multi-calendar mode uses `per_calendar[].syncToken`
   *  below. */
  syncToken: string | null;
  /** Opaque page token parking a sweep that hit the per-run page brake
   *  before reaching the page carrying `nextSyncToken` (single-calendar
   *  mode). Null whenever a sweep completed. */
  pageToken?: string | null;
  /** ISO timestamp of the last successful schedule run (single-calendar mode). */
  last_inbound_at: string | null;
  /** Map of Calendar event id → Marfa item id. Used to look up
   *  the Marfa item on echo / update / delete without round-tripping
   *  through the server. Bounded by Calendar's own dedup;
   *  realistically a few hundred to a few thousand entries. The shape
   *  is a flat `Record<string, string>` shared by single-calendar
   *  cursors — the per-event calendar id lives alongside in
   *  `mapping_calendars`. */
  mappings: Record<string, string>;
  /** Multi-calendar mode only: per-event calendar id, so updates and
   *  deletes know which calendar the mapped event lives on. Sparse —
   *  single-calendar cursors leave this undefined and writes go
   *  to the connection's primary calendar. */
  mapping_calendars?: Record<string, string>;
  /** Multi-calendar mode only: per-calendar sync cursor. Top-level
   *  `syncToken` is unused when this is populated. */
  per_calendar?: Record<string, PerCalendarCursor>;
}

interface PerCalendarCursor {
  syncToken: string | null;
  /** Parked page token — see `CalendarCursor.pageToken`. */
  pageToken?: string | null;
  last_inbound_at: string | null;
}

/**
 * Normalized view of the connection's `properties.configuration` for
 * the handler. Single mode (no `selected_calendar_ids`) syncs the primary
 * calendar; multi mode honors the install-time picker selections. Mode
 * decides which calendars are read, and nothing else.
 */
interface ConnectionConfig {
  mode: "single" | "multi";
  /** Single calendar id in single mode; nominated default-write in multi. */
  default_write_calendar_id: string;
  /** All calendars to sync from. Single-entry array in single mode. */
  selected_calendar_ids: string[];
  /** Target type for inbound items, as the manifest declares it. Not a
   *  function of mode: a connection moves between single and multi, and a
   *  target type that moved with it would split one corpus across two types
   *  with no way back. */
  target_type: string;
}

/**
 * Fold a single-calendar cursor into the per-calendar shape.
 *
 * The two shapes were treated as alternatives, but a connection moves
 * between them: an install with no configuration syncs the primary calendar
 * and accumulates a `syncToken` plus a flat `mappings` map, and the moment
 * the picker saves a selection that same connection resolves to multi mode.
 * Nothing carried the old state across, so the first multi sweep started
 * from an empty `per_calendar` and re-listed the calendar from the
 * beginning, and a re-list without a sync token does not carry the
 * cancellations that happened in the gap, which strands the matching Marfa
 * items as orphans nothing will ever trash.
 *
 * `mapping_calendars` is the sharper half. Single mode wrote every mapping
 * without one, and the multi paths read that map to decide which calendar to
 * address on update and delete, falling back to the connection's write
 * target. So after the move, a PATCH for an event that lives on `primary`
 * went to whichever calendar the selection nominated, and a DELETE went
 * there too — where a 404 reads as "already gone", so Marfa reported the
 * event deleted, dropped the mapping, and left the real event untouched on
 * the user's calendar.
 *
 * Everything single mode ever wrote lives on `primary`: it is the only
 * calendar that path ever addressed. So the migration is exact rather than a
 * guess, and it runs once — afterwards `per_calendar` is populated and the
 * legacy fields are cleared.
 */
function adoptSingleCalendarCursor<T extends CalendarCursor>(
  cursor: T,
): asserts cursor is T & {
  per_calendar: Record<string, PerCalendarCursor>;
  mapping_calendars: Record<string, string>;
} {
  const perCalendar = cursor.per_calendar ?? {};
  const mappingCalendars = cursor.mapping_calendars ?? {};

  const hasLegacyPosition =
    cursor.syncToken !== null ||
    cursor.pageToken != null ||
    cursor.last_inbound_at !== null;
  if (hasLegacyPosition && perCalendar[DEFAULT_CALENDAR_ID] === undefined) {
    perCalendar[DEFAULT_CALENDAR_ID] = {
      syncToken: cursor.syncToken,
      pageToken: cursor.pageToken ?? null,
      last_inbound_at: cursor.last_inbound_at,
    };
  }
  // Clearing these is what makes the migration one-way: a later read sees a
  // populated `per_calendar` and no legacy position, so it does nothing.
  cursor.syncToken = null;
  cursor.pageToken = null;
  cursor.last_inbound_at = null;

  for (const externalId of Object.keys(cursor.mappings)) {
    mappingCalendars[externalId] ??= DEFAULT_CALENDAR_ID;
  }

  cursor.per_calendar = perCalendar;
  cursor.mapping_calendars = mappingCalendars;
}

/**
 * Outcome of a config read. A connection record that simply carries no
 * calendar configuration is a legitimate single-"primary" install and
 * resolves `ok`. A lookup that *fails* is a different thing entirely and
 * must not be flattened into the same answer: silently answering
 * "single, primary" for a multi-calendar connection sends outbound
 * writes to the wrong calendar and skips the other selected calendars
 * on the way in, with nothing in the activity feed to distinguish the
 * degraded run from a healthy one.
 */
type ConfigResolution =
  | { ok: true; config: ConnectionConfig }
  | { ok: false; error: unknown };

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConfigResolution> {
  let connection: ItemResource | null;
  try {
    connection = await ctx.marfa.getItem(ctx.connection_id);
  } catch (err) {
    return { ok: false, error: err };
  }

  const props = connection?.properties as
    | { configuration?: Record<string, unknown> }
    | undefined;
  const cfg = props?.configuration ?? {};
  const rawSelected = cfg.selected_calendar_ids;
  const selected: string[] = Array.isArray(rawSelected)
    ? rawSelected.filter((v): v is string => typeof v === "string")
    : [];
  const defaultWrite =
    typeof cfg.default_write_calendar_id === "string" &&
    cfg.default_write_calendar_id.length > 0
      ? cfg.default_write_calendar_id
      : null;
  const targetType =
    typeof cfg.target_type === "string" && cfg.target_type.length > 0
      ? cfg.target_type
      : null;

  // A non-empty selection is the whole signal for multi mode. Requiring
  // `default_write_calendar_id` alongside it meant a connection that named
  // its calendars but not its write target fell through to primary-only —
  // the exact silent degradation this function's contract forbids. Absent a
  // nominated write target, the first selected calendar receives writes.
  const [firstSelected] = selected;
  if (firstSelected !== undefined) {
    return {
      ok: true,
      config: {
        mode: "multi",
        selected_calendar_ids: selected,
        default_write_calendar_id: defaultWrite ?? firstSelected,
        target_type: targetType ?? DEFAULT_TARGET_TYPE,
      },
    };
  }

  // No selection: the primary calendar, which is what an install that
  // configures nothing asks for. The target type is the manifest's, the same
  // as the branch above: this one used to answer `core.event`, so the same
  // connection wrote one type until the picker saved and the other after.
  return {
    ok: true,
    config: {
      mode: "single",
      selected_calendar_ids: [DEFAULT_CALENDAR_ID],
      default_write_calendar_id: DEFAULT_CALENDAR_ID,
      target_type: targetType ?? DEFAULT_TARGET_TYPE,
    },
  };
}

/**
 * Shared entry-point guard: surface a failed config read instead of
 * guessing at the connection's shape. `retry: true` because the failure
 * is a storage-layer blip, not an operator-resolvable misconfiguration.
 */
async function reportConfigFailure(
  ctx: ConnectionContext,
  error: unknown,
): Promise<HandlerResult> {
  return reportFailure(
    ctx,
    "connection configuration lookup failed",
    error,
    true,
  );
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  etag?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  // Multi-calendar / full-fidelity fields (used by `google.calendar.event`
  // target type; safely ignored when target is `core.event`).
  transparency?: string;
  visibility?: string;
  organizer?: { email?: string };
  creator?: { email?: string };
  recurrence?: string[];
  recurringEventId?: string;
  /** Present on an instance that replaces one occurrence of a series;
   *  names the occurrence it replaces. Without it a moved instance
   *  cannot be bound to the slot it came from. */
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string };
  colorId?: string;
}

interface EventsListResponse {
  items?: CalendarEvent[];
  nextSyncToken?: string;
  nextPageToken?: string;
}

/** Calendar's per-page ceiling for `events.list`. */
const EVENTS_PAGE_SIZE = 250;

/**
 * Pages one invocation will fetch before parking the sweep. Bounds a
 * single run at `EVENTS_PAGE_SIZE * MAX_PAGES_PER_SWEEP` events so a
 * first-time backfill of a busy calendar can't exhaust the Worker's
 * time budget; the parked page token resumes the same sweep next tick.
 */
export const MAX_PAGES_PER_SWEEP = 20;

type ListEventsOutcome =
  | {
      kind: "ok";
      /** Set only on the page that carries it — i.e. the last page of a
       *  completed sweep. Null while a sweep is parked mid-pages. */
      syncToken: string | null;
      /** Set when the page brake stopped the sweep early. */
      resumePageToken: string | null;
      eventsSeen: number;
    }
  | { kind: "sync_token_invalid" }
  | { kind: "fetch_failed"; error: unknown }
  | { kind: "http_error"; status: number }
  | { kind: "parse_failed"; error: unknown };

/**
 * Walk `events.list` for one calendar across every page of the current
 * sweep, handing each page's events to `onPage` as it arrives.
 *
 * Calendar returns `nextSyncToken` only on the final page of a result
 * set. A sweep that reads the first page and stops therefore never
 * receives a token: the cursor stays unset and the next tick reissues
 * the identical first-page request forever, with no error to show for
 * it. Following `nextPageToken` to the end is what lets incremental
 * sync make progress on a calendar with more changed events than fit in
 * one page. The sync token (or the backfill page size) rides along on
 * every request — `pageToken` only selects which slice of that same
 * query to return.
 */
async function listEventsPaged(
  ctx: ConnectionContext,
  calendarId: string,
  state: { syncToken: string | null; pageToken: string | null },
  onPage: (events: CalendarEvent[]) => Promise<void>,
): Promise<ListEventsOutcome> {
  let pageToken = state.pageToken;
  let pagesFetched = 0;
  let eventsSeen = 0;

  for (;;) {
    const params = new URLSearchParams();
    if (state.syncToken !== null) params.set("syncToken", state.syncToken);
    else params.set("maxResults", String(EVENTS_PAGE_SIZE));
    if (pageToken !== null) params.set("pageToken", pageToken);
    const path = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;

    let response: Response;
    try {
      response = await ctx.marfa.proxyRequest("GET", path);
    } catch (err) {
      return { kind: "fetch_failed", error: err };
    }
    if (response.status === 410) return { kind: "sync_token_invalid" };
    if (!response.ok) return { kind: "http_error", status: response.status };

    let payload: EventsListResponse;
    try {
      payload = await response.json();
    } catch (err) {
      return { kind: "parse_failed", error: err };
    }

    const events = payload.items ?? [];
    eventsSeen += events.length;
    await onPage(events);
    pagesFetched += 1;

    const nextPageToken =
      typeof payload.nextPageToken === "string" &&
      payload.nextPageToken.length > 0
        ? payload.nextPageToken
        : null;
    if (nextPageToken === null) {
      return {
        kind: "ok",
        syncToken:
          typeof payload.nextSyncToken === "string"
            ? payload.nextSyncToken
            : null,
        resumePageToken: null,
        eventsSeen,
      };
    }
    if (pagesFetched >= MAX_PAGES_PER_SWEEP) {
      return {
        kind: "ok",
        syncToken: null,
        resumePageToken: nextPageToken,
        eventsSeen,
      };
    }
    pageToken = nextPageToken;
  }
}

/**
 * Join a moved or edited instance back to the series it came from.
 *
 * Calendar models an exception as a separate event carrying its
 * series' id and the start of the occurrence it replaces. Marfa models
 * the same fact as a `parent-of` edge from series to instance, which is
 * what lets the occurrence expansion know a computed slot has been
 * taken. Both halves are needed: the edge without `original_starts_at`
 * names a relationship but not which occurrence it displaces.
 *
 * A series Calendar has not sent yet is skipped rather than guessed at.
 * Its instance still exists as an ordinary item, and the next sync that
 * carries the series binds it, because the edge write is idempotent.
 */
async function bindToSeries(
  ctx: ConnectionContext,
  cursor: { mappings: Record<string, string> },
  event: CalendarEvent,
  itemId: string,
): Promise<void> {
  if (event.recurringEventId === undefined) return;
  const seriesItemId = cursor.mappings[event.recurringEventId];
  if (seriesItemId === undefined || seriesItemId === itemId) return;
  await ctx.marfa.ensureEdge({
    source_id: seriesItemId,
    target_id: itemId,
    edge_type: "parent-of",
  });
}

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  const resolved = await resolveConnectionConfig(ctx);
  if (!resolved.ok) return reportConfigFailure(ctx, resolved.error);
  const config = resolved.config;
  if (config.mode === "multi") {
    return handleScheduleMulti(ctx, message, config);
  }
  return handleScheduleSingle(ctx, message, config);
}

async function handleScheduleSingle(
  ctx: ConnectionContext,
  message: ScheduleMessage,
  config: ConnectionConfig,
): Promise<HandlerResult> {
  void message;
  const cursor: CalendarCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as CalendarCursor | null) ?? {
    syncToken: null,
    last_inbound_at: null,
    mappings: {},
  };

  const calendarId = config.default_write_calendar_id;
  let upserted = 0;
  let skippedEcho = 0;
  let trashed = 0;

  const outcome = await listEventsPaged(
    ctx,
    calendarId,
    { syncToken: cursor.syncToken, pageToken: cursor.pageToken ?? null },
    async (events) => {
      for (const event of events) {
        const marfa_id = cursor.mappings[event.id];
        if (event.status === "cancelled") {
          if (marfa_id !== undefined) {
            try {
              await ctx.marfa.transitionItem(marfa_id, "trashed");
              trashed += 1;
              Reflect.deleteProperty(cursor.mappings, event.id);
            } catch (err) {
              await ctx.activity.emit({
                severity: "action_required",
                summary: `google-calendar: failed to trash marfa item for cancelled event ${event.id}`,
                detail: { error: errorMessage(err) },
              });
            }
          }
          continue;
        }

        const hash = contentHashForEvent(event);
        if (await ctx.echo.shouldSkipReactive(event.id, hash)) {
          skippedEcho += 1;
          continue;
        }

        const input = buildEventInput(event, config.target_type, calendarId);
        try {
          let itemId = marfa_id;
          if (itemId !== undefined) {
            await ctx.marfa.updateItem(itemId, input);
          } else {
            const created = await ctx.marfa.createItem({
              ...input,
              source_id: event.id,
            });
            cursor.mappings[event.id] = created.id;
            itemId = created.id;
          }
          await bindToSeries(ctx, cursor, event, itemId);
          upserted += 1;
        } catch (err) {
          await ctx.activity.emit({
            severity: "action_required",
            summary: `google-calendar: failed to upsert marfa item for event ${event.id}`,
            detail: { error: errorMessage(err) },
          });
        }
      }
    },
  );

  if (outcome.kind === "sync_token_invalid") {
    // Sync token invalidated — drop it and re-bootstrap on next tick.
    cursor.syncToken = null;
    cursor.pageToken = null;
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: "google-calendar: syncToken invalidated, re-bootstrapping",
    });
    return { ok: true };
  }
  if (outcome.kind !== "ok") {
    // Pages already ingested left mappings on the cursor. Persisting
    // before surfacing the failure is what stops the retry re-creating
    // those same events as fresh Marfa items.
    await ctx.cursor.write(CURSOR_KEY, cursor);
    return reportListFailure(ctx, outcome, "events.list");
  }

  cursor.syncToken = outcome.syncToken ?? cursor.syncToken;
  cursor.pageToken = outcome.resumePageToken;
  cursor.last_inbound_at = new Date().toISOString();
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `google-calendar inbound: upserted=${String(upserted)} echo_skipped=${String(skippedEcho)} trashed=${String(trashed)}`,
    detail: {
      events_seen: outcome.eventsSeen,
      upserted,
      skipped_echo: skippedEcho,
      trashed,
      sweep_parked: outcome.resumePageToken !== null,
    },
  });

  return { ok: true };
}

/**
 * Map a non-ok list outcome onto the handler's failure contract. `label`
 * prefixes the operator-facing summary so the schedule and webhook paths
 * stay distinguishable in the activity feed.
 */
async function reportListFailure(
  ctx: ConnectionContext,
  outcome: Exclude<
    ListEventsOutcome,
    { kind: "ok" } | { kind: "sync_token_invalid" }
  >,
  label: string,
): Promise<HandlerResult> {
  if (outcome.kind === "fetch_failed") {
    return reportFailure(ctx, `${label} fetch failed`, outcome.error, true);
  }
  if (outcome.kind === "parse_failed") {
    return reportFailure(ctx, `${label} parse failed`, outcome.error, true);
  }
  return reportFailure(
    ctx,
    `${label} returned ${String(outcome.status)}`,
    null,
    outcome.status >= 500,
  );
}

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  const resolved = await resolveConnectionConfig(ctx);
  if (!resolved.ok) return reportConfigFailure(ctx, resolved.error);
  const config = resolved.config;
  if (config.mode === "multi") {
    return handleItemEventMulti(ctx, message, config);
  }
  return handleItemEventSingle(ctx, message, config);
}

async function handleItemEventSingle(
  ctx: ConnectionContext,
  message: ItemEventMessage,
  config: ConnectionConfig,
): Promise<HandlerResult> {
  // Defensive self-event filter — the bridge already drops these,
  // but check anyway.
  if (
    ctx.cycle?.originating_connection_id === ctx.connection_id ||
    message.cycle.originating_connection_id === ctx.connection_id
  ) {
    return { ok: true };
  }

  const cursor: CalendarCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as CalendarCursor | null) ?? {
    syncToken: null,
    last_inbound_at: null,
    mappings: {},
  };

  const item = await ctx.marfa.getItem(message.item_id);
  if (item === null) {
    // Item disappeared before we read it — treat as a delete if we have
    // the mapping (mappings are external_id → marfa_id, so reverse-lookup).
    return ackHandledIfMappedAsDelete(
      ctx,
      cursor,
      message.item_id,
      config.default_write_calendar_id,
    );
  }

  const externalId = findExternalIdFor(cursor, item.id);

  // Lag-window guard — recent outbound write to this id; defer.
  if (externalId !== null && (await ctx.echo.inLagWindow(externalId))) {
    return {
      ok: false,
      retry: true,
      reason: "in_lag_window",
    };
  }

  if (item.state === "trashed") {
    if (externalId !== null) {
      const path = buildEventPath(externalId);
      const resp = await ctx.marfa.proxyRequest("DELETE", path);
      if (!resp.ok && resp.status !== 410 && resp.status !== 404) {
        return reportOutboundFailure(ctx, "DELETE", externalId, resp);
      }
      Reflect.deleteProperty(cursor.mappings, externalId);
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-calendar outbound: deleted Calendar event ${externalId}`,
      });
    }
    return { ok: true };
  }

  const calendarPayload = buildCalendarPayload(item);
  if (externalId === null) {
    const deterministicId = await deriveDeterministicCalendarId(item.id);
    const calendarId = config.default_write_calendar_id;
    const postPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const postPayload = { ...calendarPayload, id: deterministicId };
    const resp = await ctx.marfa.proxyRequest("POST", postPath, postPayload);

    if (resp.status === 409) {
      // A prior attempt of this same handler invocation succeeded
      // at Calendar but did not persist its cursor write (e.g. the
      // Worker crashed mid-handler and Cloudflare Queues retried
      // the whole batch). Fetch the event Calendar already holds,
      // record the mapping with the id we sent, and proceed as if
      // the original POST had landed cleanly.
      const fetchPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(deterministicId)}`;
      const fetchResp = await ctx.marfa.proxyRequest("GET", fetchPath);
      if (!fetchResp.ok) {
        return reportOutboundFailure(
          ctx,
          "GET (after 409)",
          deterministicId,
          fetchResp,
        );
      }
      const body: CalendarEvent = await fetchResp.json();
      cursor.mappings[deterministicId] = item.id;
      await ctx.echo.trackOutboundWrite(
        deterministicId,
        contentHashForEvent(body),
      );
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-calendar outbound: idempotent recovery — Calendar already had an event for Marfa item ${item.id}`,
      });
      return { ok: true };
    }

    if (!resp.ok) {
      return reportOutboundFailure(ctx, "POST", "(new)", resp);
    }
    const body: CalendarEvent = await resp.json();
    cursor.mappings[body.id] = item.id;
    await ctx.echo.trackOutboundWrite(body.id, contentHashForEvent(body));
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: `google-calendar outbound: created Calendar event ${body.id}`,
    });
    return { ok: true };
  }

  const path = buildEventPath(externalId);
  const resp = await ctx.marfa.proxyRequest("PATCH", path, calendarPayload);
  if (!resp.ok) {
    return reportOutboundFailure(ctx, "PATCH", externalId, resp);
  }
  const body: CalendarEvent = await resp.json();
  await ctx.echo.trackOutboundWrite(externalId, contentHashForEvent(body));
  await ctx.activity.emit({
    severity: "info",
    summary: `google-calendar outbound: patched Calendar event ${externalId}`,
  });
  return { ok: true };
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
  registerItemEventHandler(handleItemEvent);
  registerWebhookHandler(handleWebhook);
}

// ---------------------------------------------------------------------------
// channels.watch push notifications.
//
// Active when multi-calendar configuration is set AND a webhook
// receipt URL is available on `properties.configuration.inbound_webhook_url`
// (set when the inbound subscription is minted at install time).
// Without an inbound URL the integration still works on the schedule
// poll path; channels are simply not created. The schedule trigger
// is both the renewal cron and the fallback for any push gap.
// ---------------------------------------------------------------------------

/** Channel renewal leeway — refresh a channel when it's within this
 *  many ms of expiry. */
const CHANNEL_RENEW_LEEWAY_MS = 24 * 60 * 60 * 1000;

/** Channel TTL request — ask for 6 days. */
const CHANNEL_TTL_MS = 6 * 24 * 60 * 60 * 1000;

interface ChannelState {
  channel_id: string;
  resource_id: string;
  expiration_ms: number;
  channel_token: string;
}

interface CalendarCursorWithChannels extends CalendarCursor {
  channels?: Record<string, ChannelState>;
  retired_channels?: ChannelState[];
}

async function resolveInboundWebhookUrl(
  ctx: ConnectionContext,
): Promise<string | null> {
  try {
    const connection = await ctx.marfa.getItem(ctx.connection_id);
    const cfg = (
      connection?.properties as
        | { configuration?: Record<string, unknown> }
        | undefined
    )?.configuration;
    const url = cfg?.inbound_webhook_url;
    if (typeof url === "string" && url.length > 0) return url;
    return null;
  } catch {
    return null;
  }
}

function randomChannelId(): string {
  return globalThis.crypto.randomUUID();
}

function randomChannelToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function createChannel(
  ctx: ConnectionContext,
  calendarId: string,
  inboundWebhookUrl: string,
): Promise<ChannelState | null> {
  const channelId = randomChannelId();
  const channelToken = randomChannelToken();
  const expirationMs = Date.now() + CHANNEL_TTL_MS;
  const path = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`;
  const body = {
    id: channelId,
    type: "webhook",
    address: inboundWebhookUrl,
    token: channelToken,
    expiration: String(expirationMs),
  };
  let resp: Response;
  try {
    resp = await ctx.marfa.proxyRequest("POST", path, body);
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-calendar: channels.watch fetch failed for ${calendarId}`,
      detail: { error: errorMessage(err) },
    });
    return null;
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-calendar: channels.watch returned ${String(resp.status)} for ${calendarId}`,
      detail: { status: resp.status, response_text: text.slice(0, 500) },
    });
    return null;
  }
  let payload: { id?: string; resourceId?: string; expiration?: string };
  try {
    payload = await resp.json();
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-calendar: channels.watch parse failed for ${calendarId}`,
      detail: { error: errorMessage(err) },
    });
    return null;
  }
  if (typeof payload.resourceId !== "string") {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-calendar: channels.watch returned no resourceId for ${calendarId}`,
    });
    return null;
  }
  const expFromGoogle =
    typeof payload.expiration === "string"
      ? Number(payload.expiration)
      : expirationMs;
  return {
    channel_id: channelId,
    resource_id: payload.resourceId,
    expiration_ms: Number.isFinite(expFromGoogle)
      ? expFromGoogle
      : expirationMs,
    channel_token: channelToken,
  };
}

async function stopChannel(
  ctx: ConnectionContext,
  channel: ChannelState,
): Promise<void> {
  const path = `${CALENDAR_API_BASE}/channels/stop`;
  const body = { id: channel.channel_id, resourceId: channel.resource_id };
  try {
    const resp = await ctx.marfa.proxyRequest("POST", path, body);
    if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
      const text = await resp.text().catch(() => "");
      await ctx.activity.emit({
        severity: "info",
        summary: `google-calendar: channels.stop returned ${String(resp.status)} for ${channel.channel_id} (best-effort)`,
        detail: { status: resp.status, response_text: text.slice(0, 300) },
      });
    }
  } catch (err) {
    await ctx.activity.emit({
      severity: "info",
      summary: `google-calendar: channels.stop fetch failed for ${channel.channel_id} (best-effort)`,
      detail: { error: errorMessage(err) },
    });
  }
}

/**
 * Ensure each selected calendar has a current, non-expiring-soon push
 * channel. Mirrors Nango's zero-downtime renewal pattern: create the
 * new channel FIRST, persist its state, THEN stop the old one. If the
 * stop fails the new channel keeps Google delivering pushes without a
 * gap; the dangling old channel expires within its own TTL.
 */
async function ensureChannels(
  ctx: ConnectionContext,
  cursor: CalendarCursorWithChannels,
  config: ConnectionConfig,
  inboundWebhookUrl: string,
): Promise<void> {
  cursor.channels = cursor.channels ?? {};
  cursor.retired_channels = cursor.retired_channels ?? [];
  const now = Date.now();

  for (const calendarId of config.selected_calendar_ids) {
    const existing = cursor.channels[calendarId];
    const needsCreate = existing === undefined;
    const needsRenew =
      existing !== undefined &&
      existing.expiration_ms - now < CHANNEL_RENEW_LEEWAY_MS;
    if (!needsCreate && !needsRenew) continue;

    const freshChannel = await createChannel(
      ctx,
      calendarId,
      inboundWebhookUrl,
    );
    if (freshChannel === null) continue;

    if (existing !== undefined) {
      cursor.retired_channels.push(existing);
    }
    cursor.channels[calendarId] = freshChannel;
  }

  const retired = cursor.retired_channels;
  cursor.retired_channels = [];
  for (const old of retired) {
    await stopChannel(ctx, old);
  }
}

/**
 * Extract the calendar id from Google's `X-Goog-Resource-URI` push
 * header. Returns null when the URI shape is unrecognized.
 */
function extractCalendarIdFromResourceUri(uri: string): string | null {
  const match = /\/calendars\/([^/]+)\/events/.exec(uri);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

/**
 * Webhook handler for Calendar push notifications. Body is empty by
 * design — Google only signals "something changed on resource X".
 * The handler refetches the affected calendar's events via the same
 * incremental-sync path the schedule handler uses, so push and poll
 * converge on identical state.
 */
export async function handleWebhook(
  ctx: ConnectionContext,
  input: WebhookHandlerInput,
): Promise<HandlerResult> {
  const resolved = await resolveConnectionConfig(ctx);
  if (!resolved.ok) return reportConfigFailure(ctx, resolved.error);
  const config = resolved.config;
  if (config.mode !== "multi") {
    return { ok: true };
  }

  const resourceUri =
    input.headers["x-goog-resource-uri"] ??
    input.headers["X-Goog-Resource-URI"];
  const resourceState =
    input.headers["x-goog-resource-state"] ??
    input.headers["X-Goog-Resource-State"];

  // `sync` is the initial handshake Google sends right after channel
  // creation. Ack and move on.
  if (resourceState === "sync") {
    return { ok: true };
  }

  const calendarId =
    typeof resourceUri === "string"
      ? extractCalendarIdFromResourceUri(resourceUri)
      : null;
  if (
    calendarId === null ||
    !config.selected_calendar_ids.includes(calendarId)
  ) {
    return { ok: true };
  }

  return syncOneCalendar(ctx, calendarId, config);
}

/**
 * Sync a single calendar — extracted so the webhook handler can drive
 * the same incremental-sync path with one calendar instead of the
 * full sweep. Mutates and persists the cursor.
 */
async function syncOneCalendar(
  ctx: ConnectionContext,
  calendarId: string,
  config: ConnectionConfig,
): Promise<HandlerResult> {
  const cursor: CalendarCursorWithChannels = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as CalendarCursorWithChannels | null) ?? {
    syncToken: null,
    last_inbound_at: null,
    mappings: {},
  };
  adoptSingleCalendarCursor(cursor);
  // Bound locally so the per-page ingest closure keeps the non-optional
  // narrowing the two assignments above establish.
  const mappingCalendars = cursor.mapping_calendars;

  const perCal = cursor.per_calendar[calendarId] ?? {
    syncToken: null,
    last_inbound_at: null,
  };

  let upserted = 0;
  let skippedEcho = 0;
  let trashed = 0;

  const outcome = await listEventsPaged(
    ctx,
    calendarId,
    { syncToken: perCal.syncToken, pageToken: perCal.pageToken ?? null },
    async (events) => {
      for (const event of events) {
        const marfa_id = cursor.mappings[event.id];
        if (event.status === "cancelled") {
          if (marfa_id !== undefined) {
            try {
              await ctx.marfa.transitionItem(marfa_id, "trashed");
              trashed += 1;
              Reflect.deleteProperty(cursor.mappings, event.id);
              Reflect.deleteProperty(mappingCalendars, event.id);
            } catch (err) {
              await ctx.activity.emit({
                severity: "action_required",
                summary: `google-calendar webhook: trash failed for ${event.id}`,
                detail: { error: errorMessage(err) },
              });
            }
          }
          continue;
        }

        const hash = contentHashForEvent(event);
        if (await ctx.echo.shouldSkipReactive(event.id, hash)) {
          skippedEcho += 1;
          continue;
        }

        const input = buildEventInput(event, config.target_type, calendarId);
        try {
          let itemId = marfa_id;
          if (itemId !== undefined) {
            await ctx.marfa.updateItem(itemId, input);
          } else {
            const created = await ctx.marfa.createItem({
              ...input,
              source_id: event.id,
            });
            cursor.mappings[event.id] = created.id;
            mappingCalendars[event.id] = calendarId;
            itemId = created.id;
          }
          await bindToSeries(ctx, cursor, event, itemId);
          upserted += 1;
        } catch (err) {
          await ctx.activity.emit({
            severity: "action_required",
            summary: `google-calendar webhook: upsert failed for event ${event.id}`,
            detail: { error: errorMessage(err) },
          });
        }
      }
    },
  );

  if (outcome.kind === "sync_token_invalid") {
    perCal.syncToken = null;
    perCal.pageToken = null;
    cursor.per_calendar[calendarId] = perCal;
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: `google-calendar webhook: syncToken invalidated for ${calendarId}, re-bootstrapping`,
    });
    return { ok: true };
  }
  if (outcome.kind !== "ok") {
    cursor.per_calendar[calendarId] = perCal;
    await ctx.cursor.write(CURSOR_KEY, cursor);
    return reportListFailure(
      ctx,
      outcome,
      `webhook re-poll events.list for ${calendarId}`,
    );
  }

  perCal.syncToken = outcome.syncToken ?? perCal.syncToken;
  perCal.pageToken = outcome.resumePageToken;
  perCal.last_inbound_at = new Date().toISOString();
  cursor.per_calendar[calendarId] = perCal;
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `google-calendar webhook: synced ${calendarId} upserted=${String(upserted)} echo_skipped=${String(skippedEcho)} trashed=${String(trashed)}`,
    detail: {
      calendar_id: calendarId,
      upserted,
      skipped_echo: skippedEcho,
      trashed,
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Multi-calendar handlers. Active when the connection's
// `properties.configuration` carries `selected_calendar_ids[]` and a
// `default_write_calendar_id` (set by the install-time picker).
// Without that configuration, the single-calendar path above runs.
// ---------------------------------------------------------------------------

/**
 * Inbound sweep across every selected calendar. Each calendar carries
 * its own `syncToken` so incremental sync state doesn't bleed between
 * them. Per-event failures isolate; one calendar's 410 doesn't drop
 * the others. Mapping table records the calendar id alongside the
 * Marfa item id so subsequent updates/deletes route correctly.
 */
async function handleScheduleMulti(
  ctx: ConnectionContext,
  message: ScheduleMessage,
  config: ConnectionConfig,
): Promise<HandlerResult> {
  void message;
  const cursor: CalendarCursorWithChannels = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as CalendarCursorWithChannels | null) ?? {
    syncToken: null,
    last_inbound_at: null,
    mappings: {},
  };
  adoptSingleCalendarCursor(cursor);
  // Bound locally so the per-page ingest closure keeps the non-optional
  // narrowing the two assignments above establish.
  const mappingCalendars = cursor.mapping_calendars;

  // Push notifications: ensure every selected calendar has a live
  // (and not expiring-soon) watch channel pointed at the connection's
  // inbound receipt URL. Skipped gracefully when the URL isn't
  // configured; the schedule poll alone keeps the integration
  // functional in that case.
  const inboundWebhookUrl = await resolveInboundWebhookUrl(ctx);
  if (inboundWebhookUrl !== null) {
    await ensureChannels(ctx, cursor, config, inboundWebhookUrl);
  }

  let totalUpserted = 0;
  let totalSkippedEcho = 0;
  let totalTrashed = 0;
  const perCalendarOutcomes: Record<
    string,
    { upserted: number; skipped: number; trashed: number; reset: boolean }
  > = {};

  for (const calendarId of config.selected_calendar_ids) {
    const perCal: PerCalendarCursor = cursor.per_calendar[calendarId] ?? {
      syncToken: null,
      last_inbound_at: null,
    };
    let upserted = 0;
    let skippedEcho = 0;
    let trashed = 0;

    const outcome = await listEventsPaged(
      ctx,
      calendarId,
      { syncToken: perCal.syncToken, pageToken: perCal.pageToken ?? null },
      async (events) => {
        for (const event of events) {
          const marfa_id = cursor.mappings[event.id];
          if (event.status === "cancelled") {
            if (marfa_id !== undefined) {
              try {
                await ctx.marfa.transitionItem(marfa_id, "trashed");
                trashed += 1;
                Reflect.deleteProperty(cursor.mappings, event.id);
                Reflect.deleteProperty(mappingCalendars, event.id);
              } catch (err) {
                await ctx.activity.emit({
                  severity: "action_required",
                  summary: `google-calendar: failed to trash marfa item for cancelled event ${event.id}`,
                  detail: { error: errorMessage(err) },
                });
              }
            }
            continue;
          }

          const hash = contentHashForEvent(event);
          if (await ctx.echo.shouldSkipReactive(event.id, hash)) {
            skippedEcho += 1;
            continue;
          }

          const input = buildEventInput(event, config.target_type, calendarId);
          try {
            if (marfa_id !== undefined) {
              await ctx.marfa.updateItem(marfa_id, input);
            } else {
              const created = await ctx.marfa.createItem({
                ...input,
                source_id: event.id,
              });
              cursor.mappings[event.id] = created.id;
              mappingCalendars[event.id] = calendarId;
            }
            upserted += 1;
          } catch (err) {
            await ctx.activity.emit({
              severity: "action_required",
              summary: `google-calendar: failed to upsert marfa item for event ${event.id}`,
              detail: { error: errorMessage(err) },
            });
          }
        }
      },
    );

    if (outcome.kind === "sync_token_invalid") {
      perCal.syncToken = null;
      perCal.pageToken = null;
      cursor.per_calendar[calendarId] = perCal;
      perCalendarOutcomes[calendarId] = {
        upserted,
        skipped: skippedEcho,
        trashed,
        reset: true,
      };
      await ctx.activity.emit({
        severity: "info",
        summary: `google-calendar: syncToken invalidated for ${calendarId}, re-bootstrapping`,
      });
      continue;
    }
    if (outcome.kind !== "ok") {
      // One calendar's failure isolates; the sweep carries on. Whatever
      // this calendar already ingested stays on the cursor so the next
      // tick updates those items rather than duplicating them.
      cursor.per_calendar[calendarId] = perCal;
      await ctx.activity.emit({
        severity: "action_required",
        summary:
          outcome.kind === "http_error"
            ? `google-calendar: events.list returned ${String(outcome.status)} for ${calendarId}`
            : `google-calendar: events.list ${outcome.kind === "fetch_failed" ? "fetch" : "parse"} failed for ${calendarId}`,
        detail:
          outcome.kind === "http_error"
            ? { status: outcome.status }
            : { error: errorMessage(outcome.error) },
      });
      totalUpserted += upserted;
      totalSkippedEcho += skippedEcho;
      totalTrashed += trashed;
      continue;
    }

    perCal.syncToken = outcome.syncToken ?? perCal.syncToken;
    perCal.pageToken = outcome.resumePageToken;
    perCal.last_inbound_at = new Date().toISOString();
    cursor.per_calendar[calendarId] = perCal;
    perCalendarOutcomes[calendarId] = {
      upserted,
      skipped: skippedEcho,
      trashed,
      reset: false,
    };
    totalUpserted += upserted;
    totalSkippedEcho += skippedEcho;
    totalTrashed += trashed;
  }

  await ctx.cursor.write(CURSOR_KEY, cursor);
  await ctx.activity.emit({
    severity: "info",
    summary: `google-calendar inbound (multi): upserted=${String(totalUpserted)} echo_skipped=${String(totalSkippedEcho)} trashed=${String(totalTrashed)}`,
    detail: {
      calendars_swept: config.selected_calendar_ids.length,
      per_calendar: perCalendarOutcomes,
    },
  });

  return { ok: true };
}

/**
 * Outbound reactive handler for multi-calendar mode. New items route
 * to `default_write_calendar_id`. Updates and deletes route to the
 * calendar the event is mapped against (via `cursor.mapping_calendars`),
 * falling back to the default-write calendar when the mapping is
 * missing (shouldn't happen in steady state but guards against
 * partial-cursor recoveries).
 */
async function handleItemEventMulti(
  ctx: ConnectionContext,
  message: ItemEventMessage,
  config: ConnectionConfig,
): Promise<HandlerResult> {
  if (
    ctx.cycle?.originating_connection_id === ctx.connection_id ||
    message.cycle.originating_connection_id === ctx.connection_id
  ) {
    return { ok: true };
  }

  const cursor: CalendarCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as CalendarCursor | null) ?? {
    syncToken: null,
    last_inbound_at: null,
    mappings: {},
  };
  adoptSingleCalendarCursor(cursor);

  const item = await ctx.marfa.getItem(message.item_id);
  if (item === null) {
    return ackHandledIfMappedAsDelete(
      ctx,
      cursor,
      message.item_id,
      config.default_write_calendar_id,
    );
  }

  const externalId = findExternalIdFor(cursor, item.id);

  if (externalId !== null && (await ctx.echo.inLagWindow(externalId))) {
    return { ok: false, retry: true, reason: "in_lag_window" };
  }

  const mappedCalendarId =
    externalId !== null
      ? (cursor.mapping_calendars[externalId] ?? DEFAULT_CALENDAR_ID)
      : config.default_write_calendar_id;

  if (item.state === "trashed") {
    if (externalId !== null) {
      const path = buildEventPath(externalId, mappedCalendarId);
      const resp = await ctx.marfa.proxyRequest("DELETE", path);
      if (!resp.ok && resp.status !== 410 && resp.status !== 404) {
        return reportOutboundFailure(ctx, "DELETE", externalId, resp);
      }
      Reflect.deleteProperty(cursor.mappings, externalId);
      Reflect.deleteProperty(cursor.mapping_calendars, externalId);
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-calendar outbound: deleted Calendar event ${externalId} on ${mappedCalendarId}`,
      });
    }
    return { ok: true };
  }

  const calendarPayload = buildCalendarPayload(item);

  if (externalId === null) {
    const writeCalendarId = config.default_write_calendar_id;
    const deterministicId = await deriveDeterministicCalendarId(item.id);
    const postPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(writeCalendarId)}/events`;
    const postPayload = { ...calendarPayload, id: deterministicId };
    const resp = await ctx.marfa.proxyRequest("POST", postPath, postPayload);

    if (resp.status === 409) {
      // Idempotent recovery — same handling as single-calendar mode.
      const fetchPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(writeCalendarId)}/events/${encodeURIComponent(deterministicId)}`;
      const fetchResp = await ctx.marfa.proxyRequest("GET", fetchPath);
      if (!fetchResp.ok) {
        return reportOutboundFailure(
          ctx,
          "GET (after 409)",
          deterministicId,
          fetchResp,
        );
      }
      const body: CalendarEvent = await fetchResp.json();
      cursor.mappings[deterministicId] = item.id;
      cursor.mapping_calendars[deterministicId] = writeCalendarId;
      await ctx.echo.trackOutboundWrite(
        deterministicId,
        contentHashForEvent(body),
      );
      await ctx.cursor.write(CURSOR_KEY, cursor);
      await ctx.activity.emit({
        severity: "info",
        summary: `google-calendar outbound: idempotent recovery on ${writeCalendarId} for Marfa item ${item.id}`,
      });
      return { ok: true };
    }

    if (!resp.ok) {
      return reportOutboundFailure(ctx, "POST", "(new)", resp);
    }
    const body: CalendarEvent = await resp.json();
    cursor.mappings[body.id] = item.id;
    cursor.mapping_calendars[body.id] = writeCalendarId;
    await ctx.echo.trackOutboundWrite(body.id, contentHashForEvent(body));
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: `google-calendar outbound: created Calendar event ${body.id} on ${writeCalendarId}`,
    });
    return { ok: true };
  }

  const path = buildEventPath(externalId, mappedCalendarId);
  const resp = await ctx.marfa.proxyRequest("PATCH", path, calendarPayload);
  if (!resp.ok) {
    return reportOutboundFailure(ctx, "PATCH", externalId, resp);
  }
  const body: CalendarEvent = await resp.json();
  await ctx.echo.trackOutboundWrite(externalId, contentHashForEvent(body));
  await ctx.activity.emit({
    severity: "info",
    summary: `google-calendar outbound: patched Calendar event ${externalId} on ${mappedCalendarId}`,
  });
  return { ok: true };
}

/**
 * Build the Marfa-side `CreateItemInput` from a Calendar event.
 *
 * `targetType` defaults to `"core.event"` so single-calendar callers
 * write cross-app `core.event` items. Multi-calendar mode passes the
 * configured target type — usually `"google.calendar.event"` for
 * upstream-fidelity round-trip. When the target is
 * `google.calendar.event` the function additionally writes the
 * Google-specific fields the type carries (timezone, all_day, etag,
 * html_link, source_calendar_id, recurrence, etc.).
 *
 * `sourceCalendarId` is the Calendar id the event lives on. Only
 * meaningful when the target type knows about it
 * (`google.calendar.event`); ignored when writing `core.event`.
 */
function buildEventInput(
  event: CalendarEvent,
  targetType = "core.event",
  sourceCalendarId?: string,
): CreateItemInput {
  const properties: Record<string, unknown> = {
    title: event.summary ?? "Untitled event",
  };
  if (event.description !== undefined)
    properties.description = event.description;
  if (event.location !== undefined) {
    // `core.event` uses `place`; `google.calendar.event` also uses
    // `place` (we keep the cross-app idiom for the location field).
    properties.place = event.location;
  }
  // A whole day is not an instant, and Calendar says so by sending `date`
  // instead of `dateTime`. Marfa records that as a fact rather than leaving
  // it to be inferred from whether a string happens to carry a time, because
  // an inference is invisible to every reader that did not think to make it.
  const isAllDay =
    event.start?.date !== undefined && event.start.dateTime === undefined;
  if (isAllDay) properties.all_day = true;

  // An all-day event carries no zone upstream, and inventing one would be a
  // claim Calendar never made. Absent means the date is read in UTC, which
  // is exactly the day it was written under, so the round trip is exact and
  // the date is the same for every reader. Storing midnight UTC and then
  // reading it back in a viewer's zone is the classic version of this bug:
  // anywhere west of Greenwich sees the evening before.
  const startInstant = isAllDay
    ? dateInZoneToInstant(event.start?.date ?? "", undefined)
    : event.start?.dateTime;
  const endInstant = isAllDay
    ? dateInZoneToInstant(event.end?.date ?? "", undefined)
    : event.end?.dateTime;
  if (startInstant != null) properties.starts_at = startInstant;
  if (endInstant != null) properties.ends_at = endInstant;
  if (event.status !== undefined) properties.status = event.status;

  // Recurrence is not a Google detail: the rule, the zone it is read in,
  // and the occurrence a moved instance replaces are what make a series
  // answerable on any target type. Dropping them here left `core.event`
  // holding one item dated to the first occurrence.
  if (Array.isArray(event.recurrence) && event.recurrence.length > 0) {
    properties.recurrence = event.recurrence;
  }
  const timezone = event.start?.timeZone ?? event.end?.timeZone;
  if (timezone !== undefined) properties.timezone = timezone;
  // A flight lands in a zone it did not depart from, and Calendar offers the
  // choice in its own interface. Collapsing the two loses a fact the user
  // entered, so the end zone is carried whenever it differs.
  if (
    event.end?.timeZone !== undefined &&
    event.end.timeZone !== event.start?.timeZone
  ) {
    properties.end_timezone = event.end.timeZone;
  }
  const originalStartRaw =
    event.originalStartTime?.dateTime ?? event.originalStartTime?.date;
  if (originalStartRaw !== undefined) {
    // An exception to an all-day series names the occurrence it replaces by
    // date, so it needs the same conversion the series start did or the two
    // never match.
    const originalStart =
      event.originalStartTime?.dateTime ??
      dateInZoneToInstant(originalStartRaw, undefined);
    if (originalStart != null) properties.original_starts_at = originalStart;
  }

  if (targetType === "core.event") {
    if (event.htmlLink !== undefined) properties.url = event.htmlLink;
    return { type: targetType, properties };
  }

  // google.calendar.event: carry Google-specific fields so a round-trip
  // preserves what Calendar considers authoritative.
  if (event.htmlLink !== undefined) properties.html_link = event.htmlLink;
  if (event.etag !== undefined) properties.etag = event.etag;
  if (sourceCalendarId !== undefined) {
    properties.source_calendar_id = sourceCalendarId;
  }
  if (event.transparency !== undefined)
    properties.transparency = event.transparency;
  if (event.visibility !== undefined) properties.visibility = event.visibility;
  if (event.organizer?.email !== undefined)
    properties.organizer_email = event.organizer.email;
  if (event.creator?.email !== undefined)
    properties.creator_email = event.creator.email;
  if (event.recurringEventId !== undefined) {
    properties.recurring_event_id = event.recurringEventId;
  }
  if (event.colorId !== undefined) properties.color_id = event.colorId;
  return { type: targetType, properties };
}

/**
 * Build the Calendar API request payload from a Marfa item.
 *
 * `all_day` writes `start.date` / `end.date` instead of `dateTime`, with the
 * date derived from the stored instant read in the event's own zone. Never
 * the writer's own zone: a date re-derived wherever the code happens to be
 * running moves the event a day for half the world, which is the same fault
 * from the outbound side. `timezone` sets `start.timeZone`, and
 * `end_timezone` sets `end.timeZone` when the event ends somewhere else.
 *
 * The fallback (no `all_day`, no `timezone`) writes
 * `start: { dateTime: <iso> }`, `end: { dateTime: <iso> }`.
 */
function buildCalendarPayload(item: ItemResource): Record<string, unknown> {
  const props = (item.properties ?? {}) as {
    title?: unknown;
    description?: unknown;
    place?: unknown;
    starts_at?: unknown;
    ends_at?: unknown;
    timezone?: unknown;
    end_timezone?: unknown;
    all_day?: unknown;
    transparency?: unknown;
    visibility?: unknown;
    recurrence?: unknown;
  };
  const payload: Record<string, unknown> = {};
  if (typeof props.title === "string") payload.summary = props.title;
  if (typeof props.description === "string")
    payload.description = props.description;
  if (typeof props.place === "string") payload.location = props.place;

  const isAllDay = props.all_day === true;
  const timezone =
    typeof props.timezone === "string" && props.timezone.length > 0
      ? props.timezone
      : undefined;
  const endTimezone =
    typeof props.end_timezone === "string" && props.end_timezone.length > 0
      ? props.end_timezone
      : timezone;

  if (typeof props.starts_at === "string") {
    if (isAllDay) {
      const date = instantToDateInZone(props.starts_at, timezone);
      if (date !== null) payload.start = { date };
    } else if (timezone !== undefined) {
      payload.start = { dateTime: props.starts_at, timeZone: timezone };
    } else {
      payload.start = { dateTime: props.starts_at };
    }
  }
  if (typeof props.ends_at === "string") {
    if (isAllDay) {
      const date = instantToDateInZone(props.ends_at, timezone);
      if (date !== null) payload.end = { date };
    } else if (endTimezone !== undefined) {
      payload.end = { dateTime: props.ends_at, timeZone: endTimezone };
    } else {
      payload.end = { dateTime: props.ends_at };
    }
  }
  if (typeof props.transparency === "string")
    payload.transparency = props.transparency;
  if (typeof props.visibility === "string")
    payload.visibility = props.visibility;
  if (
    Array.isArray(props.recurrence) &&
    props.recurrence.every((r) => typeof r === "string") &&
    props.recurrence.length > 0
  ) {
    payload.recurrence = props.recurrence;
  }
  return payload;
}

/**
 * Build the path to a specific event on a given calendar. Defaults to
 * the connection's primary calendar so single-calendar code paths
 * address the primary.
 */
function buildEventPath(
  externalId: string,
  calendarId: string = DEFAULT_CALENDAR_ID,
): string {
  return `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`;
}

function findExternalIdFor(
  cursor: CalendarCursor,
  marfa_id: string,
): string | null {
  for (const [ext, marfa] of Object.entries(cursor.mappings)) {
    if (marfa === marfa_id) return ext;
  }
  return null;
}

async function ackHandledIfMappedAsDelete(
  ctx: ConnectionContext,
  cursor: CalendarCursor,
  marfa_id: string,
  fallbackCalendarId: string = DEFAULT_CALENDAR_ID,
): Promise<HandlerResult> {
  const externalId = findExternalIdFor(cursor, marfa_id);
  if (externalId === null) {
    return { ok: true };
  }
  // Multi-calendar mode tracks per-event calendar_id in
  // `mapping_calendars`; single-calendar mode has no entry there and
  // falls back to the connection's default-write calendar.
  const calendarId =
    cursor.mapping_calendars?.[externalId] ?? fallbackCalendarId;
  const path = buildEventPath(externalId, calendarId);
  const resp = await ctx.marfa.proxyRequest("DELETE", path);
  if (!resp.ok && resp.status !== 410 && resp.status !== 404) {
    return reportOutboundFailure(ctx, "DELETE", externalId, resp);
  }
  Reflect.deleteProperty(cursor.mappings, externalId);
  if (cursor.mapping_calendars !== undefined) {
    Reflect.deleteProperty(cursor.mapping_calendars, externalId);
  }
  await ctx.cursor.write(CURSOR_KEY, cursor);
  return { ok: true };
}

function contentHashForEvent(event: CalendarEvent): string {
  // etag is Calendar's own change-detection token; if present,
  // it's the canonical hash. Otherwise hash the meaningful fields.
  if (typeof event.etag === "string" && event.etag.length > 0) {
    return event.etag;
  }
  const parts = [
    event.summary ?? "",
    event.description ?? "",
    event.location ?? "",
    event.start?.dateTime ?? event.start?.date ?? "",
    event.end?.dateTime ?? event.end?.date ?? "",
    event.status ?? "",
  ];
  return parts.join("|");
}

async function reportOutboundFailure(
  ctx: ConnectionContext,
  verb: string,
  externalId: string,
  resp: Response,
): Promise<HandlerResult> {
  const text = await resp.text().catch(() => "");
  const isServerError = resp.status >= 500;
  await ctx.activity.emit({
    severity: "action_required",
    summary: `google-calendar outbound: ${verb} ${externalId} returned ${String(resp.status)}`,
    detail: { status: resp.status, response_text: text.slice(0, 500) },
  });
  if (isServerError) {
    return {
      ok: false,
      retry: true,
      reason: `upstream_${String(resp.status)}`,
    };
  }
  // 4xx: accept-partial. Don't retry (not transient).
  return { ok: true };
}

async function reportFailure(
  ctx: ConnectionContext,
  summary: string,
  err: unknown,
  retry: boolean,
): Promise<HandlerResult> {
  await ctx.activity.emit({
    severity: "action_required",
    summary: `google-calendar: ${summary}`,
    detail: err === null ? undefined : { error: errorMessage(err) },
  });
  if (retry) return { ok: false, retry: true, reason: summary };
  return { ok: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Derive a deterministic Google Calendar event id from a Marfa item
 * id. Output is a SHA-256 hex digest — 64 lowercase characters in
 * the alphabet [0-9a-f], which is a strict subset of the base32hex
 * alphabet [0-9a-v] that Calendar requires. Length is well within
 * the 5–1024 character window. Two distinct Marfa item ids produce
 * different Calendar ids with overwhelmingly high probability;
 * collision is not a real concern at any plausible scale.
 *
 * The `marfa:` prefix in the input means a Marfa item id is unlikely
 * to ever produce the same digest as some other system stamping
 * deterministic Calendar ids, even if both used SHA-256.
 *
 * Web Crypto is the right primitive here — Cloudflare Workers
 * (where the integration runs) don't ship `node:crypto`. Node 20+
 * exposes the same API as `globalThis.crypto`, so this works under
 * the Vitest fixture too.
 */
async function deriveDeterministicCalendarId(
  marfa_id: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`marfa:${marfa_id}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
