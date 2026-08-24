/**
 * Podcasts — the scheduled sweep.
 *
 * One connection holds many subscriptions. Each tick takes a few feeds in
 * rotation, asks each whether it has changed, and writes what is new.
 *
 * Three properties are load-bearing and each cost something to get right.
 *
 * **A feed that has not changed costs one conditional request and one lookup.** Podcast feeds do not
 * paginate: one document carries every episode, and for a long-running
 * daily show that is close to eighteen megabytes. Re-reading thirty of
 * those every hour to discover that nothing happened would be most of the
 * work this integration ever does. Every host tested honors a conditional
 * request, so the steady state is a few hundred bytes of headers.
 *
 * **Progress is written after every batch, not at the end.** The previous
 * integration in this program lost a whole backfill to the opposite
 * choice: the cursor was written once after the loop, so every sweep that
 * ran out of time discarded everything it had done, and the import
 * reported itself complete having stored a quarter of the library. A tick
 * killed mid-drain here resumes at the next batch.
 *
 * **The watermark is stricter than progress.** It advances only when a feed
 * drains completely with every batch applied. Stepping over an episode the
 * server refused would strand it permanently, because nothing re-offers an
 * episode that has not changed, so the drain boundary stops at the last
 * episode that landed rather than at the end of the pass.
 */
