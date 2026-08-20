/**
 * RSS Watcher handlers.
 *
 * Single trigger: schedule. Each tick:
 *   1. Resolve the feed URL from the connection's
 *      `properties.configuration.feed_url` (falls back to the
 *      compiled-in default if absent). Re-read every tick, so a
 *      reconfigured connection switches feeds; when the URL changes,
 *      the dedupe state is reset alongside it.
 *   2. Fetch and parse the feed (Atom 1.0 or RSS 2.0).
 *   3. Filter entries already seen — by id (recent-id ring) or by
 *      `updated` timestamp (cursor). Cap the recent-id ring at
 *      RECENT_ID_RING_SIZE so storage stays bounded.
 *   4. Create one `core.bookmark` per new entry.
 *   5. Update the cursor and emit a `system.activity` with counts.
 *
 * Test injection: `createScheduleHandler({ fetch })` lets tests
 * pass a stub fetch without touching globalThis. The default
 * Worker entry calls `registerHandlers()` with no overrides.
 */
import {
  registerScheduleHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type HandlerResult,
  type CreateItemInput,
  type ItemResource,
} from "@withmarfa/runtime-sdk";
import { parseFeed, type FeedEntry } from "./feed-parser.js";

export const DEFAULT_FEED_URL = "https://simonwillison.net/atom/everything/";
export const RECENT_ID_RING_SIZE = 200;
const CURSOR_KEY = "main";

interface RssCursor {
  /** Feed URL this cursor's dedupe state belongs to. Compared against
   *  the configured URL every tick; a mismatch means the connection was
   *  pointed at a different feed and the state below no longer applies. */
  feed_url: string;
  /** ISO timestamp of the most recently seen entry's `updated` field. */
  last_seen_updated: string | null;
  /** Bounded ring of recently-seen entry ids (newest at end). */
  recent_entry_ids: string[];
  /** ISO timestamp of the last successful tick. */
  last_run_at: string;
}

export interface RssHandlerOptions {
  /** Override fetch — tests pass a deterministic stub. Defaults to
   *  globalThis.fetch. */
  fetch?: typeof fetch;
}

export function createScheduleHandler(
  opts: RssHandlerOptions = {},
): (
  ctx: ConnectionContext,
  message: ScheduleMessage,
) => Promise<HandlerResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);

  return async (ctx, message) => {
    const resolution = await resolveFeedUrl(ctx);
    if (!resolution.ok) {
      return reportFailure(
        ctx,
        "connection configuration lookup failed",
        resolution.error,
      );
    }
    const feedUrl = resolution.url;

    let cursor = (await ctx.cursor.read(CURSOR_KEY)) as RssCursor | null;
    if (cursor === null) {
      cursor = {
        feed_url: feedUrl,
        last_seen_updated: null,
        recent_entry_ids: [],
        last_run_at: new Date(message.scheduled_for_ms).toISOString(),
      };
    } else if (cursor.feed_url !== feedUrl) {
      // The connection now names a different feed. Entry ids and the
      // `updated` watermark describe the old one, so carrying them over
      // would silently suppress the new feed's back catalog — every
      // entry older than the previous feed's high-water mark would be
      // filtered out and never appear. Reset the dedupe state with the
      // URL, and leave a trail so the switch isn't invisible.
      await ctx.activity.emit({
        severity: "info",
        summary: "RSS Watcher: configured feed URL changed, dedupe state reset",
        detail: { previous_feed_url: cursor.feed_url, feed_url: feedUrl },
      });
      cursor = {
        feed_url: feedUrl,
        last_seen_updated: null,
        recent_entry_ids: [],
        last_run_at: cursor.last_run_at,
      };
    }

    let response: Response;
    try {
      response = await fetchImpl(feedUrl, {
        headers: {
          Accept:
            "application/atom+xml, application/rss+xml, application/xml, text/xml",
        },
      });
    } catch (err) {
      return reportFailure(ctx, "fetch failed", err);
    }
    if (!response.ok) {
      return reportFailure(
        ctx,
        `feed responded ${String(response.status)} ${response.statusText}`,
        null,
      );
    }
    const xml = await response.text();
    let parsed: ReturnType<typeof parseFeed>;
    try {
      parsed = parseFeed(xml);
    } catch (err) {
      return reportFailure(ctx, "feed parse failed", err);
    }

    const newEntries = filterNewEntries(parsed.entries, cursor);
    const created: ItemResource[] = [];
    for (const entry of newEntries) {
      try {
        // The user's mapping routes on the parsed entry itself — the
        // upstream-faithful record — so a rule can condition on any feed
        // field. Family fallthrough is the bookmark shape below; a skip
        // still counts as seen, or the entry would be re-offered forever.
        const routed = await ctx.mapping.resolve(entry);
        if (routed.kind === "skip") {
          recordSeen(cursor, entry);
          continue;
        }
        const input =
          routed.kind === "user"
            ? { ...routed.input, source_id: entry.id }
            : buildBookmarkInput(entry, parsed);
        const item = await ctx.marfa.createItem(input);
        created.push(item);
        recordSeen(cursor, entry);
      } catch (err) {
        // One bad entry shouldn't block the rest. Surface via activity.
        await ctx.activity.emit({
          severity: "action_required",
          summary: `RSS Watcher failed to create bookmark for entry ${entry.id}`,
          detail: { error: errorMessage(err) },
        });
      }
    }

    cursor.last_run_at = new Date(message.scheduled_for_ms).toISOString();
    await ctx.cursor.write(CURSOR_KEY, cursor);

    await ctx.activity.emit({
      severity: "info",
      summary:
        created.length === 0
          ? "RSS Watcher tick — no new entries"
          : `RSS Watcher created ${String(created.length)} bookmark(s)`,
      detail: {
        feed_url: feedUrl,
        entries_seen: parsed.entries.length,
        entries_created: created.length,
      },
    });

    return { ok: true };
  };
}

