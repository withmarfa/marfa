/**
 * Manifest for the Google Contacts bidirectional integration
 * (`google.contacts`).
 *
 * Third instance of the `google.*` publisher family — sibling to
 * `google.calendar` and `google.tasks`. Same publisher namespace;
 * same OAuth provider credential (reused via `credential_ref` at
 * install time so the stored Web-client config and encrypted secret
 * are shared across every google.* integration).
 *
 * People API quirks worth knowing upfront:
 *
 *   - **No push notifications.** The People API does not expose
 *     `channels.watch` for the `connections` collection (as of
 *     this writing — verified against the v1 reference). Inbound
 *     sync is schedule-only.
 *   - **`syncToken` for incremental.** `people.connections.list`
 *     returns a `nextSyncToken` that the next call passes back to
 *     receive only mutations since the prior list. A `410` response
 *     means the token expired (typical at >7 days idle); handler
 *     falls back to a full `connections.list` re-pull.
 *   - **`personFields` mask is mandatory on every read.** There is
 *     no "return everything" shortcut. The handler pins a single
 *     comprehensive mask (`PERSON_FIELDS`) that covers names,
 *     emails, phones, addresses, organizations, biographies,
 *     photos, birthdays, nicknames, and metadata.
 *   - **etag-based optimistic concurrency on writes.** Stale etag
 *     surfaces as 409; the handler refetches and reapplies.
 *
 * OAuth uses the proxy mode (`oauth_requirements: { contacts: "proxy" }`).
 * Tokens flow through `ctx.marfa.proxyRequest` against
 * `https://people.googleapis.com`; the server stamps the bearer
 * transparently and refreshes on 401.
 *
 * Scope discipline: this integration requests `contacts` only —
 * read + write on the user's own `connections` collection. The
 * separate `contacts.other.readonly` scope (read-only access to the
 * Other-Contacts collection, populated by Google from inbound mail
 * etc.) is deliberately not requested; that collection is read-only
 * via the People API anyway and out of scope for v1.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

/**
 * The two families a connection chooses between, declared once and carried
 * on the manifest itself so the platform validates family coherence
 * centrally and the configure surface derives the chooser.
 */
export const FAMILY_DEFINITIONS: Record<
  "google" | "core",
  { description: string; types: { contact: string } }
> = {
  google: {
    description:
      "The Google Contacts type, which keeps the full People API field set for an exact round trip.",
    types: { contact: "google.contacts.contact" },
  },
  core: {
    description:
      "The core person type, readable by any app that understands core entities; drops the per-channel email, phone, and address arrays that type cannot hold.",
    types: { contact: "core.entity.person" },
  },
};

export type WriteFamily = keyof typeof FAMILY_DEFINITIONS;

export const DEFAULT_WRITE_FAMILY: WriteFamily = "google";

export const GOOGLE_CONTACTS_MANIFEST: IntegrationManifest = {
  name: "google/contacts",
  version: "0.3.0",
  manifest_schema_version: "2.0.0",
  configuration_schema: {
    write_family: {
      type: "string",
      description:
        "Item family synced contacts land as. The google family keeps the full People API field set; the core family is the cross-app shape other apps read, and drops what that type cannot hold.",
      from_write_families: true,
      default: DEFAULT_WRITE_FAMILY,
    },
  },
  publisher: "google",
  description:
    "Bidirectional sync between Google Contacts (People API) and Marfa. Polls connections.list on a 10-minute schedule with syncToken incremental cursor and writes Marfa-side mutations back via OAuth proxy with etag-based concurrency.",
  direction: "both",
  // The runtime credential is granted write permission on both families'
  // types so either is reachable at handler time; the install-time
  // configuration chooses which family a connection actually writes.
  target_types: [
    FAMILY_DEFINITIONS.core.types.contact,
    FAMILY_DEFINITIONS.google.types.contact,
  ],
  write_families: {
    families: FAMILY_DEFINITIONS,
    default: DEFAULT_WRITE_FAMILY,
  },
  triggers: [
    { type: "schedule", config: { cron: "*/10 * * * *" } },
    { type: "item-event" },
    // Deliberately NO `webhook` trigger — People API has no
    // channels.watch surface for the connections collection.
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 120,
    lag_window_seconds: 600,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: { contacts: "proxy" },
  // Placeholder webhook_verification — required by the schema even
  // though no webhook trigger is declared. Mirrors the rss-watcher
  // / task-auto-archive / google-tasks pattern.
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = GOOGLE_CONTACTS_MANIFEST.name;

/**
 * People API base path — relative under the connection's
 * `upstream_base_url`. **Operator note:** the People API is hosted at
 * `https://people.googleapis.com`, not `https://www.googleapis.com`,
 * so the `system.credential` this connection references via
 * `credential_ref` MUST have `upstream_base_url = "https://people.googleapis.com"`
 * — distinct from the shared google.calendar / google.tasks credential
 * (which uses `https://www.googleapis.com`). Mint a separate
 * People-scoped credential at install time. See `CLAUDE.md` for the
 * substrate-gap rationale + the follow-on plan for per-host overrides
 * on a shared credential.
 */
export const PEOPLE_API_BASE = "/v1";

/**
 * Comprehensive personFields mask requested on every `connections.list`
 * + `getContact` call. Mask MUST be passed; there is no "return
 * everything" shortcut. The trade-off on width: a slimmer mask is
 * faster on the wire but loses fidelity on the round-trip; the wider
 * mask used here is the right pick for a typed personal-data layer
 * where the cost of dropping a field on inbound is "user re-adds
 * the data by hand".
 */
export const PERSON_FIELDS = [
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "addresses",
  "organizations",
  "biographies",
  "photos",
  "birthdays",
  "metadata",
].join(",");

/**
 * Personal-field mask the handler passes on UPDATE writes
 * (`updatePersonFields` query param on `people.updateContact`). Only
 * fields the handler actually writes are listed here so we don't
 * accidentally clear a field Google holds that we didn't reconstruct.
 */
export const UPDATE_PERSON_FIELDS = [
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "addresses",
  "organizations",
  "biographies",
  "birthdays",
].join(",");

/**
 * OAuth scopes this integration requests. One scope only — `contacts`
 * covers both read and write on the user's own `connections`
 * collection. Granular scopes (`contacts.readonly`,
 * `contacts.other.readonly`, `directory.readonly`) are deliberately
 * not requested; they're additive surfaces this integration doesn't
 * touch in v1.
 *
 * Consumed by:
 *   - The OAuth provider credential's `oauth_default_scope` (reused
 *     from google.calendar / google.tasks via `credential_ref`).
 *   - The install flow's call to `POST /connections/:id/oauth/start`
 *     which passes `scope: GOOGLE_CONTACTS_OAUTH_SCOPES_STRING`.
 */
export const RECOMMENDED_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/contacts",
] as const;

export const GOOGLE_CONTACTS_OAUTH_SCOPES_STRING =
  RECOMMENDED_OAUTH_SCOPES.join(" ");