import {
  registerScheduleHandler,
  type ConnectionContext,
  type CreateItemInput,
  type HandlerResult,
} from "@withmarfa/runtime-sdk";
import { MAX_FILTER_INPUT_LENGTH, resolveWriteFamily } from "@withmarfa/shared";
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
  FAMILY_DEFINITIONS,
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
  recent_entry_ids: string[];
  /** Index into this pass's episode list while a feed is parked mid-drain. */
  backfill_cursor: number | null;
  /**
   * The identity that stood at `backfill_cursor` when the pass parked.
   *
   * The index alone is not enough. It points into a list rebuilt from the
   * feed on every tick, and the reasoning written for it only covers
   * additions: episodes arrive at the end of an oldest-first list, so a
   * show publishing mid-drain shifts nothing already recorded. A show
   * *deleting* an old episode shifts every later index down, and a resume
   * at the stored number then steps over exactly as many episodes as were
   * removed. They were never written, so the ring does not hold them, and
   * the boundary recorded at the end of the pass puts them out of reach.
   *
   * That was unreachable while a parked drain never resumed against a
   * changed body, which is the defect this branch fixes, so it stops being
   * unreachable here. The anchor is what makes the index checkable: it has
   * to still be sitting at that index, or the position is re-derived.
   */
  backfill_anchor_id: string | null;
  /**
   * The earliest episode this pass refused, by identity, or null if it has
   * refused nothing yet.
   *
   * On the cursor rather than in a local, because a pass spans ticks and
   * this decides where the pass's drain boundary lands. A local forgot the
   * refusal the moment the budget ran out, so a feed one tick's budget too
   * long recorded its boundary at the end and stranded the episode: the
   * exact case the boundary exists for.
   *
   * By identity for the same reason `backfill_anchor_id` exists. An index
   * recorded on one tick and read on another is an index into two
   * different lists, and a publisher removing an old episode shifts every
   * later one down. Read positionally, the boundary would land *on* the
   * refused episode rather than before it, which strands it in exactly the
   * way this field is here to prevent.
   */
  pass_first_refused_id: string | null;
  /**
   * Whether this pass saw episodes appear below the position it parked at.
   *
   * The drain follows its anchor rather than restarting, because
   * restarting need never converge, so the inserted episodes are behind it
   * by the time the pass finishes. Recording a boundary at the end would
   * put them permanently out of reach, so the pass declines to record one
   * and the next pass walks the feed once. That is the same one-pass cost
   * a drained feed already pays for an insertion.
   */
  pass_saw_insertion: boolean;
  /**
   * Identity of the newest episode a completed drain reached, and how many
   * episodes stood at or before it.
   *
   * `recent_entry_ids` is a bounded ring, so on a feed longer than the ring
   * it cannot answer "have I imported this" for the whole catalog. Without
   * these two, a drained feed is walked from the beginning on every tick
   * and everything older than the ring is offered again, forever: a settled
   * subscription rewriting hundreds of rows an hour and reporting them as
   * work. Measured on a six-hundred-episode feed against a three-hundred
   * entry ring, it oscillates between the two halves and never settles.
   *
   * The identity is what makes the pair shift-proof: finding it in this
   * pass's list says where the drained region ends wherever it now sits.
   * The count is how a drop is told from an insertion, which need opposite
   * answers. `resumeAfterDrain` carries the reasoning.
   */
  drained_through_id: string | null;
  drained_count: number | null;
  /**
   * The scheduled time of the last tick that wrote an episode, while a
   * pass is open.
   *
   * Its one reader is the stuck ceiling, which is documented as a pass
   * open this long *without progress*. Stamped when the pass began instead
   * of when it last moved, it measures the pass rather than the stall, so
   * a catalog too large to finish inside the ceiling trips on its own
   * size.
   */
  last_progress_at: string | null;
  failed_since_watermark: number;
  retried_after_failure: boolean;
  /**
   * Episodes written but not yet joined to their show.
   *
   * The join used to be attempted once, on the tick that created the
   * episode, and a failure only produced an activity row. The episode was
   * still counted as written and still entered `recent_entry_ids`, so it
   * was never offered again and the edge could never form: one transient
   * refusal orphaned a member permanently. Ids park here instead and are
   * drained on the next tick.
   */
  pending_joins: string[];
  /**
   * When this feed last reported that its checkpoint and the space disagree.
   *
   * Cleared when an episode lands and when the feed is retired, so a
   * recurrence after a real change reports again rather than being
   * suppressed forever. A show write or a repaired join does not clear it:
   * neither changes whether the episodes exist.
   *
   * Removing a feed and adding it back is not a reset. Retirement only
   * happens on a tick that observes the address gone, so doing both inside
   * the hour clears nothing.
   */
  stale_checkpoint_reported_at: string | null;
  /**
   * When this feed last reported that the check itself could not run.
   *
   * Separate from the marker above on purpose. Sharing one meant a single
   * transient lookup failure suppressed the finding for the life of the
   * cursor, and on a feed that is genuinely stuck nothing ever clears it,
   * because the thing that clears it is an episode landing.
   *
   * Cleared by the next lookup that succeeds, in memory, and persisted with
   * whatever the sweep writes afterwards. A sweep that returns early enough
   * to write nothing at all, which means a feed that is also failing to
   * fetch or parse, keeps the stored marker until one gets further.
   */
  checkpoint_lookup_failed_at: string | null;
  /**
   * When this feed last reported that a single import has been open too
   * long.
   *
   * Its own marker rather than a shared one, for the reason the other two
   * are separate: a stuck import and a checkpoint pointing at rows that
   * are gone are different findings, and suppressing one with the other
   * hides whichever arrives second.
   */
  stuck_pass_reported_at: string | null;
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
    recent_entry_ids: [],
    backfill_cursor: null,
    backfill_anchor_id: null,
    pass_first_refused_id: null,
    pass_saw_insertion: false,
    drained_through_id: null,
    drained_count: null,
    last_progress_at: null,
    failed_since_watermark: 0,
    retried_after_failure: false,
    pending_joins: [],
    stale_checkpoint_reported_at: null,
    checkpoint_lookup_failed_at: null,
    stuck_pass_reported_at: null,
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
      // Retire what was there before dropping the index. Returning early
      // left every cursor un-retired and orphaned from an index that no
      // longer named it, so removing every feed and adding them back gave
      // a full ring with its report marker intact and the detector silent.
      // That is the most natural way somebody tries to reset a connection.
      const previous =
        ((await ctx.cursor.read(INDEX_CURSOR_KEY)) as IndexCursor | null)
          ?.feed_keys ?? [];
      await retireFeeds(ctx, previous, new Set(), startedAt);
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
    // catalog, which against a production write path is hours of work to
    // arrive back where it started.
    await retireFeeds(ctx, index.feed_keys, activeKeys, startedAt);

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