export function registerHandlers(opts: RssHandlerOptions = {}): void {
  registerScheduleHandler(createScheduleHandler(opts));
}

/**
 * A connection carrying no `feed_url` is a legitimate default install
 * and resolves to the compiled-in feed. A read that *fails* is not the
 * same thing and must not resolve to it: since the URL is now compared
 * against the cursor every tick, answering "default" on a blip would
 * read as a deliberate feed switch and wipe the dedupe state, replaying
 * the whole feed as new bookmarks.
 */
type FeedUrlResolution =
  | { ok: true; url: string }
  | { ok: false; error: unknown };

async function resolveFeedUrl(
  ctx: ConnectionContext,
): Promise<FeedUrlResolution> {
  let connection: ItemResource | null;
  try {
    connection = await ctx.marfa.getItem(ctx.connection_id);
  } catch (err) {
    return { ok: false, error: err };
  }
  const props = connection?.properties as
    | { configuration?: unknown }
    | undefined;
  const config = props?.configuration;
  if (
    typeof config === "object" &&
    config !== null &&
    "feed_url" in config &&
    typeof (config as { feed_url?: unknown }).feed_url === "string" &&
    (config as { feed_url: string }).feed_url.length > 0
  ) {
    return { ok: true, url: (config as { feed_url: string }).feed_url };
  }
  return { ok: true, url: DEFAULT_FEED_URL };
}

function filterNewEntries(
  entries: FeedEntry[],
  cursor: RssCursor,
): FeedEntry[] {
  const seen = new Set(cursor.recent_entry_ids);
  const lastSeen = cursor.last_seen_updated
    ? Date.parse(cursor.last_seen_updated)
    : null;

  const fresh: FeedEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    if (lastSeen !== null && entry.updated !== null) {
      const updatedMs = Date.parse(entry.updated);
      if (Number.isFinite(updatedMs) && updatedMs <= lastSeen) continue;
    }
    fresh.push(entry);
  }
  // Process oldest-first so the recent-id ring evicts in chronological
  // order if the feed page exceeds the ring size.
  fresh.reverse();
  return fresh;
}

function recordSeen(cursor: RssCursor, entry: FeedEntry): void {
  cursor.recent_entry_ids.push(entry.id);
  if (cursor.recent_entry_ids.length > RECENT_ID_RING_SIZE) {
    cursor.recent_entry_ids.splice(
      0,
      cursor.recent_entry_ids.length - RECENT_ID_RING_SIZE,
    );
  }
  if (entry.updated !== null) {
    const updatedMs = Date.parse(entry.updated);
    const lastMs = cursor.last_seen_updated
      ? Date.parse(cursor.last_seen_updated)
      : 0;
    if (Number.isFinite(updatedMs) && updatedMs > lastMs) {
      cursor.last_seen_updated = entry.updated;
    }
  }
}

function buildBookmarkInput(
  entry: FeedEntry,
  feed: ReturnType<typeof parseFeed>,
): CreateItemInput {
  const properties: Record<string, unknown> = {
    title: entry.title,
  };
  if (entry.url !== null) properties.url = entry.url;
  const body = entry.content ?? entry.summary;
  if (body !== null) properties.body = body;
  if (entry.summary !== null) properties.description = entry.summary;
  if (entry.author !== null) properties.author = entry.author;
  if (entry.published !== null) properties.published_at = entry.published;
  if (feed.feed_title !== null) properties.source_title = feed.feed_title;
  if (feed.feed_url !== null) properties.source_url = feed.feed_url;
  // Stamp the upstream entry id as `source_id`. Combined with the
  // server-stamped `source` from this integration's runtime credential, this
  // gives `POST /items` natural-key idempotency: a whole-batch retry
  // (createItem-success / cursor-write-fail) re-POSTs the same entries and
  // the server short-circuits to update instead of creating duplicates.
  // The recent-id ring is still the primary dedupe path; this is the
  // belt-and-braces second line for the createItem-then-cursor-fail window.
  return { type: "core.bookmark", properties, source_id: entry.id };
}

async function reportFailure(
  ctx: ConnectionContext,
  summary: string,
  err: unknown,
): Promise<HandlerResult> {
  await ctx.activity.emit({
    severity: "action_required",
    summary: `RSS Watcher: ${summary}`,
    detail: err === null ? undefined : { error: errorMessage(err) },
  });
  return { ok: false, retry: true, reason: summary };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
