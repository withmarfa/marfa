/**
 * RSS Watcher handlers.
 *
 * Single trigger: schedule. Each tick:
 *   1. Resolve the feed URL from the connection's
 *      `properties.configuration.feed_url` (falls back to the
 *      compiled-in default if absent).
 *   2. Fetch and parse the feed.
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
} from "@mymehq/runtime-sdk";
import { parseAtomFeed, type AtomEntry } from "./atom-parser.js";

export const DEFAULT_FEED_URL = "https://simonwillison.net/atom/everything/";
export const RECENT_ID_RING_SIZE = 200;
const CURSOR_KEY = "main";

interface RssCursor {
  /** Resolved feed URL (cached after first connection-record read). */
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
    let cursor = (await ctx.cursor.read(CURSOR_KEY)) as RssCursor | null;
    const feedUrl = cursor?.feed_url ?? (await resolveFeedUrl(ctx));
    cursor ??= {
      feed_url: feedUrl,
      last_seen_updated: null,
      recent_entry_ids: [],
      last_run_at: new Date(message.scheduled_for_ms).toISOString(),
    };

    let response: Response;
    try {
      response = await fetchImpl(feedUrl, {
        headers: { Accept: "application/atom+xml, application/xml, text/xml" },
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
    let parsed: ReturnType<typeof parseAtomFeed>;
    try {
      parsed = parseAtomFeed(xml);
    } catch (err) {
      return reportFailure(ctx, "atom parse failed", err);
    }

    const newEntries = filterNewEntries(parsed.entries, cursor);
    const created: ItemResource[] = [];
    for (const entry of newEntries) {
      try {
        const item = await ctx.myme.createItem(
          buildBookmarkInput(entry, parsed),
        );
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

async function resolveFeedUrl(ctx: ConnectionContext): Promise<string> {
  try {
    const connection = await ctx.myme.getItem(ctx.connection_id);
    const props = connection?.properties as
      | { configuration?: unknown }
      | undefined;
    const config = props?.configuration;
    if (
      typeof config === "object" &&
      config !== null &&
      "feed_url" in config &&
      typeof (config as { feed_url?: unknown }).feed_url === "string"
    ) {
      return (config as { feed_url: string }).feed_url;
    }
  } catch {
    // Fall through to default. We don't fail the tick on configuration
    // resolution — the default is always usable.
  }
  return DEFAULT_FEED_URL;
}

function filterNewEntries(
  entries: AtomEntry[],
  cursor: RssCursor,
): AtomEntry[] {
  const seen = new Set(cursor.recent_entry_ids);
  const lastSeen = cursor.last_seen_updated
    ? Date.parse(cursor.last_seen_updated)
    : null;

  const fresh: AtomEntry[] = [];
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

function recordSeen(cursor: RssCursor, entry: AtomEntry): void {
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
  entry: AtomEntry,
  feed: ReturnType<typeof parseAtomFeed>,
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
  return { type: "core.bookmark", properties };
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
  // Retry on transient errors; the runtime decides whether to backoff.
  return { ok: false, retry: true, reason: summary };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