/**
 * Retire the cursors whose feeds left the configuration.
 *
 * Retired, not deleted: deleting the state means re-adding the address
 * replays the entire back catalog, which against a production write path
 * is hours of work to arrive back where it started.
 *
 * The report markers go with it. Carrying one across a retirement would
 * leave the ring full and the detector silent on a feed somebody had just
 * acted on.
 *
 * This is not a reliable way to reset a feed, and the report deliberately
 * does not suggest it. Retirement only happens on a tick that observes the
 * address gone, so removing a feed and adding it back inside the hour is
 * invisible: nothing is retired, nothing is cleared, and the ring is exactly
 * as it was. The remedy the report names is reinstalling the connection,
 * which drops the whole runtime extension the cursors live in.
 */
async function retireFeeds(
  ctx: ConnectionContext,
  known: string[],
  activeKeys: Set<string>,
  startedAt: string,
): Promise<void> {
  for (const staleKey of known) {
    if (activeKeys.has(staleKey)) continue;
    const stale = (await ctx.cursor.read(staleKey)) as FeedCursor | null;
    if (stale?.retired_at !== null) continue;
    await ctx.cursor.write(staleKey, {
      ...stale,
      retired_at: startedAt,
      stale_checkpoint_reported_at: null,
      checkpoint_lookup_failed_at: null,
      stuck_pass_reported_at: null,
      // The progress stamp goes too. State is kept, so a re-added feed
      // resumes its parked pass, and a stamp that counted the period the
      // feed was not being swept would call it stuck on its first tick
      // back and send it straight into a 304.
      last_progress_at: null,
    });
    await ctx.activity.emit({
      severity: "info",
      summary: "Podcasts: feed removed from the subscription, state kept",
      detail: { feed_url: stale.feed_url },
    });
  }
}

/**
 * Say so when the ring remembers episodes the space does not hold.
 *
 * The ring remembers an episode by identity and the sweep skips anything it
 * remembers, so a ring that is full while the show holds nothing produces a
 * run that writes nothing and reports success. From outside that is
 * identical to a feed with nothing new. One connection swept hourly for
 * three days that way, and the only reason it was noticed is that somebody
 * compared two instances by hand.
 *
 * **Before the conditional request, not after.** A feed that serves an ETag
 * answers 304 and the sweep returns long before it looks at any episode, so
 * a check further down would never run for exactly the connections most
 * likely to be stuck. This needs nothing from the feed: the contradiction is
 * between the ring and the space.
 *
 * **It reports and does not repair.** Clearing the ring would re-offer
 * everything, which is right when the rows were lost and wrong when they
 * were deliberately deleted, and nothing here can tell those apart: trashed
 * rows are purged when their retention expires, at which point deletion and
 * loss look identical.
 *
 * **It looks under both write families.** The ring does not record which
 * family wrote an entry, and the family is configurable per connection, so
 * a connection switched from one to the other has its episodes under the
 * other family's type. Checking only the current one would tell somebody to
 * reinstall a connection whose rows are sitting right there.
 *
 * **It reports once**, until an episode lands or a feed is retired, because
 * a row every hour saying the same thing is the habit that makes activity
 * unreadable.
 *
 * **What it does not catch**, deliberately, is partial loss. One surviving
 * episode makes the check quiet, so a show missing three hundred of three
 * hundred and one is invisible to it. Detecting that means reconciling the
 * ring against the space entry by entry, which is a different and much more
 * expensive thing than asking whether anything is there at all.
 */

