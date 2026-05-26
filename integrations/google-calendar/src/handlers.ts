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
 *       - Else upsert as `core.event`. Record the mapping in
 *         the cursor.
 *     Update the syncToken on success.
 *
 * - ITEM-EVENT (outbound, fires on Marfa `core.event` mutations):
 *     - The reactive bridge already filters self-events (Layer 2
 *       PR 3); double-check defensively against `cycle`.
 *     - If we're inside the lag window for this external_id,
 *       defer (return ok=false retry=true).
 *     - For created items: POST to Calendar with a deterministic
 *       client-supplied `id` derived from the Marfa item id (T-020).
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
 * T-020 idempotency: Cloudflare Queues whole-batch retry semantics
 * mean a transient failure between successful Calendar POST and
 * cursor-write produces a duplicate Calendar event on retry. The
 * fix is a deterministic client-supplied `id` on the POST: Calendar
 * accepts a custom `id` (5–1024 chars, base32hex alphabet — hex is
 * a subset, so a SHA-256 hex digest is valid) and returns 409 on
 * conflict, which we recognise as "I already created this event,
 * fetch its current state and record the mapping". The handler
 * therefore produces at most one Calendar event per Marfa item id,
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
import { CALENDAR_API_BASE, DEFAULT_CALENDAR_ID } from "./manifest.js";

const CURSOR_KEY = "main";

interface CalendarCursor {
  /** Opaque sync token from Calendar's incremental-sync API (legacy
   *  single-calendar mode only — populated when no `selected_calendar_ids`
   *  is configured). Multi-calendar mode uses `per_calendar[].syncToken`
   *  below. */
  syncToken: string | null;
  /** ISO timestamp of the last successful schedule run (legacy mode). */
  last_inbound_at: string | null;
  /** Map of Calendar event id → Marfa item id. Used to look up
   *  the Marfa item on echo / update / delete without round-tripping
   *  through the server. Bounded by Calendar's own dedup;
   *  realistically a few hundred to a few thousand entries. The shape
   *  stays a flat `Record<string, string>` for backward compatibility
   *  with legacy single-calendar cursors — the per-event calendar id
   *  lives alongside in `mapping_calendars`. */
  mappings: Record<string, string>;
  /** Multi-calendar mode only: per-event calendar id, so updates and
   *  deletes know which calendar the mapped event lives on. Sparse —
   *  legacy single-calendar cursors leave this undefined and writes go
   *  to the connection's primary calendar. */
  mapping_calendars?: Record<string, string>;
  /** Multi-calendar mode only: per-calendar sync cursor. Top-level
   *  `syncToken` is unused when this is populated. */
  per_calendar?: Record<
    string,
    { syncToken: string | null; last_inbound_at: string | null }
  >;
}

/**
 * Normalised view of the connection's `properties.configuration` for
 * the handler. Legacy mode (no `selected_calendar_ids`) preserves the
 * pre-T-231 behaviour: single primary-calendar sync, writes as
 * `core.event`. Multi mode honours the install-time picker selections.
 */
interface ConnectionConfig {
  mode: "legacy" | "multi";
  /** Single calendar id in legacy mode; nominated default-write in multi. */
  default_write_calendar_id: string;
  /** All calendars to sync from. Single-entry array in legacy mode. */
  selected_calendar_ids: string[];
  /** Target type for inbound items. `core.event` in legacy; configurable
   *  in multi (default `google.calendar.event`). */
  target_type: string;
}

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConnectionConfig> {
  try {
    const connection = await ctx.marfa.getItem(ctx.connection_id);
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

    if (selected.length > 0 && defaultWrite !== null) {
      return {
        mode: "multi",
        selected_calendar_ids: selected,
        default_write_calendar_id: defaultWrite,
        target_type: targetType ?? "google.calendar.event",
      };
    }

    // Legacy fallback. The pre-T-231 `resolveCalendarId` path honoured
    // a single `calendar_id` string on configuration as the calendar to
    // sync; preserve that as the legacy single-calendar id.
    const legacyCalendarId =
      typeof cfg.calendar_id === "string" && cfg.calendar_id.length > 0
        ? cfg.calendar_id
        : DEFAULT_CALENDAR_ID;
    return {
      mode: "legacy",
      selected_calendar_ids: [legacyCalendarId],
      default_write_calendar_id: legacyCalendarId,
      target_type: targetType ?? "core.event",
    };
  } catch {
    // If the connection lookup fails for any reason, fall back to the
    // fully-legacy primary-calendar / core.event defaults so the
    // handler still does something useful rather than failing hard.
    return {
      mode: "legacy",
      selected_calendar_ids: [DEFAULT_CALENDAR_ID],
      default_write_calendar_id: DEFAULT_CALENDAR_ID,
      target_type: "core.event",
    };
  }
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
  colorId?: string;
}

