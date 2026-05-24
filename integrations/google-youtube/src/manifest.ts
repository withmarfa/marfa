/**
 * Manifest for the Google YouTube inbound integration
 * (`google.youtube`).
 *
 * Fourth instance of the `google.*` publisher family — sibling to
 * `google.calendar`, `google.tasks`, and `google.contacts`. Same
 * publisher namespace, same OAuth provider credential (reused via
 * `credential_ref` at install time).
 *
 * Consumer surface only (v1): liked videos, subscriptions, and
 * user-created playlists. Inbound-only (`direction: "read"`); the
 * outbound surface (writing playlists, liking videos, subscribing to
 * channels) is deliberately out of scope.
 *
 * YouTube Data API v3 quirks worth knowing upfront:
 *
 *   - **Liked-playlist discovery.** Likes are surfaced via the magic
 *     playlist returned by `channels.list?part=contentDetails&mine=true`
 *     under `items[0].contentDetails.relatedPlaylists.likes`. The
 *     handler resolves this id on first sweep and caches it on the
 *     cursor.
 *   - **No API-level sync tokens.** YouTube has no equivalent of the
 *     People-API `syncToken`. Incremental sync uses logical watermarks:
 *     `snippet.publishedAt` for liked videos,
 *     `subscriberSnippet.subscribedAt` for subscriptions. Every sweep
 *     paginates forward and stops when an item's watermark <= the
 *     stored watermark.
 *   - **Batch-of-50 video lookups.** `videos.list?id=<csv>` accepts up
 *     to 50 ids per call. The handler batches new likes into chunks of
 *     50 before fetching full video metadata.
 *
 * Quota math: a typical hourly sweep is ~3–5 units. 24 sweeps/day =
 * 72–120 units against the default 10,000-unit daily quota. Headroom
 * to spare for occasional large-batch hydration.
 *
 * OAuth uses the proxy mode (`oauth_requirements: { youtube: "proxy" }`).
 * Single scope `https://www.googleapis.com/auth/youtube.readonly` —
 * covers likes, subs, and playlists in one read-only consumer grant.
 * The broader `youtube` (full) scope is deliberately NOT requested —
 * outbound is out of scope for v1.
 *
 * YouTube Data API is hosted at `https://www.googleapis.com`, same
 * host as Calendar / Tasks / Drive — the shared google.* credential
 * row works without a T-254 per-connection
 * `upstream_base_url_override`.
 */
import type { IntegrationManifest } from "@mymehq/shared";

export const GOOGLE_YOUTUBE_MANIFEST: IntegrationManifest = {
  name: "google.youtube",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "google",
  description:
    "Inbound YouTube (Data API v3) integration — liked videos, subscriptions, and user-created playlists. Consumer surface only; outbound deferred.",
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  target_types: [
    "google.youtube.video",
    "google.youtube.playlist",
    "google.youtube.channel",
  ],
  triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
  bidirectional_handling: {
    // Inbound-only — echo / lag windows aren't meaningfully exercised,
    // but the schema requires them. Minimal values match the
    // raindrop.bookmarks pattern (another inbound-only integration).
    echo_ttl_seconds: 1,
    lag_window_seconds: 1,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: { youtube: "proxy" },
  // Required by the schema even though no webhook trigger is declared
  // — same placeholder shape used by rss-watcher / google-tasks /
  // google-contacts.
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: { "parent-of": "write" },
  },
};

export const INTEGRATION_NAME = GOOGLE_YOUTUBE_MANIFEST.name;

/**
 * YouTube Data API v3 base path — relative under the connection's
 * `upstream_base_url` (`https://www.googleapis.com`, shared with the
 * other google.* integrations).
 */
export const YOUTUBE_API_BASE = "/youtube/v3";

/** Default target type for liked / playlist-walked videos. */
export const DEFAULT_TARGET_TYPE = "google.youtube.video";

/** YouTube `videos.list?id=<csv>` accepts up to 50 ids per call. */
export const BATCH_FETCH_MAX = 50;

/**
 * Per-endpoint field masks — slim wire traffic + make the handler's
 * contract explicit.
 */
export const CHANNELS_LIST_PART = "snippet,contentDetails,statistics";
export const PLAYLIST_ITEMS_PART = "snippet,contentDetails";
export const SUBSCRIPTIONS_PART = "snippet,subscriberSnippet";
export const PLAYLISTS_PART = "snippet,contentDetails,status";
export const VIDEOS_PART = "snippet,contentDetails,statistics,status";

/**
 * OAuth scopes this integration requests. One scope only —
 * `youtube.readonly` covers liked videos, subscriptions, and
 * playlists. The broader `youtube` (full) scope is deliberately not
 * requested; outbound surface is out of scope for v1.
 */
export const RECOMMENDED_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

export const GOOGLE_YOUTUBE_OAUTH_SCOPES_STRING =
  RECOMMENDED_OAUTH_SCOPES.join(" ");