async function reportStaleCheckpoint(args: {
  ctx: ConnectionContext;
  cursor: FeedCursor;
  key: string;
  family: WriteFamily;
  feedUrl: string;
}): Promise<void> {
  const { ctx, cursor, key, family, feedUrl } = args;
  const scopeKey = cursor.show_scope_key;
  if (scopeKey === null) return;
  if (cursor.recent_entry_ids.length === 0) return;
  if (cursor.stale_checkpoint_reported_at !== null) return;

  const prefix = episodeSourceId(scopeKey, "");
  const filter = filterForPrefix(prefix);
  if (filter === null) {
    await reportOnce(ctx, cursor, key, "checkpoint_lookup_failed_at", {
      severity: "warning",
      summary:
        "Podcasts: cannot check this feed's episodes, its identifier is too long to ask about",
      detail: { feed_url: feedUrl },
    });
    return;
  }

  // Both families, and every state. The ring does not record which family
  // wrote an entry and the family is configurable, so a connection that
  // switched has its episodes under the other type. Somebody who trashed or
  // archived a show's episodes still has them.
  //
  // The connection's own family first, so a healthy connection stops on its
  // first lookup whichever family it is on, rather than only when it happens
  // to be the one declared first.
  const own = FAMILY_DEFINITIONS[family].types.episode;
  const types = new Set([
    own,
    ...Object.values(FAMILY_DEFINITIONS).map((f) => f.types.episode),
  ]);
  const states = ["active", "archived", "trashed"] as const;
  for (const type of types) {
    for (const state of states) {
      let page;
      try {
        page = await ctx.marfa.listItems({ type, filter, state, limit: 1 });
      } catch (error) {
        // Not evidence of anything, and not silent either: a lookup that
        // keeps failing leaves the only detector for this class switched
        // off. On its own marker, so one transient failure cannot suppress
        // the finding for the life of the cursor.
        await reportOnce(ctx, cursor, key, "checkpoint_lookup_failed_at", {
          severity: "warning",
          summary: "Podcasts: could not check whether a feed's episodes exist",
          detail: { feed_url: feedUrl, reason: stringifyError(error) },
        });
        return;
      }
      if (page.data.length > 0) {
        cursor.checkpoint_lookup_failed_at = null;
        return;
      }
    }
  }
  cursor.checkpoint_lookup_failed_at = null;

  await reportOnce(ctx, cursor, key, "stale_checkpoint_reported_at", {
    severity: "action_required",
    // Precise about what stops: a newly published episode is not in the ring
    // and imports normally. What will not come back is the back catalog.
    summary:
      "Podcasts: this feed's checkpoint remembers episodes the space no longer has, so its back catalog will not be re-imported",
    detail: {
      feed_url: feedUrl,
      show_id: cursor.show_item_id,
      remembered: cursor.recent_entry_ids.length,
      remedy: "reinstall the connection to re-import the feed",
    },
  });
}

/**
 * Emit and mark, at most once per marker until something clears it.
 *
 * Two markers rather than one. Sharing a marker between the finding and the
 * lookup failure meant a single transient error suppressed the finding for
 * the life of the cursor, and on a feed that is genuinely stuck nothing ever
 * clears it, because the thing that clears it is an episode landing.
 *
 * Emit before marking. A mark that lands without its row would suppress a
 * report nobody ever saw.
 */
