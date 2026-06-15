/**
 * Manifest for the Google Calendar bidirectional integration
 * (`google.calendar`).
 *
 * First instance of the `google.*` publisher family — same shape that
 * subsequent Google services (`google.tasks`, `google.contacts`, ...)
 * will follow. The publisher namespace is `google`; the integration
 * identifier is `google.calendar`.
 *
 * Both inbound (poll Calendar → upsert Marfa items) and outbound
 * (item-event on the target type → push to Calendar via OAuth proxy)
 * are wired through one connector. All four `bidirectional_handling`
 * fields are exercised:
 *
 *   - `echo_ttl_seconds` (120) — after writing to Calendar, the same
 *     event reappearing on the next inbound poll is suppressed for
 *     two minutes.
 *   - `lag_window_seconds` (600) — outbound writes within ten minutes
 *     of a recent same-id outbound are deferred to avoid stomp races.
 *   - `tombstone_mapping: "state-trashed"` — Calendar event with
 *     `status: "cancelled"` triggers a transition-to-trashed on the
 *     Marfa item; trashing a Marfa item triggers a Calendar DELETE.
 *   - `partial_write_mode: "accept-partial"` — an outbound batch with
 *     a failing event still commits the others; each failure surfaces
 *     as a `system.activity`.
 *
 * OAuth uses the proxy mode (`oauth_requirements: { calendar: "proxy" }`).
 * Calendar OAuth tokens are bootstrapped via the server's
 * provider-agnostic `GET /oauth/callback/:provider` route (see
 * `packages/server/src/routes/oauth-callback.ts`), which exchanges the
 * authorization code and persists tokens to
 * `storage.connectionOauthTokens`. The connector reads them at request
 * time through the OAuth proxy.
 *
 * Scope discipline: this integration requests
 *   - `https://www.googleapis.com/auth/calendar.readonly` — list user
 *     calendars at install for the picker; read events.
 *   - `https://www.googleapis.com/auth/calendar.events` — create,
 *     update, delete events on calendars the user has authorized.
 * No broader `calendar` (full calendar management) scope is requested.
 * See `RECOMMENDED_OAUTH_SCOPES` below for the canonical list consumed
 * by the install flow.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const GOOGLE_CALENDAR_MANIFEST: IntegrationManifest = {
  name: "google.calendar",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "google",
  description:
    "Bidirectional sync between Google Calendar and Marfa. Reads events from calendars the user picks at install and writes Marfa-side mutations back via OAuth proxy.",
  direction: "both",
  runtime_compatibility: ["hosted", "local"],
  // `google.calendar.event` is the upstream-fidelity type (full Calendar
  // field set, the recommended default). `core.event` is the cross-app
  // shared shape (lossier — no recurrence, no timezone, no etag); the
  // install-time picker lets the user opt into it when cross-app interop
  // matters more than fidelity. The runtime credential is granted write
  // permission on both so either is reachable at handler time.
  target_types: ["core.event", "google.calendar.event"],
  triggers: [
    { type: "schedule", config: { cron: "*/10 * * * *" } },
    { type: "item-event" },
    // Webhook trigger handles Google Calendar push notifications
    // (channels.watch). Channels point at the integration's inbound
    // receipt URL; pushes carry no body — verification is by
    // X-Goog-Channel-Token via the `google-channel` adapter. The
    // schedule trigger above stays as both the channel-renewal cron
    // and the fallback during channel gaps + initial sync.
    { type: "webhook" },
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 120,
    lag_window_seconds: 600,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: { calendar: "proxy" },
  // Google Calendar push notifications carry no body and verify by
  // shared-secret header echo (X-Goog-Channel-Token). The
  // `google-channel` adapter in `@withmarfa/webhooks` matches the channel
  // token against the per-Connection inbound-webhook subscription
  // secret captured at install time.
  webhook_verification: { method: "google-channel" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = GOOGLE_CALENDAR_MANIFEST.name;
export const DEFAULT_CALENDAR_ID = "primary";
export const CALENDAR_API_BASE = "/calendar/v3";

/**
 * Narrow set of OAuth scopes this integration requests. Tightened from
 * the broader `https://www.googleapis.com/auth/calendar` scope so the
 * consent screen reads cleanly and the integration physically cannot
 * create, delete, or modify calendars themselves — only events on
 * calendars the user has selected.
 *
 *   - `calendar.readonly` — enumerate the user's calendars at install
 *     (calendarList.list) so the picker has something to render, and
 *     read events on each selected calendar.
 *   - `calendar.events` — create, update, delete events on the
 *     calendars the user has authorized.
 *
 * Consumed by:
 *   - The OAuth provider credential (`oauth_default_scope` field on
 *     `system.credential` of kind `oauth_token`) when set up via
 *     `POST /credentials/oauth-provider` for this integration.
 *   - The install flow's call to `POST /connections/:id/oauth/start`
 *     which passes `scope: GOOGLE_CALENDAR_OAUTH_SCOPES_STRING` to the
 *     authorize URL.
 */
export const RECOMMENDED_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export const GOOGLE_CALENDAR_OAUTH_SCOPES_STRING =
  RECOMMENDED_OAUTH_SCOPES.join(" ");
