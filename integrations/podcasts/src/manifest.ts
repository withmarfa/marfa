/**
 * Podcasts — scheduled poll of podcast RSS feeds.
 *
 * Reads only. A feed is a document a publisher serves; there is nothing to
 * write back to, so there is no item-event trigger and no reactive-run queue.
 *
 * Two write families, chosen per connection. The default is this
 * integration's own types, which keep what a feed actually carries. A
 * connection set to `core` writes `core.media.series` and
 * `core.media.episode` instead, trading the enclosure's MIME type and
 * claimed size, the raw duration string, explicitness, categories and
 * episode type — none of which the core types can hold — for shapes every
 * other app already reads.
 *
 * Podcast Index is not a token requirement. Its key belongs to whoever runs
 * the deployment rather than to a person using it, so it is supplied as a
 * Worker secret and enrichment simply does not run without it. A manifest
 * cannot express an optional credential in any case: `token_requirements`
 * admits only "required", and declaring it would make a directory lookup a
 * precondition for reading a public feed.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

/**
 * The two families a connection chooses between, declared once and carried
 * on the manifest itself so the platform validates family coherence
 * centrally and the configure surface derives the chooser.
 */
const FAMILY_DEFINITIONS: Record<
  "podcast" | "core",
  { description: string; types: { show: string; episode: string } }
> = {
  podcast: {
    description: "The podcast types, which keep everything a feed carries.",
    types: {
      show: "withmarfa.podcast.show",
      episode: "withmarfa.podcast.episode",
    },
  },
  core: {
    description:
      "The core media types, readable by any app that understands core media; drops what those types cannot hold.",
    types: {
      show: "core.media.series",
      episode: "core.media.episode",
    },
  },
};

/** Role maps the handlers index; same object the manifest declares. */
export const WRITE_FAMILIES = {
  podcast: FAMILY_DEFINITIONS.podcast.types,
  core: FAMILY_DEFINITIONS.core.types,
} as const;

export type WriteFamily = keyof typeof WRITE_FAMILIES;

export const DEFAULT_WRITE_FAMILY: WriteFamily = "podcast";

export const PODCASTS_MANIFEST: IntegrationManifest = {
  name: "withmarfa.podcasts",
  version: "0.2.0",
  manifest_schema_version: "1.3.0",
  publisher: "withmarfa",
  description:
    "Polls podcast RSS feeds on a schedule and mirrors each show and its episodes, joined by in-collection edges. Writes its own podcast types by default, or the core media types when a connection chooses interoperability over fidelity. Read-only.",
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  target_types: [
    WRITE_FAMILIES.podcast.show,
    WRITE_FAMILIES.podcast.episode,
    WRITE_FAMILIES.core.show,
    WRITE_FAMILIES.core.episode,
  ],
  triggers: [
    {
      type: "schedule",
      config: { cron: "0 * * * *" },
    },
  ],
  configuration_schema: {
    feed_urls: {
      type: "string_array",
      description:
        "Podcast RSS feed addresses to poll. Every podcast app can export one for a show you already follow.",
      required: true,
    },
    write_family: {
      type: "string",
      description:
        "Item family shows and episodes land as. The podcast family keeps everything a feed carries; the core family is readable by any app that understands core media, and drops what those types cannot hold.",
      from_write_families: true,
      default: DEFAULT_WRITE_FAMILY,
    },
  },
  write_families: {
    families: FAMILY_DEFINITIONS,
    default: DEFAULT_WRITE_FAMILY,
  },
  /**
   * A feed dropping an item is indistinguishable from a feed that publishes
   * only a recent window, and hosts do both. Treating a disappearance as a
   * deletion would trash a back catalogue the first time a publisher
   * switched to a ten-item feed, so it is ignored.
   *
   * The echo and lag windows exist because the schema requires them. Nothing
   * is ever written upstream, so no write of ours can echo back.
   */
  bidirectional_handling: {
    echo_ttl_seconds: 1,
    lag_window_seconds: 1,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: { "in-collection": "write" },
  },
};

export const INTEGRATION_NAME = PODCASTS_MANIFEST.name;

/** Feeds polled in one tick before the rest wait for the next. */
export const MAX_FEEDS_PER_TICK = 5;

/** Episodes written in one tick, across all feeds, before parking. */
export const MAX_EPISODES_PER_TICK = 500;

/**
 * Episodes per write. Each created episode also costs an edge call, and a
 * production write has been measured in seconds rather than milliseconds,
 * so this is deliberately far below the server's own bulk ceiling.
 */
export const EPISODE_BATCH_SIZE = 25;

/** Subscriptions one connection will poll. Beyond this the tick reports rather than truncates. */
export const MAX_FEEDS_PER_CONNECTION = 50;

/** Recently seen episode ids kept per feed, newest last. */
export const RECENT_ID_RING_SIZE = 300;

/**
 * Largest feed body this will read. The biggest feed measured in the wild is
 * a little under eighteen megabytes; the ceiling leaves room above that
 * while still refusing something that would exhaust a Worker.
 */
export const MAX_FEED_BYTES = 40 * 1024 * 1024;

/** A feed parked this long without progress is reported rather than retried forever. */
export const STUCK_FEED_DAYS = 7;