async function reportOnce(
  ctx: ConnectionContext,
  cursor: FeedCursor,
  key: string,
  marker:
    | "stale_checkpoint_reported_at"
    | "checkpoint_lookup_failed_at"
    | "stuck_pass_reported_at",
  activity: {
    severity: "warning" | "action_required";
    summary: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  if (cursor[marker] !== null) return;
  await ctx.activity.emit(activity);
  cursor[marker] = new Date().toISOString();
  await ctx.cursor.write(key, cursor);
}

/**
 * The filter expression for a `source_id` prefix, or null when the value
 * cannot be written as one.
 *
 * The grammar quotes strings and recognizes exactly one escape, a backslash
 * before a double quote, so escaping quotes round-trips every value,
 * backslashes included. The one shape it cannot express is a value ending in
 * a backslash, which would consume the closing quote, and that is
 * unreachable here because the prefix always ends in a colon.
 *
 * What is reachable is length. The grammar caps its input, and a declared
 * show identifier comes from third-party XML, so a long enough one would
 * throw on every tick forever. Refused here instead.
 */
function filterForPrefix(prefix: string): string | null {
  const expression = `source_id starts_with "${prefix.replace(/"/g, '\\"')}"`;
  return expression.length > MAX_FILTER_INPUT_LENGTH ? null : expression;
}

async function sweepFeed(args: {
  ctx: ConnectionContext;
  fetchImpl: typeof fetch;
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

  try {
    await reportStaleCheckpoint({ ctx, cursor, key, family, feedUrl });
  } catch {
    // This runs before the fetch, before the index that rotates feeds is
    // advanced. A throw here would leave the same feed at the head of the
    // rotation and stop every other feed on the connection from ever being
    // swept, which is a far worse failure than the one it detects.
  }

  // Ask whether anything changed before asking for the document. Every host
  // tested answered a conditional request with an empty body, which is the
  // difference between a few hundred bytes and eighteen megabytes.
  const headers: Record<string, string> = {
    Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    "User-Agent": "MarfaPodcasts/0.1",
  };
  // Revalidators are sent unless a drain is parked and still moving.
  //
  // A drain that ran out of budget parks mid-feed and persists the new
  // revalidator on its way out, so the next tick asks the question the
  // conditional request answers, "has this changed since I last read it",
  // and gets "no" for a feed it has read half of. The 304 returns before
  // anything looks at the parked position, and the drain never continues:
  // every host tested honors `If-None-Match`, so on a real feed longer
  // than one tick's budget the import simply stopped at one tick's worth
  // and waited for the publisher to release something.
  //
  // Asking unconditionally costs one full body per tick, which is what the
  // budget was already spending it on, and would be bounded by the drain
  // if every parked drain finished. Several do not: a fetch that throws, a
  // non-2xx, a body over the size ceiling, a parse failure, a show write
  // that fails, or a batch that fails the same way every time all leave
  // the position stored and return. On a seventeen-megabyte feed that is
  // the whole body pulled from somebody else's CDN every hour for as long
  // as the condition lasts.
  //
  // So the progress stamp and `STUCK_FEED_DAYS` finally have the read
  // side they were written for. A pass that has been open longer than the
  // ceiling stops being treated as in progress: the feed goes back to
  // asking conditionally and says once that it is stuck. It stays parked,
  // so nothing is lost, and it resumes the moment the feed changes.
  // `last_progress_at` moves forward on any tick that writes, so this is
  // time without progress rather than time since the pass began. A long
  // import that is converging never trips it; one that cannot finish does.
  //
  // Measured against the tick's own scheduled time, which is what stamps
  // the marker. Comparing a wall clock against a scheduled stamp mixes two
  // time sources and the difference between them is not a duration.
  const lastProgress = cursor.last_progress_at;
  const stuck =
    lastProgress !== null &&
    Date.parse(startedAt) - Date.parse(lastProgress) >
      STUCK_FEED_DAYS * 24 * 3_600_000;
  if (cursor.backfill_cursor === null || stuck) {
    if (cursor.etag !== null) headers["If-None-Match"] = cursor.etag;
    if (cursor.last_modified !== null)
      headers["If-Modified-Since"] = cursor.last_modified;
  }
  if (stuck) {
    // A warning rather than an action: the feed resumes on its own the
    // moment the publisher releases something, so there is nothing for a
    // person to do beyond knowing the import is not finished. An
    // action_required row nobody can act on is the habit that makes the
    // activity log unreadable.
    await reportOnce(ctx, cursor, key, "stuck_pass_reported_at", {
      severity: "warning",
      summary:
        "Podcasts: this feed has been part-way through an import for longer than it should be",
      detail: {
        feed_url: feedUrl,
        last_progress_at: lastProgress,
        stopped_at_position: cursor.backfill_cursor,
      },
    });
  }

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
    type: FAMILY_DEFINITIONS[family].types.show,
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

  // Drain joins parked by an earlier tick, before this pass adds any of its
  // own. An episode whose join failed is already remembered, so the sweep
  // will never offer it again — this list is the only thing that brings it
  // back. Anything that fails again stays parked and is tried next tick.
  if (cursor.pending_joins.length > 0) {
    const stillPending: string[] = [];
    let repaired = 0;
    for (const episodeId of cursor.pending_joins) {
      try {
        await ctx.marfa.ensureEdge({
          source_id: episodeId,
          target_id: showItemId,
          edge_type: "in-collection",
        });
        repaired += 1;
      } catch {
        stillPending.push(episodeId);
      }
    }
    cursor.pending_joins = stillPending;
    await ctx.cursor.write(key, cursor);
    // Reported once per drain rather than once per episode, and only when
    // something is still outstanding after the attempt — a join that
    // repaired itself is not a person's problem.
    if (stillPending.length > 0) {
      await ctx.activity.emit({
        severity: "action_required",
        summary: `Podcasts: ${String(stillPending.length)} episode(s) still not joined to their show`,
        detail: {
          feed_url: feedUrl,
          show_id: showItemId,
          repaired,
          outstanding: stillPending.length,
        },
      });
    }
  }

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

  const resume = resumeParkedPass(cursor, candidates);
  if (resume.insertedBelow) cursor.pass_saw_insertion = true;
  const resumeAt = Math.min(
    resume.at ?? resumeAfterDrain(cursor, candidates),
    candidates.length,
  );
  const work: {
    episode: ParsedEpisode;
    input: CreateItemInput;
    index: number;
    localId: string;
  }[] = [];
  for (let i = resumeAt; i < candidates.length; i += 1) {
    const entry = candidates[i];
    if (entry === undefined) continue;
    // The ring is a per-episode skip, not a reshaping of the index space.
    if (seen.has(entry.localId)) continue;
    work.push({
      episode: entry.episode,
      index: i,
      localId: entry.localId,
      input: {
        type: FAMILY_DEFINITIONS[family].types.episode,
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
        // Where the drained region has to stop. Everything before the
        // first refusal landed and never needs offering again; the refusal
        // and everything after it does. On the cursor because a pass spans
        // ticks and this outlives the one that saw it, and by identity
        // because the index it sits at is only meaningful in this tick's
        // list.
        const alreadyAt = indexOfId(candidates, cursor.pass_first_refused_id);
        if (alreadyAt === null || entry.index < alreadyAt) {
          cursor.pass_first_refused_id = entry.localId;
        }
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

      // Ensured on every applied episode rather than only on the tick that
      // created it. `ensureEdge` is idempotent, so re-ensuring an existing
      // edge costs one request and returns "exists" — and gating on
      // creation meant an episode whose join failed could never get one,
      // because it was already remembered and never offered again.
      //
      // Never as an inline edge on the batch write: inline edges replace
      // rather than append, per edge type, so a sweep would silently delete
      // any collection a person had added this episode to.
      try {
        await ctx.marfa.ensureEdge({
          source_id: result.id,
          target_id: showItemId,
          edge_type: "in-collection",
        });
      } catch {
        // Parked, not reported. A failure here is retried on the next tick
        // and only becomes a person's problem if it keeps failing, which
        // the drain reports. Emitting per failure produced one activity row
        // per orphan and no repair.
        if (!cursor.pending_joins.includes(result.id)) {
          cursor.pending_joins.push(result.id);
        }
      }

      out.written += 1;
      // An episode landing means whatever the checkpoint report saw has
      // changed, so a later recurrence is a new fact and reports again.
      // The stuck report clears on the same evidence: a pass that stalls,
      // moves, and stalls again has stalled twice.
      cursor.stale_checkpoint_reported_at = null;
      cursor.stuck_pass_reported_at = null;
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
    const more = processed < candidates.length;
    cursor.backfill_cursor = more ? processed : null;
    // The anchor and the progress stamp move with the position, not only
    // at the park below. This checkpoint exists so a tick that dies next
    // resumes from here, and resuming from an index whose anchor belongs
    // to an earlier position is the shift hazard the anchor is for. The
    // stamp matters for the same reason: a pass whose only tick died here
    // left it null, so the ceiling that bounds unconditional fetching
    // could never evaluate.
    //
    // Not covered by a test. Reaching this state needs a tick that dies
    // after a checkpoint and before the park block, which means an
    // exception escaping the sweep rather than the ordinary parking paths,
    // and the harness drives the parking paths. Said here rather than
    // covered by a case that looks like one and is not.
    cursor.backfill_anchor_id = more
      ? (candidates[processed]?.localId ?? null)
      : null;
    if (out.written > 0) cursor.last_progress_at = startedAt;
    await ctx.cursor.write(key, cursor);
  }

  if (parked) {
    cursor.backfill_cursor = processed;
    cursor.backfill_anchor_id = candidates[processed]?.localId ?? null;
    // Stamped when the pass began, and moved forward by any tick that
    // wrote something. The ceiling it feeds is documented as a pass open
    // this long *without progress*, and a stamp that never moves measures
    // the wrong thing: a legitimately long import trips it, and a feed
    // that recovers and parks again is still measured from the beginning.
    cursor.last_progress_at =
      out.written > 0 ? startedAt : (cursor.last_progress_at ?? startedAt);
    await ctx.cursor.write(key, cursor);
    return out;
  }

  // The feed drained. The watermark moves only if nothing was refused, or
  // if a pass has already been retried once for the same refusals: held
  // forever, one bad episode would make every tick re-walk the catalog.
  cursor.backfill_cursor = null;
  cursor.backfill_anchor_id = null;
  cursor.last_progress_at = null;
  cursor.stuck_pass_reported_at = null;
  cursor.last_success_at = startedAt;
  // The drain boundary stops at the last episode that actually landed,
  // which is one before the first refusal of this pass and the end of the
  // list when there was none.
  //
  // Not the same condition as the watermark above. That one releases after
  // a single retry so one permanently bad episode cannot make every tick
  // re-walk the catalog; releasing the boundary on the same terms would
  // record it past the refusal, and nothing re-offers an episode that has
  // not changed, so the episode would be stranded silently and the retry
  // would run with no work in it.
  //
  // What that trade costs, stated rather than implied: an episode that is
  // refused every time is re-offered every tick, along with everything
  // between it and the ring, and it emits its own activity row each time.
  // That is loud rather than unbounded, and loud is the side to err on
  // when the alternative is losing an episode in silence.
  //
  // A feed that parsed to nothing, or one whose very first episode was
  // refused, leaves the boundary alone rather than clearing it. A
  // momentarily empty channel is a transient, and treating it as a
  // completed drain of zero would full-walk a whole catalog on the next
  // good tick.
  // Re-derived in this tick's own list. Gone from the feed entirely means
  // the publisher withdrew the episode that was being refused, which is
  // the one way a refusal stops mattering.
  const refusedAt = indexOfId(candidates, cursor.pass_first_refused_id);
  const firstRefused = refusedAt ?? Number.POSITIVE_INFINITY;
  const boundaryIndex = Math.min(firstRefused - 1, candidates.length - 1);
  const boundary = boundaryIndex >= 0 ? candidates[boundaryIndex] : undefined;
  if (cursor.pass_saw_insertion) {
    // The list shifted under this pass in a way that can hide work, and it
    // carried on rather than restarting, so anything hidden is behind the
    // boundary it would otherwise record. Record none: the next pass walks
    // the feed and picks it up.
    //
    // This runs ahead of the empty-parse guard below and clears the stored
    // boundary rather than leaving it. That is the same answer either way,
    // since owing a walk and having no boundary are the same instruction.
    cursor.drained_through_id = null;
    cursor.drained_count = null;
  } else if (boundary !== undefined) {
    cursor.drained_through_id = boundary.localId;
    cursor.drained_count = boundaryIndex + 1;
  }
  cursor.pass_first_refused_id = null;
  cursor.pass_saw_insertion = false;
  if (cursor.failed_since_watermark === 0 || cursor.retried_after_failure) {
    cursor.failed_since_watermark = 0;
    cursor.retried_after_failure = false;
  } else {
    cursor.failed_since_watermark = 0;
    cursor.retried_after_failure = true;
  }
  await ctx.cursor.write(key, cursor);
  return out;
}

/** The index an identity now sits at in this tick's list, or null. */
function indexOfId(
  candidates: { localId: string }[],
  id: string | null,
): number | null {
  if (id === null) return null;
  const at = candidates.findIndex((c) => c.localId === id);
  return at === -1 ? null : at;
}

/**
 * Where to resume a pass that parked, or nothing if it did not park, and
 * whether the pass owes a full walk once it completes.
 *
 * `backfill_cursor` is an index into a list rebuilt from the feed on every
 * tick, so it is only meaningful while the list has not shifted under it.
 * A removal shifts it: a show deleting one old episode moves every later
 * index down by one, and resuming at the stored number steps over exactly
 * that many episodes, which were never written, are not in the ring, and
 * end up behind the boundary the pass records at the end. A back-catalog
 * upload shifts it the other way, because an oldest-first list puts new
 * old episodes at the front.
 *
 * So the position travels with the identity that stood at it. Found where
 * it was, or found earlier, the resume point is wherever it now is and
 * nothing is owed. Found later or not at all, the list moved in a way that
 * can hide work: the pass resumes from the best position it has and owes
 * one full walk, which the pass after it performs. The reasoning for
 * carrying on rather than restarting is at the branch itself.
 */
function resumeParkedPass(
  cursor: FeedCursor,
  candidates: { localId: string }[],
): { at: number | null; insertedBelow: boolean } {
  const parkedAt = cursor.backfill_cursor;
  if (parkedAt === null) return { at: null, insertedBelow: false };
  const anchor = cursor.backfill_anchor_id;
  // A parked position with no anchor is a cursor written before the anchor
  // existed. The current code writes the pair together, so this is
  // tolerance for the deploy that introduces the field and nothing else:
  // one tick of the old positional behavior, then the park below records
  // an anchor.
  if (anchor === null) return { at: parkedAt, insertedBelow: false };
  if (candidates[parkedAt]?.localId === anchor)
    return { at: parkedAt, insertedBelow: false };
  const moved = indexOfId(candidates, anchor);

  // Moved down means episodes were removed before it, and everything up
  // to it was still drained, so its new position is the resume point and
  // nothing is owed.
  if (moved !== null && moved <= parkedAt) {
    return { at: moved, insertedBelow: false };
  }

  // Everything else is the same shape: the list moved under the position
  // in a way that can hide work, and the pass carries on regardless.
  //
  // Moved up means episodes were inserted below it, which is a show
  // uploading its back catalog mid-drain. Gone entirely means the feed
  // re-identified the episode the pass was standing on, which a guid-less
  // feed does when a publisher retitles or re-hosts an old item.
  //
  // Neither restarts the drain, because restarting does not converge: the
  // condition that moved the anchor is usually still there on the next
  // tick, so the pass never completes, `backfill_cursor` never returns to
  // null, and the unconditional full-body fetch a parked pass performs
  // never stops. That is the two-halves oscillation this whole change
  // exists to remove, reached through a different door.
  //
  // Instead the pass finishes from the best position it has, and owes one
  // full walk afterwards: `insertedBelow` makes the completion decline to
  // record a boundary, so the next pass walks the feed and picks up
  // anything this one stepped over. Bounded, because a pass that owes a
  // walk still completes.
  return {
    at: moved ?? Math.min(parkedAt, candidates.length),
    insertedBelow: true,
  };
}

/**
 * Where to start on a feed that has already drained once.
 *
 * The pair recorded at the end of a drain says which episode the drained
 * region ends at and how many stood at or before it. Locating that episode
 * by identity in this pass's list is what makes the answer survive a feed
 * that has changed since: everything up to and including that identity is
 * already imported, wherever it now sits.
 *
 * **A shorter run before the boundary is a drop, and a longer one is an
 * insertion.** They need opposite answers and the distinction is the
 * direction of the comparison, not the fact of a difference. A rolling
 * window drops its oldest as it publishes, so its run before the boundary
 * shrinks on every tick while nothing behind it is new; treating that as a
 * change would full-walk on every tick forever, which is the defect this
 * exists to fix, on the one feed shape most likely to be long. A show
 * uploading its back catalog lengthens that run instead, and resuming past
 * the boundary would skip exactly those, so that one takes the full walk.
 *
 * A boundary that is absent means the feed re-identified its episodes and
 * there is nothing left to anchor to, which is the full walk as well.
 *
 * **What this cannot see** is an insertion behind the boundary that
 * arrives with at least as many removals behind it, because the run's
 * length is the only evidence of one and removals cancel it out. A
 * substitution is the same shape with a length change of zero: an episode
 * before the boundary whose identity changes, which a guid-less feed
 * produces when a publisher re-hosts or retitles an old item. Both are
 * skipped rather than re-imported.
 *
 * Distinguishing them needs the whole drained set rather than its boundary
 * and length, which is the unbounded thing the ring exists to avoid. The
 * ring still catches either near the tail, where a publisher is most
 * likely to be editing.
 *
 * A full walk is noisy on a long feed, not wrong: every write is an upsert
 * keyed on the episode's own identity, and the walk records a fresh
 * boundary at the end of it, so the noise is one pass rather than every
 * pass.
 */
function resumeAfterDrain(
  cursor: FeedCursor,
  candidates: { localId: string }[],
): number {
  const boundary = cursor.drained_through_id;
  if (boundary === null || cursor.drained_count === null) return 0;
  const at = candidates.findIndex((c) => c.localId === boundary);
  if (at === -1) return 0;
  if (at + 1 > cursor.drained_count) return 0;
  return at + 1;
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
