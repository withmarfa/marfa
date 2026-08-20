/**
 * Manifest for the Readwise Reader integration (`readwise.reader`).
 *
 * Reader is a separate product from Readwise Highlights and speaks a
 * separate API (`/api/v3/`, documents) from the `/api/v2/export/`
 * surface the `readwise.highlights` integration polls. They share a
 * publisher and can share one credential, because both live under
 * `readwise.io`, but nothing else — different objects, different rate
 * buckets, different direction.
 *
 * Readwise requires `Authorization: Token <key>` and rejects Bearer, so
 * the credential is minted via `POST /credentials/api-token` with
 * `auth_scheme: "Token"`.
 *
 * Hourly cron. Reads are the scarce budget here: the list endpoint
 * allows 20 requests a minute against 50 for writes, so the sweep is
 * paced and paginates across ticks rather than draining in one run.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const READWISE_READER_MANIFEST: IntegrationManifest = {
  name: "readwise/reader",
  version: "0.1.0",
  manifest_schema_version: "1.2.0",
  publisher: "readwise",
  description:
    "Bidirectional sync with Readwise Reader. Polls the v3 documents API hourly with an `updatedAfter` watermark and mirrors saved documents as readwise.document items; pushes creates, edits and trashes back to Reader. Feed items are excluded unless configured in.",
  direction: "both",
  runtime_compatibility: ["local"],
  target_types: ["readwise.document"],
  triggers: [
    { type: "schedule", config: { cron: "0 * * * *" } }, // hourly
    { type: "item-event" },
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 120,
    lag_window_seconds: 600,
    // Reader's v3 API exposes no deletion signal of any kind: nothing in
    // the list response marks a document deleted, and no webhook event
    // announces one. An upstream delete is only detectable by sweeping
    // every known id against a 20-per-minute budget, so nothing here can
    // honestly claim to map a tombstone.
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  token_requirements: { readwise: "required" },
  // Schema-required even with no webhook trigger declared, matching the
  // schedule-only convention across the fleet.
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
  configuration_schema: {
    include_feed: {
      type: "boolean",
      description:
        "Mirror documents sitting in Reader's feed as well as saved ones. Off by default: the feed is a subscription firehose, and in a typical library it outnumbers saved documents roughly ten to one.",
      default: false,
    },
  },
};

export const INTEGRATION_NAME = READWISE_READER_MANIFEST.name;

/** The type this integration mirrors documents as. */
export const DEFAULT_TARGET_TYPE = "readwise.document";

/** Reader v3 paths. All are relative to `https://readwise.io`. */
export const LIST_PATH = "/api/v3/list/";
export const SAVE_PATH = "/api/v3/save/";
export const UPDATE_PATH = "/api/v3/update/";
export const DELETE_PATH = "/api/v3/delete/";

/**
 * First-run watermark. Reader accepts an absent `updatedAfter` for a
 * full drain, but keeping the cursor field a plain string beats an
 * optional one everywhere it is read.
 */
export const UPDATED_AFTER_INITIAL = "1970-01-01T00:00:00Z";

/**
 * Pages to drain per scheduled sweep before parking the cursor and
 * waiting for the next tick.
 *
 * The list endpoint allows 20 requests a minute and throttles with a
 * `Retry-After` measured in seconds. Fifteen leaves five requests of
 * headroom for the outbound read-backs that may run in the same
 * window, and for the sibling Highlights integration sharing the token.
 */
export const MAX_PAGES_PER_SWEEP = 15;

/** Documents per page. Reader caps this at 100. */
export const PAGE_SIZE = 100;

/**
 * Categories that are child objects rather than documents in their own
 * right. Reader models a highlight and its note as documents with a
 * `parent_id`, so an unfiltered list mixes them in with articles. They
 * are also already mirrored, as `readwise.highlight`, by the sibling
 * integration that owns the Highlights API — importing them here would
 * give the same underlying object two homes.
 */
export const CHILD_CATEGORIES: ReadonlySet<string> = new Set([
  "highlight",
  "note",
]);

/**
 * Locations Reader will accept on a write. `shortlist` is readable and
 * filterable but not writable: a save or update naming it comes back
 * 201 with the document stored as `new`, so sending it silently loses
 * the placement instead of failing.
 */
export const WRITABLE_LOCATIONS: ReadonlySet<string> = new Set([
  "new",
  "later",
  "archive",
  "feed",
]);

/**
 * URL namespace for documents that originate in Marfa and have no
 * source of their own. Reader requires a URL and deduplicates on it, so
 * a document with nothing to point at still needs one, and it has to be
 * the same on every retry or a redelivery creates a second document.
 *
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve,
 * which is the point: nothing behind this URL can be fetched, and no
 * real document can ever collide with one.
 */
export const FABRICATED_URL_PREFIX = "https://marfa.invalid/items/";
