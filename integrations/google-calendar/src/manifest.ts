/**
 * Manifest for the Google Calendar bidirectional test integration.
 *
 * The bidi-position stress-test connector. Both inbound (poll
 * Calendar → upsert Myme `core.event`) and outbound (item-event
 * on `core.event` → push to Calendar via OAuth proxy) wired
 * through one connector. All four `bidirectional_handling`
 * fields are exercised:
 *
 *   - `echo_ttl_seconds` (120) — after writing to Calendar, the
 *     same event reappearing on the next inbound poll is
 *     suppressed for two minutes.
 *   - `lag_window_seconds` (600) — outbound writes within ten
 *     minutes of a recent same-id outbound are deferred to
 *     avoid stomp races.
 *   - `tombstone_mapping: "state-trashed"` — Calendar event with
 *     `status: "cancelled"` triggers a transition-to-trashed on
 *     the Myme item; trashing a Myme item triggers a Calendar
 *     DELETE.
 *   - `partial_write_mode: "accept-partial"` — an outbound
 *     batch with a failing event still commits the others;
 *     each failure surfaces as a `system.activity`.
 *
 * OAuth uses the proxy mode (`oauth_requirements: { calendar: "proxy" }`).
 * Calendar OAuth tokens are bootstrapped via the server's
 * provider-agnostic `GET /oauth/callback/:provider` route
 * (see `packages/server/src/routes/oauth-callback.ts`), which
 * exchanges the authorization code and persists tokens to
 * `storage.connectionOauthTokens`. The connector reads them at
 * request time through the OAuth proxy.
 */
import type { IntegrationManifest } from "@mymehq/shared";

export const GOOGLE_CALENDAR_MANIFEST: IntegrationManifest = {
  name: "mymehq.google-calendar",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "mymehq",
  description:
    "Bidirectional sync between Google Calendar and Myme core.event items. Inbound via 10-minute schedule polling, outbound via item-event reactive trigger.",
  direction: "both",
  runtime_compatibility: ["hosted", "local"],
  target_types: ["core.event"],
  triggers: [
    { type: "schedule", config: { cron: "*/10 * * * *" } },
    { type: "item-event" },
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 120,
    lag_window_seconds: 600,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: { calendar: "proxy" },
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = GOOGLE_CALENDAR_MANIFEST.name;
export const DEFAULT_CALENDAR_ID = "primary";
export const CALENDAR_API_BASE = "/calendar/v3";
