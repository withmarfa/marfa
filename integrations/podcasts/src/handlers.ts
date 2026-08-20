/**
 * Podcasts — the scheduled sweep.
 *
 * One connection holds many subscriptions. Each tick takes a few feeds in
 * rotation, asks each whether it has changed, and writes what is new.
 *
 * Three properties are load-bearing and each cost something to get right.
 *
 * **A feed that has not changed costs nothing.** Podcast feeds do not
 * paginate: one document carries every episode, and for a long-running
 * daily show that is close to eighteen megabytes. Re-reading thirty of
 * those every hour to discover that nothing happened would be most of the
 * work this integration ever does. Every host tested honors a conditional
 * request, so the steady state is a few hundred bytes of headers.
 *
 * **Progress is written after every batch, not at the end.** The previous
 * integration in this programme lost a whole backfill to the opposite
 * choice: the cursor was written once after the loop, so every sweep that
 * ran out of time discarded everything it had done, and the import
 * reported itself complete having stored a quarter of the library. A tick
 * killed mid-drain here resumes at the next batch.
 *
 * **The watermark is stricter than progress.** It advances only when a feed
 * drains completely with every batch applied. Stepping over an episode the
 * server refused would strand it permanently, because nothing re-offers an
 * episode that has not changed.
 */
import {
  registerScheduleHandler,
  type ConnectionContext,
  type CreateItemInput,
  type HandlerResult,
} from "@withmarfa/runtime-sdk";
import { resolveWriteFamily } from "@withmarfa/shared";
import {
  DEFAULT_WRITE_FAMILY,
  EPISODE_BATCH_SIZE,
  MAX_EPISODES_PER_TICK,
  MAX_FEEDS_PER_CONNECTION,
  MAX_FEEDS_PER_TICK,
  MAX_FEED_BYTES,
  RECENT_ID_RING_SIZE,
  PODCASTS_MANIFEST,
  STUCK_FEED_DAYS,
  WRITE_FAMILIES,
  type WriteFamily,
} from "./manifest.js";
import {
  parseFeed,
  type ParsedEpisode,
  type ParsedFeed,
  type ParsedShow,
} from "./feed-parser.js";
import {
  canonicalFeedName,
  episodeLocalId,
  episodeSourceId,
  showScopeKey,
  showSourceId,
  uuidV5,
} from "./identity.js";

const INDEX_CURSOR_KEY = "main";
const PODCAST_NAMESPACE_UUID = "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";

/* ------------------------------------------------------------------ */
/* Cursor shapes                                                       */
/* ------------------------------------------------------------------ */

/** Rotation state. One row, small, rewritten every tick. */
interface IndexCursor {
  /** Cursor keys for the feeds currently configured, in order. */
  feed_keys: string[];
  /** Where the next tick starts, so a large feed at the front cannot starve the rest. */
  next_feed_index: number;
  last_run_at: string | null;
}

/**
 * Per-feed state, one cursor row each rather than one shared blob. Thirty
 * feeds carrying three hundred remembered ids apiece is most of a megabyte,
 * and the per-batch checkpoint would rewrite all of it on every batch of
 * every feed. A row per feed keeps each write proportional to the feed it
 * describes.
 */
interface FeedCursor {
  feed_url: string;
  /** The show's identity. Written once and never recomputed — see below. */
  show_scope_key: string | null;
  show_item_id: string | null;
  show_title: string | null;
  /** Revalidators, echoed back exactly as received, weak prefix included. */
  etag: string | null;
  last_modified: string | null;
  /** Newest publication date fully drained. Only moves on a clean complete pass. */
  last_seen_published: string | null;
  recent_entry_ids: string[];
  /** Index into this pass's episode list while a feed is parked mid-drain. */
  backfill_cursor: number | null;
  /** Set when a pass began, so a resumed drain does not re-derive a moving target. */
  pass_started_at: string | null;
  failed_since_watermark: number;
  retried_after_failure: boolean;
  /** Set when the address leaves the configuration. State is kept, not deleted. */
  retired_at: string | null;
  last_success_at: string | null;
}

function defaultFeedCursor(feedUrl: string): FeedCursor {
  return {
    feed_url: feedUrl,
    show_scope_key: null,
    show_item_id: null,
    show_title: null,
    etag: null,
    last_modified: null,
    last_seen_published: null,
    recent_entry_ids: [],
    backfill_cursor: null,
    pass_started_at: null,
    failed_since_watermark: 0,
    retried_after_failure: false,
    retired_at: null,
    last_success_at: null,
  };
}

