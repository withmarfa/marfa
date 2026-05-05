/**
 * Google Calendar bidirectional handlers.
 *
 * Two triggers, one shared echo-suppression + mapping store:
 *
 * - SCHEDULE (10-minute incremental sync, inbound):
 *     Calls Calendar's `events.list` with the stored `syncToken`
 *     (opaque). For each returned event:
 *       - If `status === "cancelled"` → trash the matching Myme
 *         item if we know its id.
 *       - Else compute `(external_id, content_hash)`. If
 *         echo.shouldSkipReactive(...) → skip (we wrote this
 *         ourselves recently).
 *       - Else upsert as `core.event`. Record the mapping in
 *         the cursor.
 *     Update the syncToken on success.
 *
 * - ITEM-EVENT (outbound, fires on Myme `core.event` mutations):
 *     - The reactive bridge already filters self-events (Layer 2
 *       PR 3); double-check defensively against `cycle`.
 *     - If we're inside the lag window for this external_id,
 *       defer (return ok=false retry=true).
 *     - For created items: POST to Calendar with a deterministic
 *       client-supplied `id` derived from the Myme item id (T-020).
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
 * therefore produces at most one Calendar event per Myme item id,
 * regardless of retry count.
 */
import {
  registerScheduleHandler,
  registerItemEventHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type ItemEventMessage,
  type HandlerResult,
  type CreateItemInput,
  type ItemResource,
} from "@mymehq/runtime-sdk";
import { CALENDAR_API_BASE, DEFAULT_CALENDAR_ID } from "./manifest.js";

const CURSOR_KEY = "main";

interface CalendarCursor {
  /** Opaque sync token from Calendar's incremental-sync API. */
  syncToken: string | null;
  /** ISO timestamp of the last successful schedule run. */
  last_inbound_at: string | null;
  /** Map of Calendar event id → Myme item id. Used to look up
   *  the Myme item on echo / update / delete without round-tripping
   *  through the server. Bounded by Calendar's own dedup;
   *  realistically a few hundred to a few thousand entries. */
  mappings: Record<string, string>;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  etag?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
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
  void message;
  const cursor: CalendarCursor = ((await ctx.cursor.read(
    CURSOR_KEY,
  )) as CalendarCursor | null) ?? {
    syncToken: null,
    last_inbound_at: null,
    mappings: {},
  };

  const calendarId = await resolveCalendarId(ctx);
  const params = new URLSearchParams();
  if (cursor.syncToken !== null) params.set("syncToken", cursor.syncToken);
  else params.set("maxResults", "250"); // initial backfill cap
  const path = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;

