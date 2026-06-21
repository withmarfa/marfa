# google-calendar

Bidirectional sync between Google Calendar and Marfa. First instance
of the `google.*` publisher family; Google Tasks, Contacts, Drive
will follow the same conventions.

## Identity

- Manifest name: **`google.calendar`** (publisher `google`,
  identifier `calendar`).
- Target types: `core.event` AND `google.calendar.event`. The
  install pipeline grants the runtime credential write permission
  on both; the user picks at install which is actually written
  (default `google.calendar.event` for upstream fidelity;
  `core.event` for cross-app interop).

## OAuth scopes

Two scopes only, declared in `manifest.ts` as
`RECOMMENDED_OAUTH_SCOPES`:

- `https://www.googleapis.com/auth/calendar.readonly` — list the
  user's calendars at install for the picker; read events on each
  selected calendar.
- `https://www.googleapis.com/auth/calendar.events` — create,
  update, delete events on the calendars the user has authorized.

Deliberately narrower than the broader `calendar` scope. The
integration physically cannot create, delete, or modify calendars
themselves — only events on calendars the user has selected.

## Multi-calendar configuration

Driven by `connection.properties.configuration`:

- `selected_calendar_ids: string[]` — every calendar to sync from.
- `default_write_calendar_id: string` — new outbound items go here
  (must be in `selected_calendar_ids`).
- `target_type: string` — `google.calendar.event` (default) or
  `core.event`.
- `inbound_webhook_url?: string` — set when an inbound subscription
  has been minted; enables push notifications via `channels.watch`.

Set via the install-time picker at `GET /connections/:id/configure`.
Without configuration the handler runs in single-primary-calendar
mode — the default for an uninstalled-picker connection and the
safety net for `core.event` writes.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  syncToken: string | null,              // single-calendar mode only
  last_inbound_at: string | null,        // single-calendar mode only
  mappings: Record<external_id, marfa_id>,
  mapping_calendars?: Record<external_id, calendar_id>,  // multi mode
  per_calendar?: Record<calendar_id, { syncToken, last_inbound_at }>,
  channels?: Record<calendar_id, {
    channel_id, resource_id, expiration_ms, channel_token
  }>,                                    // push notifications
  retired_channels?: Array<...>          // transient renewal stash
}
```

`mappings` is a flat `Record<external_id, marfa_id>` shared by both
modes; multi mode populates `mapping_calendars` alongside so
updates/deletes know which calendar to address.

## Push notifications via channels.watch

Active when **both** `selected_calendar_ids` AND `inbound_webhook_url`
are configured. The schedule trigger (every 10 minutes) doubles as
the channel-renewal cron:

- On each tick, for each selected calendar, check if its watch
  channel exists and is more than 1 day from expiry.
- If not, create a new channel via
  `POST /calendar/v3/calendars/{id}/events/watch` with a fresh
  per-channel `token` (the shared secret for `verifyGoogleChannel`),
  request 6-day expiration, persist channel state.
- If renewing: create the NEW channel first (Google starts delivering
  to it immediately), persist its state, THEN call
  `POST /calendar/v3/channels/stop` for the old. If stop fails the
  new channel keeps pushes flowing; the dangling old expires within
  its own TTL. Zero-downtime renewal per Nango's documented pattern.

Push pushes have no body — `handleWebhook` extracts the calendar id
from `X-Goog-Resource-URI`, drives the same incremental-sync path
the schedule handler uses (`events.list?syncToken=...`), and acks.

## Deterministic-id idempotency

Outbound new-event POST stamps a client-supplied `id` derived from
the Marfa item id (`SHA-256("marfa:" + item.id)` → 64-char hex, which
is a subset of Calendar's base32hex alphabet). On Calendar's 409
"conflict" response we GET the existing event for its current state
and record the mapping idempotently. Result: at most one Calendar
event per Marfa item id, regardless of how many queue retries fire.

## All-day and timezone

`buildCalendarPayload` reads:

- `properties.all_day === true` → writes `start.date` / `end.date`
  (YYYY-MM-DD) instead of `start.dateTime`. No timezone field.
- `properties.timezone: string` → writes `start.timeZone` /
  `end.timeZone` alongside `dateTime`.

Items without these fields write the plain `dateTime` shape, which
keeps `core.event` round-trips intact.

## Recurrence — parked

`recurrence` (RRULE strings) and `recurring_event_id` (parent
pointer) ARE round-tripped onto `google.calendar.event` items for
fidelity, but no expansion / instance-handling is implemented.
Recurring events appear as their parent record only. Closing this
gap is a follow-up; the type carries the data so the migration is
purely handler-side.

## Conditional writes — parked

ETag is captured into the content hash and onto the item's
`etag` property, but no `If-Match` is sent on PATCH. Last-write-wins
under concurrent edits. Tighten to optimistic concurrency in a
follow-up if real users hit it.

## Validation

Validate end-to-end against a throwaway Google test account: use
the Google Calendar API (via the Google Cloud client of your choice)
to generate data and read it back, then confirm items round-trip
through the integration.