interface EventsListResponse {
  items?: CalendarEvent[];
  nextSyncToken?: string;
  nextPageToken?: string;
}

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  const config = await resolveConnectionConfig(ctx);
  if (config.mode === "multi") {
    return handleScheduleMulti(ctx, message, config);
  }
  return handleScheduleLegacy(ctx, message, config);
}

async function handleScheduleLegacy(
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
  const params = new URLSearchParams();
  if (cursor.syncToken !== null) params.set("syncToken", cursor.syncToken);
  else params.set("maxResults", "250"); // initial backfill cap
  const path = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;

  let response: Response;
  try {
    response = await ctx.marfa.proxyRequest("GET", path);
  } catch (err) {
    return reportFailure(ctx, "events.list fetch failed", err, true);
  }

  if (response.status === 410) {
    // Sync token invalidated — drop it and re-bootstrap on next tick.
    cursor.syncToken = null;
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: "google-calendar: syncToken invalidated, re-bootstrapping",
    });
    return { ok: true };
  }
  if (!response.ok) {
    return reportFailure(
      ctx,
      `events.list returned ${String(response.status)}`,
      null,
      response.status >= 500,
    );
  }

  let payload: EventsListResponse;
  try {
    payload = await response.json();
  } catch (err) {
    return reportFailure(ctx, "events.list parse failed", err, true);
  }

  let upserted = 0;
  let skippedEcho = 0;
  let trashed = 0;
  for (const event of payload.items ?? []) {
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
      if (marfa_id !== undefined) {
        await ctx.marfa.updateItem(marfa_id, input);
      } else {
        const created = await ctx.marfa.createItem({
          ...input,
          source_id: event.id,
        });
        cursor.mappings[event.id] = created.id;
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

  if (typeof payload.nextSyncToken === "string") {
    cursor.syncToken = payload.nextSyncToken;
  }
  cursor.last_inbound_at = new Date().toISOString();
  await ctx.cursor.write(CURSOR_KEY, cursor);

  await ctx.activity.emit({
    severity: "info",
    summary: `google-calendar inbound: upserted=${String(upserted)} echo_skipped=${String(skippedEcho)} trashed=${String(trashed)}`,
    detail: {
      events_seen: payload.items?.length ?? 0,
      upserted,
      skipped_echo: skippedEcho,
      trashed,
    },
  });

  return { ok: true };
}

export async function handleItemEvent(
  ctx: ConnectionContext,
  message: ItemEventMessage,
): Promise<HandlerResult> {
  const config = await resolveConnectionConfig(ctx);
  if (config.mode === "multi") {
    return handleItemEventMulti(ctx, message, config);
  }
  return handleItemEventLegacy(ctx, message, config);
}

async function handleItemEventLegacy(
  ctx: ConnectionContext,
  message: ItemEventMessage,
  config: ConnectionConfig,
): Promise<HandlerResult> {
  // Defensive self-event filter — the bridge already drops these
  // (Layer 2 PR 3) but check anyway.
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

  // Look up the item we're reacting to.
  const item = await ctx.marfa.getItem(message.item_id);
  if (item === null) {
    // Item disappeared (deleted before we could read). Treat it
    // as a delete-equivalent if we know the mapping by checking
    // mappings reverse: but the bridge gives us item_id, and
    // mappings are external_id → marfa_id, so reverse-lookup.
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

  // Create or update on Calendar.
  const calendarPayload = buildCalendarPayload(item);
  if (externalId === null) {
    // T-020: stamp a deterministic id derived from the Marfa item id
    // so a retry of the same handler invocation reaches Calendar
    // with the same id. Calendar's `events.insert` accepts a
    // client-supplied `id` (5–1024 chars, base32hex alphabet — hex
    // is a subset of base32hex, so a SHA-256 hex digest is valid)
    // and returns 409 on conflict. The 409 path below recovers the
    // mapping idempotently without creating a duplicate event.
    const deterministicId = await deriveDeterministicCalendarId(item.id);
    // Legacy single-calendar mode: write to the configured default
    // calendar (which is the primary by default and matches the
    // pre-T-231 `resolveCalendarId` behaviour exactly).
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

  // PATCH path.
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
// PR4 — channels.watch push notifications.
//
// Active when multi-calendar configuration is set AND a webhook
// receipt URL is available on `properties.configuration.inbound_webhook_url`
// (operator/install sets this when the inbound subscription is minted).
// Without an inbound URL the integration still works on the schedule
// poll path; channels are simply not created. This degradation is
// deliberate — the schedule trigger is both the renewal cron AND the
// fallback for any push gap.
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
 * header. Returns null when the URI shape is unrecognised.
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
  const config = await resolveConnectionConfig(ctx);
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
  cursor.per_calendar = cursor.per_calendar ?? {};
  cursor.mapping_calendars = cursor.mapping_calendars ?? {};

  const perCal = cursor.per_calendar[calendarId] ?? {
    syncToken: null,
    last_inbound_at: null,
  };
  const params = new URLSearchParams();
  if (perCal.syncToken !== null) params.set("syncToken", perCal.syncToken);
  else params.set("maxResults", "250");
  const listPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;

  let response: Response;
  try {
    response = await ctx.marfa.proxyRequest("GET", listPath);
  } catch (err) {
    return reportFailure(
      ctx,
      `webhook re-poll events.list failed for ${calendarId}`,
      err,
      true,
    );
  }

  if (response.status === 410) {
    perCal.syncToken = null;
    cursor.per_calendar[calendarId] = perCal;
    await ctx.cursor.write(CURSOR_KEY, cursor);
    await ctx.activity.emit({
      severity: "info",
      summary: `google-calendar webhook: syncToken invalidated for ${calendarId}, re-bootstrapping`,
    });
    return { ok: true };
  }
  if (!response.ok) {
    return reportFailure(
      ctx,
      `webhook re-poll events.list returned ${String(response.status)} for ${calendarId}`,
      null,
      response.status >= 500,
    );
  }

  let payload: EventsListResponse;
  try {
    payload = await response.json();
  } catch (err) {
    return reportFailure(
      ctx,
      `webhook re-poll parse failed for ${calendarId}`,
      err,
      true,
    );
  }

  let upserted = 0;
  let skippedEcho = 0;
  let trashed = 0;
  for (const event of payload.items ?? []) {
    const marfa_id = cursor.mappings[event.id];
    if (event.status === "cancelled") {
      if (marfa_id !== undefined) {
        try {
          await ctx.marfa.transitionItem(marfa_id, "trashed");
          trashed += 1;
          Reflect.deleteProperty(cursor.mappings, event.id);
          Reflect.deleteProperty(cursor.mapping_calendars, event.id);
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
      if (marfa_id !== undefined) {
        await ctx.marfa.updateItem(marfa_id, input);
      } else {
        const created = await ctx.marfa.createItem({
          ...input,
          source_id: event.id,
        });
        cursor.mappings[event.id] = created.id;
        cursor.mapping_calendars[event.id] = calendarId;
      }
      upserted += 1;
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-calendar webhook: upsert failed for event ${event.id}`,
        detail: { error: errorMessage(err) },
      });
    }
  }

  if (typeof payload.nextSyncToken === "string") {
    perCal.syncToken = payload.nextSyncToken;
  }
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
// Multi-calendar handlers (T-231 PR3). Active when the connection's
// `properties.configuration` carries `selected_calendar_ids[]` and a
// `default_write_calendar_id` — i.e. the post-install picker has been
// run. Until then, the legacy single-calendar path above runs unchanged.
// ---------------------------------------------------------------------------

interface PerCalendarCursor {
  syncToken: string | null;
  last_inbound_at: string | null;
}

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
  cursor.per_calendar = cursor.per_calendar ?? {};
  cursor.mapping_calendars = cursor.mapping_calendars ?? {};

  // PR4 — push notifications. Ensure every selected calendar has a
  // live (and not expiring-soon) watch channel pointed at the
  // connection's inbound receipt URL. Skipped gracefully when the URL
  // isn't configured; the schedule poll alone keeps the integration
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
    const params = new URLSearchParams();
    if (perCal.syncToken !== null) params.set("syncToken", perCal.syncToken);
    else params.set("maxResults", "250");
    const listPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;

    let response: Response;
    try {
      response = await ctx.marfa.proxyRequest("GET", listPath);
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-calendar: events.list fetch failed for ${calendarId}`,
        detail: { error: errorMessage(err) },
      });
      continue;
    }

    if (response.status === 410) {
      perCal.syncToken = null;
      cursor.per_calendar[calendarId] = perCal;
      perCalendarOutcomes[calendarId] = {
        upserted: 0,
        skipped: 0,
        trashed: 0,
        reset: true,
      };
      await ctx.activity.emit({
        severity: "info",
        summary: `google-calendar: syncToken invalidated for ${calendarId}, re-bootstrapping`,
      });
      continue;
    }
    if (!response.ok) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-calendar: events.list returned ${String(response.status)} for ${calendarId}`,
        detail: { status: response.status },
      });
      continue;
    }

    let payload: EventsListResponse;
    try {
      payload = await response.json();
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-calendar: events.list parse failed for ${calendarId}`,
        detail: { error: errorMessage(err) },
      });
      continue;
    }

    let upserted = 0;
    let skippedEcho = 0;
    let trashed = 0;
    for (const event of payload.items ?? []) {
      const marfa_id = cursor.mappings[event.id];
      if (event.status === "cancelled") {
        if (marfa_id !== undefined) {
          try {
            await ctx.marfa.transitionItem(marfa_id, "trashed");
            trashed += 1;
            Reflect.deleteProperty(cursor.mappings, event.id);
            Reflect.deleteProperty(cursor.mapping_calendars, event.id);
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
          cursor.mapping_calendars[event.id] = calendarId;
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

    if (typeof payload.nextSyncToken === "string") {
      perCal.syncToken = payload.nextSyncToken;
    }
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
  cursor.mapping_calendars = cursor.mapping_calendars ?? {};

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
      ? (cursor.mapping_calendars[externalId] ??
        config.default_write_calendar_id)
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
    // New event — route to the default-write calendar.
    const writeCalendarId = config.default_write_calendar_id;
    const deterministicId = await deriveDeterministicCalendarId(item.id);
    const postPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(writeCalendarId)}/events`;
    const postPayload = { ...calendarPayload, id: deterministicId };
    const resp = await ctx.marfa.proxyRequest("POST", postPath, postPayload);

    if (resp.status === 409) {
      // T-020 idempotent recovery — same handling as legacy.
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

  // PATCH — update existing mapped event on its mapped calendar.
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
 * `targetType` defaults to `"core.event"` so legacy single-calendar
 * callers (the pre-T-231 schedule handler) write cross-app `core.event`
 * items as they always did. Multi-calendar mode passes the
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
  if (event.start?.dateTime !== undefined) {
    properties.starts_at = event.start.dateTime;
  } else if (event.start?.date !== undefined) {
    properties.starts_at = event.start.date;
  }
  if (event.end?.dateTime !== undefined) {
    properties.ends_at = event.end.dateTime;
  } else if (event.end?.date !== undefined) {
    properties.ends_at = event.end.date;
  }
  if (event.status !== undefined) properties.status = event.status;

  if (targetType === "core.event") {
    // Legacy cross-app target carries the html link as a generic url.
    if (event.htmlLink !== undefined) properties.url = event.htmlLink;
    return { type: targetType, properties };
  }

  // `google.calendar.event` (upstream-fidelity target). Carry the
  // Google-specific fields the type declares so a round-trip preserves
  // what Calendar considers authoritative.
  if (event.htmlLink !== undefined) properties.html_link = event.htmlLink;
  if (event.etag !== undefined) properties.etag = event.etag;
  if (event.start?.timeZone !== undefined) {
    properties.timezone = event.start.timeZone;
  } else if (event.end?.timeZone !== undefined) {
    properties.timezone = event.end.timeZone;
  }
  // all_day is implied by `date` (no time) rather than `dateTime`.
  if (event.start?.date !== undefined && event.start.dateTime === undefined) {
    properties.all_day = true;
  }
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
  if (Array.isArray(event.recurrence) && event.recurrence.length > 0) {
    properties.recurrence = event.recurrence;
  }
  if (event.recurringEventId !== undefined) {
    properties.recurring_event_id = event.recurringEventId;
  }
  if (event.colorId !== undefined) properties.color_id = event.colorId;
  return { type: targetType, properties };
}

/**
 * Build the Calendar API request payload from a Marfa item.
 *
 * Honours optional `all_day` (writes `start.date` / `end.date` instead
 * of `dateTime`) and `timezone` (sets `start.timeZone` / `end.timeZone`).
 * Both are read from item properties — present on
 * `google.calendar.event` items, absent on plain `core.event` items.
 * The fallback (no `all_day`, no `timezone`) matches the pre-T-231
 * behaviour exactly: `start: { dateTime: <iso> }`, `end: { dateTime: <iso> }`.
 */
function buildCalendarPayload(item: ItemResource): Record<string, unknown> {
  const props = (item.properties ?? {}) as {
    title?: unknown;
    description?: unknown;
    place?: unknown;
    starts_at?: unknown;
    ends_at?: unknown;
    timezone?: unknown;
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

  if (typeof props.starts_at === "string") {
    if (isAllDay) {
      payload.start = { date: props.starts_at };
    } else if (timezone !== undefined) {
      payload.start = { dateTime: props.starts_at, timeZone: timezone };
    } else {
      payload.start = { dateTime: props.starts_at };
    }
  }
  if (typeof props.ends_at === "string") {
    if (isAllDay) {
      payload.end = { date: props.ends_at };
    } else if (timezone !== undefined) {
      payload.end = { dateTime: props.ends_at, timeZone: timezone };
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
 * the connection's primary calendar so legacy single-calendar code
 * paths continue to address the primary as before.
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
  // `mapping_calendars`; legacy mode has no entry there and falls
  // back to the connection's default-write calendar.
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
