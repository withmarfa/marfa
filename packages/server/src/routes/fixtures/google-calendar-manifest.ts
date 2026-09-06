/**
 * The `google/calendar` manifest, as the integration declares it.
 *
 * A copy, because the integration lives in withmarfa/integrations and
 * nothing here can import it. It has to stay a faithful one: the configure
 * route's behavior keys on the write families, the configuration schema and
 * the OAuth requirements, so a fixture edited to suit a test stops standing
 * for the integration. Update it from the integration's own
 * `src/manifest.ts`.
 *
 * **A field this does not declare is part of the copy.** It carried
 * `runs_on: "server"` while the integration declared none, which is a
 * difference `check-manifest-fixture.mjs` refuses and did — the guard runs
 * in the image build, so a fixture that gained a field failed a workflow
 * rather than a test, and only when the pin next moved. The two mean the
 * same thing to the parser, and the guard compares declarations rather than
 * parse results, which is the stricter and more useful comparison.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const FAMILY_DEFINITIONS: Record<
  "google" | "core",
  { description: string; types: { event: string } }
> = {
  google: {
    description:
      "The Google Calendar type, which keeps the full Calendar field set for an exact round trip.",
    types: { event: "google.calendar.event" },
  },
  core: {
    description:
      "The core event type, readable by any app that understands core events; lossier, dropping Calendar-only fields such as the etag.",
    types: { event: "core.event" },
  },
};

export type WriteFamily = keyof typeof FAMILY_DEFINITIONS;

export const DEFAULT_WRITE_FAMILY: WriteFamily = "google";

export const GOOGLE_CALENDAR_MANIFEST: IntegrationManifest = {
  name: "google/calendar",
  display_name: "Google Calendar",
  version: "0.6.0",
  manifest_schema_version: "2.0.0",
  configuration_schema: {
    write_family: {
      type: "string",
      description:
        "Item family synced events land as. The google family keeps the full Calendar field set; the core family is the cross-app shape other apps read, and drops what that type cannot hold.",
      from_write_families: true,
      default: DEFAULT_WRITE_FAMILY,
    },
    selected_calendar_ids: {
      type: "string_array",
      description:
        "Calendars included in the sync; empty means the primary calendar only.",
    },
    default_write_calendar_id: {
      type: "string",
      description: "Calendar that receives events created in Marfa.",
    },
    inbound_webhook_url: {
      type: "string",
      description:
        "Push-notification receipt URL the watch channel registers against.",
    },
  },
  publisher: "marfa",
  description:
    "Bidirectional sync between Google Calendar and Marfa. Reads events from calendars the user picks at install and writes Marfa-side mutations back via OAuth proxy.",
  direction: "both",
  // The runtime credential is granted write permission on both families'
  // types so either is reachable at handler time; the install-time picker
  // chooses which family a connection actually writes.
  target_types: [
    FAMILY_DEFINITIONS.core.types.event,
    FAMILY_DEFINITIONS.google.types.event,
  ],
  write_families: {
    families: FAMILY_DEFINITIONS,
    default: DEFAULT_WRITE_FAMILY,
  },
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
    // A moved instance of a recurring series is joined to its series
    // with parent-of, which the occurrence expansion reads.
    edge: { "parent-of": "write" },
  },
  // Present because the manifest this copies declares it. It arrived
  // there on 25 August and did not arrive here, and nothing was red for
  // the week in between: this file is hand-maintained against a manifest
  // in another repository, and the only thing holding the two together
  // was somebody remembering.
  //
  // It is not decoration. `connection-mapping.ts` reads it to decide
  // whether a mapping may be stored at all, and the upgrade pipeline
  // reads it to decide whether a manifest change is safe to apply
  // automatically — so a copy that says nothing describes an integration
  // that refuses mappings, which this one does not.
  supports_user_mappings: true,
};