/**
 * A feed's cursor key, derived from its address alone.
 *
 * It has to be computable before the feed is read, because the cursor is
 * where the read's own revalidators live. So this is the address-derived
 * identifier, while the show's identity — which may be a value the feed
 * declares, and is only knowable after reading it — is stored inside.
 */
async function cursorKeyFor(feedUrl: string): Promise<string> {
  return `feed:${await uuidV5(canonicalFeedName(feedUrl), PODCAST_NAMESPACE_UUID)}`;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

interface ResolvedConfig {
  feed_urls: string[];
  write_family: WriteFamily;
}

type ConfigResolution =
  | { ok: true; config: ResolvedConfig }
  | { ok: false; error: unknown };

/**
 * Read the connection's own configuration.
 *
 * A failed read is a failure, never an empty subscription list. The two are
 * indistinguishable downstream and the consequences are not: an empty list
 * reads as "the operator unsubscribed from everything", which would retire
 * every feed on one bad response.
 */
async function resolveConfig(
  ctx: ConnectionContext,
): Promise<ConfigResolution> {
  let connection;
  try {
    connection = await ctx.marfa.getItem(ctx.connection_id);
  } catch (error) {
    return { ok: false, error };
  }

  const props = connection?.properties as
    | { configuration?: unknown }
    | undefined;
  const raw = (props?.configuration ?? {}) as Record<string, unknown>;

  const urls = Array.isArray(raw.feed_urls)
    ? raw.feed_urls.filter(
        (u): u is string => typeof u === "string" && u.trim() !== "",
      )
    : [];

  const resolved = resolveWriteFamily(PODCASTS_MANIFEST, raw);
  const writeFamily: WriteFamily =
    resolved?.name === "core" || resolved?.name === "podcast"
      ? resolved.name
      : DEFAULT_WRITE_FAMILY;

  return {
    ok: true,
    config: {
      feed_urls: urls.map((u) => u.trim()),
      write_family: writeFamily,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Property mapping                                                    */
/* ------------------------------------------------------------------ */

/**
 * What medium an episode is made of, taken from the enclosure's MIME type.
 *
 * Not from `itunes:type`, which names an ordering rather than a material:
 * a video feed and its audio sibling both declare `episodic`, so reading it
 * as the medium marks every video episode as audio.
 */
function mediumFor(episode: ParsedEpisode): "podcast" | "video" | null {
  const mime = (episode.enclosure?.type ?? "").toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "podcast";
  return null;
}

/** Drop keys with nothing in them, so an absent field is absent rather than null. */
function defined(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

function showProperties(
  show: ParsedShow,
  feedUrl: string,
  scopeKey: string,
  family: WriteFamily,
  episodeCount: number,
): Record<string, unknown> {
  const title = show.title ?? canonicalFeedName(feedUrl);

  if (family === "core") {
    return defined({
      title,
      description: show.description,
      author: show.author,
      publisher: show.owner_name,
      url: show.link,
      image_url: show.image_url,
      language: show.language,
      medium: "podcast",
      status: show.complete === true ? "ended" : null,
    });
  }

  return defined({
    title,
    feed_url: feedUrl,
    podcast_guid: scopeKey,
    link: show.link,
    description: show.description,
    author: show.author,
    owner_name: show.owner_name,
    image_url: show.image_url,
    language: show.language,
    categories: show.categories.length > 0 ? show.categories : null,
    itunes_type: show.itunes_type,
    complete: show.complete,
    explicit: show.explicit,
    copyright: show.copyright,
    new_feed_url: show.new_feed_url,
    last_build_date: show.last_build_date,
    episode_count: episodeCount,
  });
}

function episodeProperties(
  episode: ParsedEpisode,
  show: ParsedShow,
  feedUrl: string,
  scopeKey: string,
  family: WriteFamily,
): Record<string, unknown> {
  const enclosure = episode.enclosure;

  if (family === "core") {
    return defined({
      title: episode.title,
      description: episode.description,
      body: episode.content_encoded,
      author: episode.author ?? show.author,
      publisher: show.owner_name,
      url: episode.link,
      image_url: episode.image_url ?? show.image_url,
      language: show.language,
      published_at: episode.pub_date,
      duration: episode.duration_seconds,
      season_number: episode.season_number,
      episode_number: episode.episode_number,
      medium: mediumFor(episode),
      media_url: enclosure?.url,
      mime_type: enclosure?.type,
    });
  }

  return defined({
    title: episode.title,
    guid: episode.guid,
    guid_is_permalink: episode.guid_is_permalink,
    enclosure_url: enclosure?.url,
    enclosure_type: enclosure?.type,
    enclosure_length: enclosure?.length,
    link: episode.link,
    description: episode.description,
    content_encoded: episode.content_encoded,
    pub_date: episode.pub_date,
    duration_raw: episode.duration_raw,
    duration_seconds: episode.duration_seconds,
    season_number: episode.season_number,
    episode_number: episode.episode_number,
    episode_type: episode.episode_type,
    explicit: episode.explicit,
    author: episode.author ?? show.author,
    image_url: episode.image_url ?? show.image_url,
    feed_url: feedUrl,
    podcast_guid: scopeKey,
  });
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export interface PodcastHandlerOptions {
  /** Injected so tests drive the upstream deterministically. */
  fetch?: typeof fetch;
  /**
   * Whether signed Podcast Index enrichment is available. Threaded from the
   * Worker entry because handlers receive a connection context, which
   * carries no environment.
   */
  podcastIndexAvailable?: boolean;
  /** Injected so a tick's clock is deterministic under test. */
  now?: () => number;
}

/** Errors reach here as unknown; only a string or an Error says anything useful. */
function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

async function reportFailure(
  ctx: ConnectionContext,
  summary: string,
  error: unknown,
  retry: boolean,
): Promise<HandlerResult> {
  const reason = error instanceof Error ? error.message : stringifyError(error);
  await ctx.activity.emit({
    severity: retry ? "warning" : "action_required",
    summary: `Podcasts: ${summary}`,
    detail: reason === "" ? undefined : { reason },
  });
  return {
    ok: false,
    retry,
    reason: `${summary}${reason === "" ? "" : `: ${reason}`}`,
  };
}

export function createScheduleHandler(
  opts: PodcastHandlerOptions = {},
): (
  ctx: ConnectionContext,
  message: { scheduled_for_ms: number },
) => Promise<HandlerResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const enrichment = opts.podcastIndexAvailable === true;
  const clock = opts.now ?? (() => Date.now());

  return async (ctx, message) => {
    const resolution = await resolveConfig(ctx);
    if (!resolution.ok) {
      // Deliberately not a fallback to "no feeds": see resolveConfig.
      return reportFailure(
        ctx,
        "connection configuration lookup failed",
        resolution.error,
        true,
      );
    }
    const { feed_urls: configured, write_family: family } = resolution.config;
    const startedAt = new Date(message.scheduled_for_ms).toISOString();

    if (configured.length === 0) {
      await ctx.cursor.write(INDEX_CURSOR_KEY, {
        feed_keys: [],
        next_feed_index: 0,
        last_run_at: startedAt,
      } satisfies IndexCursor);
      return { ok: true };
    }

    const overflow = configured.length > MAX_FEEDS_PER_CONNECTION;
    const active = overflow
      ? configured.slice(0, MAX_FEEDS_PER_CONNECTION)
      : configured;
    if (overflow) {
      // Reported rather than silently truncated: a subscription that is
      // simply never polled looks identical to one that is up to date.
      await ctx.activity.emit({
        severity: "action_required",
        summary: `Podcasts: more feeds configured than one connection polls`,
        detail: {
          configured: configured.length,
          polling: MAX_FEEDS_PER_CONNECTION,
          ignored: configured.length - MAX_FEEDS_PER_CONNECTION,
        },
      });
    }

    const index: IndexCursor = {
      feed_keys: [],
      next_feed_index: 0,
      last_run_at: null,
      ...(((await ctx.cursor.read(INDEX_CURSOR_KEY)) as IndexCursor | null) ??
        {}),
    };

    const keyed: { key: string; url: string }[] = [];
    for (const url of active) keyed.push({ key: await cursorKeyFor(url), url });
    const activeKeys = new Set(keyed.map((k) => k.key));

    // A feed that left the configuration is retired, not deleted. Deleting
    // its state means re-adding the address replays the entire back
    // catalogue, which against a production write path is hours of work to
    // arrive back where it started.
    for (const staleKey of index.feed_keys) {
      if (activeKeys.has(staleKey)) continue;
      const stale = (await ctx.cursor.read(staleKey)) as FeedCursor | null;
      if (stale !== null && stale.retired_at === null) {
        await ctx.cursor.write(staleKey, { ...stale, retired_at: startedAt });
        await ctx.activity.emit({
          severity: "info",
          summary: "Podcasts: feed removed from the subscription, state kept",
          detail: { feed_url: stale.feed_url },
        });
      }
    }

    const start = index.next_feed_index % keyed.length;
    const order = [...keyed.slice(start), ...keyed.slice(0, start)];

    // A feed already part-way through a drain is finished before an
    // untouched one is started, so backfills complete rather than leaving
    // every subscription half-imported.
    const parked: typeof order = [];
    const fresh: typeof order = [];
    for (const entry of order) {
      const c = (await ctx.cursor.read(entry.key)) as FeedCursor | null;
      (c?.backfill_cursor !== null && c?.backfill_cursor !== undefined
        ? parked
        : fresh
      ).push(entry);
    }
    const queue = [...parked, ...fresh];

    let episodeBudget = MAX_EPISODES_PER_TICK;
    let feedsTouched = 0;
    let advanced = 0;
    const totals = {
      fetched: 0,
      notModified: 0,
      written: 0,
      failed: 0,
      skipped: 0,
    };

    for (const entry of queue) {
      if (feedsTouched >= MAX_FEEDS_PER_TICK || episodeBudget <= 0) break;
      feedsTouched += 1;
      advanced += 1;

      const outcome = await sweepFeed({
        ctx,
        fetchImpl,
        clock,
        key: entry.key,
        feedUrl: entry.url,
        family,
        budget: episodeBudget,
        startedAt,
      });
      episodeBudget -= outcome.written + outcome.failed;
      totals.fetched += outcome.fetched;
      totals.notModified += outcome.notModified;
      totals.written += outcome.written;
      totals.failed += outcome.failed;
      totals.skipped += outcome.skipped;
    }

    await ctx.cursor.write(INDEX_CURSOR_KEY, {
      feed_keys: keyed.map((k) => k.key),
      next_feed_index: (start + advanced) % keyed.length,
      last_run_at: startedAt,
    } satisfies IndexCursor);

    await ctx.activity.emit({
      severity: totals.failed > 0 ? "warning" : "info",
      summary: `Podcasts: swept ${String(feedsTouched)} feed${feedsTouched === 1 ? "" : "s"}, wrote ${String(totals.written)} episode${totals.written === 1 ? "" : "s"}`,
      detail: {
        feeds_configured: configured.length,
        feeds_swept: feedsTouched,
        feeds_unchanged: totals.notModified,
        episodes_written: totals.written,
        episodes_failed: totals.failed,
        episodes_skipped: totals.skipped,
        write_family: family,
        podcast_index_enrichment: enrichment ? "available" : "not configured",
      },
    });

    return { ok: true };
  };
}

interface SweepOutcome {
  fetched: number;
  notModified: number;
  written: number;
  failed: number;
  skipped: number;
}

async function sweepFeed(args: {
  ctx: ConnectionContext;
  fetchImpl: typeof fetch;
  clock: () => number;
  key: string;
  feedUrl: string;
  family: WriteFamily;
  budget: number;
  startedAt: string;
}): Promise<SweepOutcome> {
  const { ctx, fetchImpl, key, feedUrl, family, budget, startedAt } = args;
  const out: SweepOutcome = {
    fetched: 0,
    notModified: 0,
    written: 0,
    failed: 0,
    skipped: 0,
  };

  const cursor: FeedCursor = {
    ...defaultFeedCursor(feedUrl),
    ...(((await ctx.cursor.read(key)) as FeedCursor | null) ?? {}),
    feed_url: feedUrl,
    retired_at: null,
  };

  // Ask whether anything changed before asking for the document. Every host
  // tested answered a conditional request with an empty body, which is the
  // difference between a few hundred bytes and eighteen megabytes.
  const headers: Record<string, string> = {
    Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    "User-Agent": "MarfaPodcasts/0.1",
  };
  if (cursor.etag !== null) headers["If-None-Match"] = cursor.etag;
  if (cursor.last_modified !== null)
    headers["If-Modified-Since"] = cursor.last_modified;

  let response: Response;
  try {
    response = await fetchImpl(feedUrl, { headers });
  } catch (error) {
    await ctx.activity.emit({
      severity: "warning",
      summary: "Podcasts: feed could not be fetched",
      detail: {
        feed_url: feedUrl,
        reason: stringifyError(error),
      },
    });
    return out;
  }

  if (response.status === 304) {
    out.notModified += 1;
    await ctx.cursor.write(key, { ...cursor, last_success_at: startedAt });
    return out;
  }

  if (!response.ok) {
    await ctx.activity.emit({
      severity: "warning",
      summary: `Podcasts: feed responded ${String(response.status)}`,
      detail: { feed_url: feedUrl, status: response.status },
    });
    return out;
  }

  const declaredLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "Podcasts: feed is larger than this will read",
      detail: {
        feed_url: feedUrl,
        bytes: declaredLength,
        limit: MAX_FEED_BYTES,
      },
    });
    return out;
  }

  const xml = await response.text();
  if (xml.length > MAX_FEED_BYTES) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "Podcasts: feed is larger than this will read",
      detail: { feed_url: feedUrl, bytes: xml.length, limit: MAX_FEED_BYTES },
    });
    return out;
  }

  out.fetched += 1;
  cursor.etag = response.headers.get("etag") ?? cursor.etag;
  cursor.last_modified =
    response.headers.get("last-modified") ?? cursor.last_modified;

  let feed: ParsedFeed;
  try {
    feed = parseFeed(xml);
  } catch (error) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "Podcasts: feed could not be parsed",
      detail: {
        feed_url: feedUrl,
        reason: stringifyError(error),
      },
    });
    return out;
  }
  out.skipped += feed.skipped_unidentifiable;

  // The show's identity is fixed the first time it is seen and never
  // recomputed. Recomputing would re-key every episode already stored the
  // moment a feed moved address, turning one subscription into two.
  cursor.show_scope_key ??= await showScopeKey(feedUrl, feed.show.podcast_guid);
  const scopeKey = cursor.show_scope_key;
  cursor.show_title = feed.show.title ?? cursor.show_title;

  // A feed naming its own replacement is an instruction from a document we
  // do not control, so it is surfaced for a person rather than followed.
  if (feed.show.new_feed_url !== null && feed.show.new_feed_url !== feedUrl) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: "Podcasts: this feed asks to be followed at a new address",
      detail: { feed_url: feedUrl, new_feed_url: feed.show.new_feed_url },
    });
  }

  // The show is written before its episodes, because the edge that joins
  // them needs its id and the id comes from the write.
  const showInput: CreateItemInput = {
    type: WRITE_FAMILIES[family].show,
    source_id: showSourceId(scopeKey),
    properties: showProperties(
      feed.show,
      feedUrl,
      scopeKey,
      family,
      feed.episodes.length,
    ),
  };
  let showItemId: string;
  try {
    const created = await ctx.marfa.createItem(showInput);
    showItemId = created.id;
  } catch (error) {
    await ctx.activity.emit({
      severity: "action_required",
      summary:
        "Podcasts: the show could not be written, so its episodes were left alone",
      detail: {
        feed_url: feedUrl,
        reason: stringifyError(error),
      },
    });
    return out;
  }
  cursor.show_item_id = showItemId;
  await ctx.cursor.write(key, cursor);

  // Oldest first, so the ring of remembered ids evicts chronologically and
  // the watermark only ever moves forward.
  const ordered = [...feed.episodes].reverse();
  const seen = new Set(cursor.recent_entry_ids);

  // The index space is every episode the feed carries, oldest first, and
  // never a filtered subset. `backfill_cursor` points into this list, so it
  // has to mean the same thing on the tick that resumes as on the tick that
  // parked. Filtering out already-seen episodes first would reshape the
  // list between ticks and send a resume past its own end.
  //
  // Episodes arrive at the end of an oldest-first list, so a show that
  // publishes mid-drain does not shift the positions already recorded.
  const candidates: { episode: ParsedEpisode; localId: string }[] = [];
  for (const episode of ordered) {
    const localId = await episodeLocalId(episode);
    if (localId === null) {
      out.skipped += 1;
      continue;
    }
    candidates.push({ episode, localId });
  }

  const resumeAt = Math.min(cursor.backfill_cursor ?? 0, candidates.length);
  const work: {
    episode: ParsedEpisode;
    input: CreateItemInput;
    index: number;
  }[] = [];
  for (let i = resumeAt; i < candidates.length; i += 1) {
    const entry = candidates[i];
    if (entry === undefined) continue;
    // The ring is a per-episode skip, not a reshaping of the index space.
    if (seen.has(entry.localId)) continue;
    work.push({
      episode: entry.episode,
      index: i,
      input: {
        type: WRITE_FAMILIES[family].episode,
        source_id: episodeSourceId(scopeKey, entry.localId),
        properties: episodeProperties(
          entry.episode,
          feed.show,
          feedUrl,
          scopeKey,
          family,
        ),
      },
    });
  }
  let parked = false;
  let processed = resumeAt;

  for (let i = 0; i < work.length; i += EPISODE_BATCH_SIZE) {
    if (out.written + out.failed >= budget) {
      parked = true;
      break;
    }
    const batch = work.slice(i, i + EPISODE_BATCH_SIZE);

    let results;
    try {
      results = await ctx.marfa.bulkUpsertItems(batch.map((b) => b.input));
    } catch (error) {
      // The batch did not land. The checkpoint below only runs on a batch
      // that applied, so the stored position still points here and the next
      // tick re-offers these rather than stepping over them.
      await ctx.activity.emit({
        severity: "warning",
        summary: "Podcasts: a batch of episodes could not be written",
        detail: {
          feed_url: feedUrl,
          reason: stringifyError(error),
        },
      });
      parked = true;
      break;
    }

    for (const result of results.results) {
      const entry = batch[result.index];
      if (entry === undefined) continue;
      if (result.outcome === "errored" || result.id === undefined) {
        out.failed += 1;
        cursor.failed_since_watermark += 1;
        await ctx.activity.emit({
          severity: "action_required",
          summary: "Podcasts: an episode was refused",
          detail: {
            feed_url: feedUrl,
            title: entry.episode.title,
            reason: result.error?.message ?? result.reason,
          },
        });
        continue;
      }

      // The edge is written once, on creation. An episode's membership in
      // its show never changes, and `ensureEdge` is idempotent, so there is
      // nothing to redo on an update.
      //
      // Never as an inline edge on the batch write: inline edges replace
      // rather than append, per edge type, so a sweep would silently delete
      // any collection a person had added this episode to.
      if (result.outcome === "created") {
        try {
          await ctx.marfa.ensureEdge({
            source_id: result.id,
            target_id: showItemId,
            edge_type: "in-collection",
          });
        } catch (error) {
          await ctx.activity.emit({
            severity: "action_required",
            summary:
              "Podcasts: an episode was written but not joined to its show",
            detail: {
              feed_url: feedUrl,
              episode_id: result.id,
              show_id: showItemId,
              reason: stringifyError(error),
            },
          });
        }
      }

      out.written += 1;
      const localId =
        entry.input.source_id?.slice(`ep:${scopeKey}:`.length) ?? "";
      if (localId !== "") {
        cursor.recent_entry_ids.push(localId);
        if (cursor.recent_entry_ids.length > RECENT_ID_RING_SIZE) {
          cursor.recent_entry_ids =
            cursor.recent_entry_ids.slice(-RECENT_ID_RING_SIZE);
        }
      }
    }

    // One past the last episode this batch applied, in the feed's own index
    // space. Everything up to here has landed, so it is recorded before
    // asking for more and a tick that dies next resumes from this point.
    processed = (batch[batch.length - 1]?.index ?? processed - 1) + 1;
    cursor.backfill_cursor = processed < candidates.length ? processed : null;
    await ctx.cursor.write(key, cursor);
  }

  if (parked) {
    cursor.backfill_cursor = processed;
    cursor.pass_started_at = cursor.pass_started_at ?? startedAt;
    await ctx.cursor.write(key, cursor);
    return out;
  }

  // The feed drained. The watermark moves only if nothing was refused, or
  // if a pass has already been retried once for the same refusals — held
  // forever, one bad episode would make every tick re-walk the catalogue.
  cursor.backfill_cursor = null;
  cursor.pass_started_at = null;
  cursor.last_success_at = startedAt;
  if (cursor.failed_since_watermark === 0 || cursor.retried_after_failure) {
    cursor.last_seen_published =
      ordered[ordered.length - 1]?.pub_date ?? cursor.last_seen_published;
    cursor.failed_since_watermark = 0;
    cursor.retried_after_failure = false;
  } else {
    cursor.failed_since_watermark = 0;
    cursor.retried_after_failure = true;
  }
  await ctx.cursor.write(key, cursor);
  return out;
}

export function registerHandlers(opts: PodcastHandlerOptions = {}): void {
  registerScheduleHandler(createScheduleHandler(opts));
}

/** Exposed for tests only. */
export const __internals = {
  cursorKeyFor,
  mediumFor,
  showProperties,
  episodeProperties,
  resolveConfig,
  STUCK_FEED_DAYS,
};