  let response: Response;
  try {
    response = await ctx.myme.proxyRequest("GET", path);
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
    const myme_id = cursor.mappings[event.id];
    if (event.status === "cancelled") {
      if (myme_id !== undefined) {
        try {
          await ctx.myme.transitionItem(myme_id, "trashed");
          trashed += 1;
          Reflect.deleteProperty(cursor.mappings, event.id);
        } catch (err) {
          await ctx.activity.emit({
            severity: "action_required",
            summary: `google-calendar: failed to trash myme item for cancelled event ${event.id}`,
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

    const input = buildEventInput(event);
    try {
      if (myme_id !== undefined) {
        await ctx.myme.updateItem(myme_id, input);
      } else {
        const created = await ctx.myme.createItem({
          ...input,
          source_id: event.id,
        } as CreateItemInput & { source_id: string });
        cursor.mappings[event.id] = created.id;
      }
      upserted += 1;
    } catch (err) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `google-calendar: failed to upsert myme item for event ${event.id}`,
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
  const item = await ctx.myme.getItem(message.item_id);
  if (item === null) {
    // Item disappeared (deleted before we could read). Treat it
    // as a delete-equivalent if we know the mapping by checking
    // mappings reverse: but the bridge gives us item_id, and
    // mappings are external_id → myme_id, so reverse-lookup.
    return ackHandledIfMappedAsDelete(ctx, cursor, message.item_id);
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
      const resp = await ctx.myme.proxyRequest("DELETE", path);
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
    // T-020: stamp a deterministic id derived from the Myme item id
    // so a retry of the same handler invocation reaches Calendar
    // with the same id. Calendar's `events.insert` accepts a
    // client-supplied `id` (5–1024 chars, base32hex alphabet — hex
    // is a subset of base32hex, so a SHA-256 hex digest is valid)
    // and returns 409 on conflict. The 409 path below recovers the
    // mapping idempotently without creating a duplicate event.
    const deterministicId = await deriveDeterministicCalendarId(item.id);
    const calendarId = await resolveCalendarId(ctx);
    const postPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const postPayload = { ...calendarPayload, id: deterministicId };
    const resp = await ctx.myme.proxyRequest("POST", postPath, postPayload);

    if (resp.status === 409) {
      // A prior attempt of this same handler invocation succeeded
      // at Calendar but did not persist its cursor write (e.g. the
      // Worker crashed mid-handler and Cloudflare Queues retried
      // the whole batch). Fetch the event Calendar already holds,
      // record the mapping with the id we sent, and proceed as if
      // the original POST had landed cleanly.
      const fetchPath = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(deterministicId)}`;
      const fetchResp = await ctx.myme.proxyRequest("GET", fetchPath);
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
        summary: `google-calendar outbound: idempotent recovery — Calendar already had an event for Myme item ${item.id}`,
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
  const resp = await ctx.myme.proxyRequest("PATCH", path, calendarPayload);
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
}

async function resolveCalendarId(ctx: ConnectionContext): Promise<string> {
  try {
    const connection = await ctx.myme.getItem(ctx.connection_id);
    const props = connection?.properties as
      | { configuration?: unknown }
      | undefined;
    const config = props?.configuration;
    if (
      typeof config === "object" &&
      config !== null &&
      "calendar_id" in config
    ) {
      const raw = (config as { calendar_id?: unknown }).calendar_id;
      if (typeof raw === "string" && raw.length > 0) return raw;
    }
  } catch {
    // Fall through.
  }
  return DEFAULT_CALENDAR_ID;
}

function buildEventInput(event: CalendarEvent): CreateItemInput {
  const properties: Record<string, unknown> = {
    title: event.summary ?? "Untitled event",
  };
  if (event.description !== undefined)
    properties.description = event.description;
  if (event.location !== undefined) properties.place = event.location;
  if (event.htmlLink !== undefined) properties.url = event.htmlLink;
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
  return { type: "core.event", properties };
}

function buildCalendarPayload(item: ItemResource): Record<string, unknown> {
  const props = item.properties ?? {};
  const summary = (props as { title?: unknown }).title;
  const description = (props as { description?: unknown }).description;
  const place = (props as { place?: unknown }).place;
  const startsAt = (props as { starts_at?: unknown }).starts_at;
  const endsAt = (props as { ends_at?: unknown }).ends_at;
  const payload: Record<string, unknown> = {};
  if (typeof summary === "string") payload.summary = summary;
  if (typeof description === "string") payload.description = description;
  if (typeof place === "string") payload.location = place;
  if (typeof startsAt === "string") payload.start = { dateTime: startsAt };
  if (typeof endsAt === "string") payload.end = { dateTime: endsAt };
  return payload;
}

function buildEventPath(externalId: string): string {
  // Use primary calendar for v1; multi-calendar support is future work.
  return `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(DEFAULT_CALENDAR_ID)}/events/${encodeURIComponent(externalId)}`;
}

function findExternalIdFor(
  cursor: CalendarCursor,
  myme_id: string,
): string | null {
  for (const [ext, myme] of Object.entries(cursor.mappings)) {
    if (myme === myme_id) return ext;
  }
  return null;
}

async function ackHandledIfMappedAsDelete(
  ctx: ConnectionContext,
  cursor: CalendarCursor,
  myme_id: string,
): Promise<HandlerResult> {
  const externalId = findExternalIdFor(cursor, myme_id);
  if (externalId === null) {
    return { ok: true };
  }
  const path = buildEventPath(externalId);
  const resp = await ctx.myme.proxyRequest("DELETE", path);
  if (!resp.ok && resp.status !== 410 && resp.status !== 404) {
    return reportOutboundFailure(ctx, "DELETE", externalId, resp);
  }
  Reflect.deleteProperty(cursor.mappings, externalId);
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
 * Derive a deterministic Google Calendar event id from a Myme item
 * id. Output is a SHA-256 hex digest — 64 lowercase characters in
 * the alphabet [0-9a-f], which is a strict subset of the base32hex
 * alphabet [0-9a-v] that Calendar requires. Length is well within
 * the 5–1024 character window. Two distinct Myme item ids produce
 * different Calendar ids with overwhelmingly high probability;
 * collision is not a real concern at any plausible scale.
 *
 * The `myme:` prefix in the input means a Myme item id is unlikely
 * to ever produce the same digest as some other system stamping
 * deterministic Calendar ids, even if both used SHA-256.
 *
 * Web Crypto is the right primitive here — Cloudflare Workers
 * (where the integration runs) don't ship `node:crypto`. Node 20+
 * exposes the same API as `globalThis.crypto`, so this works under
 * the Vitest fixture too.
 */
async function deriveDeterministicCalendarId(myme_id: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`myme:${myme_id}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
