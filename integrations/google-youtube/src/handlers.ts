/**
 * Google YouTube (Data API v3) inbound handler.
 *
 * Single trigger: SCHEDULE (hourly sweep). Three sub-sweeps per
 * tick, run sequentially — not in parallel — so quota usage is
 * deterministic and easy to attribute when a single sub-sweep fails.
 *
 *   1. `syncLikedVideos`     — paginate the user's liked-playlist for
 *      new videos since `cursor.latest_liked_at`; batch-of-50 hydrate
 *      via `videos.list?id=<csv>`. On first sweep the liked-playlist
 *      id is resolved via `channels.list?mine=true` and cached on the
 *      cursor.
 *   2. `syncSubscriptions`   — paginate `subscriptions.list?mine=true`
 *      for new subs since `cursor.latest_subscribed_at`; upsert each
 *      resolved channel as a `google.youtube.channel` item.
 *   3. `syncUserPlaylists`   — paginate `playlists.list?mine=true` and
 *      upsert each as `google.youtube.playlist`. When
 *      `config.materialise_playlists === true` AND the playlist's
 *      etag has changed since the last sweep, walk its videos and
 *      author `playlist parent-of video` edges.
 *
 * Quota math: a typical hourly sweep is ~3–5 units. 24 sweeps/day =
 * 72–120 units against the default 10,000-unit daily quota.
 *
 * Inbound-only: no echo / lag-window plumbing is exercised here. The
 * manifest's minimal echo / lag settings are placeholders only.
 *
 * Edge model:
 *   - `channel parent-of video`     (every video has its owning channel)
 *   - `channel parent-of playlist`  (every playlist has its owning channel)
 *   - `playlist parent-of video`    (only when materialise_playlists=true)
 *   `liked_at` is a property on the video, NOT an edge.
 */
import {
  registerScheduleHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type HandlerResult,
  type CreateItemInput,
} from "@withmarfa/runtime-sdk";
import {
  YOUTUBE_API_BASE,
  DEFAULT_TARGET_TYPE,
  BATCH_FETCH_MAX,
  CHANNELS_LIST_PART,
  PLAYLIST_ITEMS_PART,
  SUBSCRIPTIONS_PART,
  PLAYLISTS_PART,
  VIDEOS_PART,
} from "./manifest.js";

const CURSOR_KEY = "main";

/** YouTube list pagesize cap — applies to playlistItems, subscriptions,
 *  and playlists endpoints. */
const PAGE_SIZE = 50;

/** Safety brake on per-sub-sweep pagination. The user's like history
 *  could be huge on cold start, but cold start is a one-off; this caps
 *  any runaway pagination loop. */
const MAX_PAGES_PER_SWEEP = 200;

export interface YoutubeCursor {
  /** Flipped true after the first successful sweep. */
  seeded: boolean;
  /** Resolved on first sweep via channels.list?mine=true. */
  liked_playlist_id: string | null;
  /** ISO timestamp watermark on `snippet.publishedAt` of liked videos. */
  latest_liked_at: string | null;
  /** ISO timestamp watermark on `subscriberSnippet.subscribedAt`. */
  latest_subscribed_at: string | null;
  /** etag per user-created playlist, keyed by playlist id. Used to
   *  skip re-walking unchanged playlists. */
  playlist_etags: Record<string, string>;
  mappings: {
    /** YouTube video id -> Marfa item id. */
    videos: Record<string, string>;
    /** YouTube channel id -> Marfa item id. */
    channels: Record<string, string>;
    /** YouTube playlist id -> Marfa item id. */
    playlists: Record<string, string>;
  };
  /** Diagnostic — last successful sweep timestamp. */
  last_inbound_at: string | null;
}

interface ConnectionConfig {
  target_type: string;
  materialise_playlists: boolean;
}

function defaultCursor(): YoutubeCursor {
  return {
    seeded: false,
    liked_playlist_id: null,
    latest_liked_at: null,
    latest_subscribed_at: null,
    playlist_etags: {},
    mappings: { videos: {}, channels: {}, playlists: {} },
    last_inbound_at: null,
  };
}

async function resolveConnectionConfig(
  ctx: ConnectionContext,
): Promise<ConnectionConfig> {
  try {
    const connection = await ctx.marfa.getItem(ctx.connection_id);
    const props = connection?.properties as
      | { configuration?: Record<string, unknown> }
      | undefined;
    const cfg = props?.configuration ?? {};
    const targetType =
      typeof cfg.target_type === "string" && cfg.target_type.length > 0
        ? cfg.target_type
        : DEFAULT_TARGET_TYPE;
    const materialise =
      typeof cfg.materialise_playlists === "boolean"
        ? cfg.materialise_playlists
        : false;
    return { target_type: targetType, materialise_playlists: materialise };
  } catch {
    return {
      target_type: DEFAULT_TARGET_TYPE,
      materialise_playlists: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Upstream resource shapes (slimmed — we only model what the handler reads).
// ---------------------------------------------------------------------------

interface ThumbnailSet {
  default?: { url?: string };
  medium?: { url?: string };
  high?: { url?: string };
  standard?: { url?: string };
  maxres?: { url?: string };
}

interface ChannelSnippet {
  title?: string;
  description?: string;
  customUrl?: string;
  publishedAt?: string;
  thumbnails?: ThumbnailSet;
}

interface ChannelStatistics {
  subscriberCount?: string;
  videoCount?: string;
  viewCount?: string;
}

interface ChannelContentDetails {
  relatedPlaylists?: {
    likes?: string;
    uploads?: string;
  };
}

interface ChannelResource {
  id: string;
  etag?: string;
  snippet?: ChannelSnippet;
  statistics?: ChannelStatistics;
  contentDetails?: ChannelContentDetails;
}

interface VideoSnippet {
  publishedAt?: string;
  channelId?: string;
  channelTitle?: string;
  title?: string;
  description?: string;
  thumbnails?: ThumbnailSet;
  tags?: string[];
  categoryId?: string;
  defaultAudioLanguage?: string;
}

interface VideoContentDetails {
  duration?: string;
}

interface VideoStatistics {
  viewCount?: string;
  likeCount?: string;
}

interface VideoResource {
  id: string;
  etag?: string;
  snippet?: VideoSnippet;
  contentDetails?: VideoContentDetails;
  statistics?: VideoStatistics;
}

interface PlaylistItemSnippet {
  publishedAt?: string;
  resourceId?: { kind?: string; videoId?: string };
  channelId?: string;
}

interface PlaylistItemContentDetails {
  videoId?: string;
  videoPublishedAt?: string;
}

interface PlaylistItemResource {
  id: string;
  snippet?: PlaylistItemSnippet;
  contentDetails?: PlaylistItemContentDetails;
}

interface SubscriptionSnippet {
  title?: string;
  description?: string;
  resourceId?: { kind?: string; channelId?: string };
  thumbnails?: ThumbnailSet;
}

interface SubscriberSnippet {
  subscribedAt?: string;
}

interface SubscriptionResource {
  id: string;
  snippet?: SubscriptionSnippet;
  subscriberSnippet?: SubscriberSnippet;
}

interface PlaylistSnippet {
  publishedAt?: string;
  channelId?: string;
  title?: string;
  description?: string;
  thumbnails?: ThumbnailSet;
}

interface PlaylistContentDetails {
  itemCount?: number;
}

interface PlaylistStatus {
  privacyStatus?: string;
}

interface PlaylistResource {
  id: string;
  etag?: string;
  snippet?: PlaylistSnippet;
  contentDetails?: PlaylistContentDetails;
  status?: PlaylistStatus;
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  pageInfo?: { totalResults?: number; resultsPerPage?: number };
}

// ---------------------------------------------------------------------------
// Field translation
// ---------------------------------------------------------------------------

function pickThumbnail(t: ThumbnailSet | undefined): string | undefined {
  if (!t) return undefined;
  return (
    t.maxres?.url ??
    t.standard?.url ??
    t.high?.url ??
    t.medium?.url ??
    t.default?.url
  );
}

function buildVideoInput(
  v: VideoResource,
  targetType: string,
  likedAt?: string,
): CreateItemInput {
  const s = v.snippet ?? {};
  const props: Record<string, unknown> = {
    video_id: v.id,
    title: s.title ?? "(untitled video)",
  };
  if (typeof s.description === "string" && s.description.length > 0) {
    props.description = s.description;
  }
  if (typeof s.channelId === "string") props.channel_id = s.channelId;
  if (typeof s.channelTitle === "string") props.channel_title = s.channelTitle;
  if (typeof s.publishedAt === "string") props.published_at = s.publishedAt;
  if (typeof likedAt === "string") props.liked_at = likedAt;
  const dur = v.contentDetails?.duration;
  if (typeof dur === "string" && dur.length > 0) props.duration_iso8601 = dur;
  const vc = v.statistics?.viewCount;
  if (typeof vc === "string") {
    const n = Number(vc);
    if (Number.isFinite(n)) props.view_count = n;
  }
  const lc = v.statistics?.likeCount;
  if (typeof lc === "string") {
    const n = Number(lc);
    if (Number.isFinite(n)) props.like_count = n;
  }
  const thumb = pickThumbnail(s.thumbnails);
  if (typeof thumb === "string") props.thumbnail_url = thumb;
  if (Array.isArray(s.tags) && s.tags.length > 0) props.tags = s.tags;
  if (typeof s.categoryId === "string") props.category_id = s.categoryId;
  if (typeof s.defaultAudioLanguage === "string") {
    props.default_audio_language = s.defaultAudioLanguage;
  }
  props.html_link = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
  return { type: targetType, properties: props };
}

function buildChannelInput(
  c: ChannelResource,
  subscribedAt?: string,
): CreateItemInput {
  const s = c.snippet ?? {};
  const props: Record<string, unknown> = {
    channel_id: c.id,
    title: s.title ?? "(untitled channel)",
  };
  if (typeof s.description === "string" && s.description.length > 0) {
    props.description = s.description;
  }
  if (typeof s.customUrl === "string") props.custom_url = s.customUrl;
  if (typeof s.publishedAt === "string") props.published_at = s.publishedAt;
  const thumb = pickThumbnail(s.thumbnails);
  if (typeof thumb === "string") props.thumbnail_url = thumb;
  const sub = c.statistics?.subscriberCount;
  if (typeof sub === "string") {
    const n = Number(sub);
    if (Number.isFinite(n)) props.subscriber_count = n;
  }
  const vcount = c.statistics?.videoCount;
  if (typeof vcount === "string") {
    const n = Number(vcount);
    if (Number.isFinite(n)) props.video_count = n;
  }
  const views = c.statistics?.viewCount;
  if (typeof views === "string") {
    const n = Number(views);
    if (Number.isFinite(n)) props.view_count = n;
  }
  if (typeof subscribedAt === "string") props.subscribed_at = subscribedAt;
  props.html_link = `https://www.youtube.com/channel/${encodeURIComponent(c.id)}`;
  return { type: "google.youtube.channel", properties: props };
}

function buildPlaylistInput(p: PlaylistResource): CreateItemInput {
  const s = p.snippet ?? {};
  const props: Record<string, unknown> = {
    playlist_id: p.id,
    title: s.title ?? "(untitled playlist)",
  };
  if (typeof s.description === "string" && s.description.length > 0) {
    props.description = s.description;
  }
  if (typeof s.channelId === "string") props.channel_id = s.channelId;
  if (typeof p.contentDetails?.itemCount === "number") {
    props.item_count = p.contentDetails.itemCount;
  }
  if (typeof p.status?.privacyStatus === "string") {
    props.privacy_status = p.status.privacyStatus;
  }
  if (typeof s.publishedAt === "string") props.published_at = s.publishedAt;
  const thumb = pickThumbnail(s.thumbnails);
  if (typeof thumb === "string") props.thumbnail_url = thumb;
  if (typeof p.etag === "string") props.etag = p.etag;
  props.html_link = `https://www.youtube.com/playlist?list=${encodeURIComponent(p.id)}`;
  return { type: "google.youtube.playlist", properties: props };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

async function proxyJson<T>(ctx: ConnectionContext, path: string): Promise<T> {
  const resp = await ctx.marfa.proxyRequest("GET", path);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `youtube GET ${path} -> ${String(resp.status)} ${text.slice(0, 300)}`,
    );
  }
  return (await resp.json()) as T;
}

/** Wire an upstream channel as a `google.youtube.channel` Marfa item,
 *  reusing the cursor mapping if present. Returns the Marfa item id. */
async function ensureChannel(
  ctx: ConnectionContext,
  cursor: YoutubeCursor,
  channelId: string,
): Promise<string | null> {
  const existing = cursor.mappings.channels[channelId];
  if (existing !== undefined) return existing;
  // Fetch channel metadata so we can populate the item with real
  // fields rather than a placeholder.
  try {
    const params = new URLSearchParams();
    params.set("part", CHANNELS_LIST_PART);
    params.set("id", channelId);
    const data = await proxyJson<ListResponse<ChannelResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/channels?${params.toString()}`,
    );
    const channel = data.items?.[0];
    if (!channel) return null;
    const input = buildChannelInput(channel);
    const created = await ctx.marfa.createItem({
      ...input,
      source_id: channel.id,
    });
    cursor.mappings.channels[channel.id] = created.id;
    return created.id;
  } catch (err) {
    await ctx.activity.emit({
      severity: "action_required",
      summary: `google-youtube: failed to resolve channel ${channelId}`,
      detail: { error: errorMessage(err) },
    });
    return null;
  }
}

async function safeCreateParentEdge(
  ctx: ConnectionContext,
  parentMarfa: string,
  childMarfa: string,
): Promise<boolean> {
  try {
    await ctx.marfa.createEdge({
      source_id: parentMarfa,
      target_id: childMarfa,
      edge_type: "parent-of",
    });
    return true;
  } catch {
    // 409 / already-exists is the expected outcome on re-sweeps.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sub-sweep 1 — liked videos
// ---------------------------------------------------------------------------

interface LikedSweepResult {
  upserted: number;
  edges: number;
  highestLikedAt: string | null;
}

async function syncLikedVideos(
  ctx: ConnectionContext,
  cursor: YoutubeCursor,
  config: ConnectionConfig,
): Promise<LikedSweepResult> {
  if (cursor.liked_playlist_id === null) {
    const params = new URLSearchParams();
    params.set("part", "contentDetails");
    params.set("mine", "true");
    const data = await proxyJson<ListResponse<ChannelResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/channels?${params.toString()}`,
    );
    const likedId =
      data.items?.[0]?.contentDetails?.relatedPlaylists?.likes ?? null;
    if (likedId === null) {
      await ctx.activity.emit({
        severity: "action_required",
        summary:
          "google-youtube: could not resolve the user's liked-videos playlist id from channels.list?mine=true",
      });
      return { upserted: 0, edges: 0, highestLikedAt: null };
    }
    cursor.liked_playlist_id = likedId;
  }

  const watermark = cursor.latest_liked_at;
  // Collect (videoId, likedAt) pairs newer than watermark across pages.
  const collected: { videoId: string; likedAt: string }[] = [];
  let pageToken: string | undefined;
  let highestLikedAt: string | null = null;
  let stop = false;

  for (let page = 0; page < MAX_PAGES_PER_SWEEP && !stop; page++) {
    const params = new URLSearchParams();
    params.set("part", PLAYLIST_ITEMS_PART);
    params.set("playlistId", cursor.liked_playlist_id);
    params.set("maxResults", String(PAGE_SIZE));
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const data = await proxyJson<ListResponse<PlaylistItemResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/playlistItems?${params.toString()}`,
    );
    const items = data.items ?? [];
    if (items.length === 0) break;

    for (const it of items) {
      const videoId =
        it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? "";
      // `snippet.publishedAt` on a liked-playlist item is the
      // time-the-user-liked-it timestamp (not the video's publish date).
      const likedAt =
        it.snippet?.publishedAt ?? it.contentDetails?.videoPublishedAt ?? "";
      if (videoId === "" || likedAt === "") continue;
      if (watermark !== null && likedAt <= watermark) {
        stop = true;
        break;
      }
      if (highestLikedAt === null || likedAt > highestLikedAt) {
        highestLikedAt = likedAt;
      }
      collected.push({ videoId, likedAt });
    }

    pageToken = data.nextPageToken;
    if (pageToken === undefined) break;
  }

  if (collected.length === 0) {
    return { upserted: 0, edges: 0, highestLikedAt: null };
  }

  const likedAtById = new Map<string, string>();
  for (const { videoId, likedAt } of collected) {
    // First-write wins — the watermark walk visits newest-first, so the
    // first `likedAt` we see is the authoritative one.
    if (!likedAtById.has(videoId)) likedAtById.set(videoId, likedAt);
  }
  const allIds = Array.from(likedAtById.keys());

  let upserted = 0;
  let edges = 0;

  for (const ids of chunk(allIds, BATCH_FETCH_MAX)) {
    const params = new URLSearchParams();
    params.set("part", VIDEOS_PART);
    params.set("id", ids.join(","));
    const data = await proxyJson<ListResponse<VideoResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/videos?${params.toString()}`,
    );
    for (const v of data.items ?? []) {
      const likedAt = likedAtById.get(v.id);
      const input = buildVideoInput(v, config.target_type, likedAt);
      try {
        const existing = cursor.mappings.videos[v.id];
        let videoMarfaId: string;
        if (existing !== undefined) {
          await ctx.marfa.updateItem(existing, input);
          videoMarfaId = existing;
        } else {
          const created = await ctx.marfa.createItem({
            ...input,
            source_id: v.id,
          });
          videoMarfaId = created.id;
          cursor.mappings.videos[v.id] = videoMarfaId;
        }
        upserted += 1;
        const channelId = v.snippet?.channelId;
        if (typeof channelId === "string" && channelId.length > 0) {
          const channelMarfa = await ensureChannel(ctx, cursor, channelId);
          if (channelMarfa !== null) {
            const ok = await safeCreateParentEdge(
              ctx,
              channelMarfa,
              videoMarfaId,
            );
            if (ok) edges += 1;
          }
        }
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-youtube: failed to upsert video ${v.id}`,
          detail: { error: errorMessage(err) },
        });
      }
    }
  }

  return { upserted, edges, highestLikedAt };
}

// ---------------------------------------------------------------------------
// Sub-sweep 2 — subscriptions
// ---------------------------------------------------------------------------

interface SubscriptionsSweepResult {
  upserted: number;
  highestSubscribedAt: string | null;
}

async function syncSubscriptions(
  ctx: ConnectionContext,
  cursor: YoutubeCursor,
): Promise<SubscriptionsSweepResult> {
  const watermark = cursor.latest_subscribed_at;
  let pageToken: string | undefined;
  let upserted = 0;
  let highestSubscribedAt: string | null = null;

  // No early-termination flag here — YouTube Data API v3's
  // `subscriptions.list` doesn't expose time-ordering (`order` only
  // accepts `alphabetical | relevance | unread`), so we walk every
  // page every sweep. The per-item watermark skip below keeps the
  // upsert work bounded; mapping-based dedup
  // (`cursor.mappings.channels`) keeps repeated subscriptions cheap.
  for (let page = 0; page < MAX_PAGES_PER_SWEEP; page++) {
    const params = new URLSearchParams();
    params.set("part", SUBSCRIPTIONS_PART);
    params.set("mine", "true");
    params.set("maxResults", String(PAGE_SIZE));
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const data = await proxyJson<ListResponse<SubscriptionResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/subscriptions?${params.toString()}`,
    );
    const items = data.items ?? [];
    if (items.length === 0) break;

    for (const sub of items) {
      const subscribedAt = sub.subscriberSnippet?.subscribedAt ?? "";
      const channelId = sub.snippet?.resourceId?.channelId ?? "";
      if (subscribedAt === "" || channelId === "") continue;
      // Skip-if-watermark-stale rather than break-on-watermark-stale —
      // YouTube doesn't time-order subscriptions.list, so we MUST walk
      // every page and per-item filter (no early-termination
      // short-circuit). Mapping-based dedup below keeps the upsert
      // work bounded; this branch keeps the proxy traffic bounded
      // too once a sub has been seen once.
      if (watermark !== null && subscribedAt <= watermark) continue;
      if (highestSubscribedAt === null || subscribedAt > highestSubscribedAt) {
        highestSubscribedAt = subscribedAt;
      }

      // Fetch full channel metadata so we can write a meaningful
      // `google.youtube.channel` item carrying `subscribed_at`.
      try {
        const params2 = new URLSearchParams();
        params2.set("part", CHANNELS_LIST_PART);
        params2.set("id", channelId);
        const chData = await proxyJson<ListResponse<ChannelResource>>(
          ctx,
          `${YOUTUBE_API_BASE}/channels?${params2.toString()}`,
        );
        const channel = chData.items?.[0];
        if (!channel) continue;
        const input = buildChannelInput(channel, subscribedAt);
        const existing = cursor.mappings.channels[channelId];
        if (existing !== undefined) {
          await ctx.marfa.updateItem(existing, input);
        } else {
          const created = await ctx.marfa.createItem({
            ...input,
            source_id: channelId,
          });
          cursor.mappings.channels[channelId] = created.id;
        }
        upserted += 1;
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-youtube: failed to upsert subscribed channel ${channelId}`,
          detail: { error: errorMessage(err) },
        });
      }
    }

    pageToken = data.nextPageToken;
    if (pageToken === undefined) break;
  }

  return { upserted, highestSubscribedAt };
}

// ---------------------------------------------------------------------------
// Sub-sweep 3 — user-created playlists
// ---------------------------------------------------------------------------

interface PlaylistsSweepResult {
  upserted: number;
  edges: number;
  videos_materialised: number;
}

async function syncUserPlaylists(
  ctx: ConnectionContext,
  cursor: YoutubeCursor,
  config: ConnectionConfig,
): Promise<PlaylistsSweepResult> {
  let pageToken: string | undefined;
  let upserted = 0;
  let edges = 0;
  let videos_materialised = 0;

  for (let page = 0; page < MAX_PAGES_PER_SWEEP; page++) {
    const params = new URLSearchParams();
    params.set("part", PLAYLISTS_PART);
    params.set("mine", "true");
    params.set("maxResults", String(PAGE_SIZE));
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const data = await proxyJson<ListResponse<PlaylistResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/playlists?${params.toString()}`,
    );
    const items = data.items ?? [];
    if (items.length === 0) break;

    for (const pl of items) {
      const priorEtag = cursor.playlist_etags[pl.id];
      const etagChanged = priorEtag !== pl.etag;
      const input = buildPlaylistInput(pl);
      let playlistMarfaId: string;
      try {
        const existing = cursor.mappings.playlists[pl.id];
        if (existing !== undefined) {
          await ctx.marfa.updateItem(existing, input);
          playlistMarfaId = existing;
        } else {
          const created = await ctx.marfa.createItem({
            ...input,
            source_id: pl.id,
          });
          playlistMarfaId = created.id;
          cursor.mappings.playlists[pl.id] = playlistMarfaId;
        }
        upserted += 1;
        if (typeof pl.etag === "string") {
          cursor.playlist_etags[pl.id] = pl.etag;
        }
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-youtube: failed to upsert playlist ${pl.id}`,
          detail: { error: errorMessage(err) },
        });
        continue;
      }

      const channelId = pl.snippet?.channelId;
      if (typeof channelId === "string" && channelId.length > 0) {
        const channelMarfa = await ensureChannel(ctx, cursor, channelId);
        if (channelMarfa !== null) {
          const ok = await safeCreateParentEdge(
            ctx,
            channelMarfa,
            playlistMarfaId,
          );
          if (ok) edges += 1;
        }
      }

      if (config.materialise_playlists && etagChanged) {
        const walked = await materialisePlaylistVideos(
          ctx,
          cursor,
          config,
          pl.id,
          playlistMarfaId,
        );
        videos_materialised += walked.upserted;
        edges += walked.edges;
      }
    }

    pageToken = data.nextPageToken;
    if (pageToken === undefined) break;
  }

  return { upserted, edges, videos_materialised };
}

interface MaterialiseResult {
  upserted: number;
  edges: number;
}

async function materialisePlaylistVideos(
  ctx: ConnectionContext,
  cursor: YoutubeCursor,
  config: ConnectionConfig,
  playlistId: string,
  playlistMarfaId: string,
): Promise<MaterialiseResult> {
  let pageToken: string | undefined;
  const videoIds: string[] = [];

  for (let page = 0; page < MAX_PAGES_PER_SWEEP; page++) {
    const params = new URLSearchParams();
    params.set("part", PLAYLIST_ITEMS_PART);
    params.set("playlistId", playlistId);
    params.set("maxResults", String(PAGE_SIZE));
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const data = await proxyJson<ListResponse<PlaylistItemResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/playlistItems?${params.toString()}`,
    );
    for (const it of data.items ?? []) {
      const vId =
        it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? "";
      if (vId !== "") videoIds.push(vId);
    }
    pageToken = data.nextPageToken;
    if (pageToken === undefined) break;
  }

  if (videoIds.length === 0) return { upserted: 0, edges: 0 };

  let upserted = 0;
  let edges = 0;
  const uniqueIds = Array.from(new Set(videoIds));

  for (const ids of chunk(uniqueIds, BATCH_FETCH_MAX)) {
    const params = new URLSearchParams();
    params.set("part", VIDEOS_PART);
    params.set("id", ids.join(","));
    const data = await proxyJson<ListResponse<VideoResource>>(
      ctx,
      `${YOUTUBE_API_BASE}/videos?${params.toString()}`,
    );
    for (const v of data.items ?? []) {
      const input = buildVideoInput(v, config.target_type);
      try {
        const existing = cursor.mappings.videos[v.id];
        let videoMarfaId: string;
        if (existing !== undefined) {
          await ctx.marfa.updateItem(existing, input);
          videoMarfaId = existing;
        } else {
          const created = await ctx.marfa.createItem({
            ...input,
            source_id: v.id,
          });
          videoMarfaId = created.id;
          cursor.mappings.videos[v.id] = videoMarfaId;
        }
        upserted += 1;
        const ok = await safeCreateParentEdge(
          ctx,
          playlistMarfaId,
          videoMarfaId,
        );
        if (ok) edges += 1;
        const channelId = v.snippet?.channelId;
        if (typeof channelId === "string" && channelId.length > 0) {
          const channelMarfa = await ensureChannel(ctx, cursor, channelId);
          if (channelMarfa !== null) {
            const cok = await safeCreateParentEdge(
              ctx,
              channelMarfa,
              videoMarfaId,
            );
            if (cok) edges += 1;
          }
        }
      } catch (err) {
        await ctx.activity.emit({
          severity: "action_required",
          summary: `google-youtube: failed to materialise playlist video ${v.id}`,
          detail: { error: errorMessage(err) },
        });
      }
    }
  }

  return { upserted, edges };
}

// ---------------------------------------------------------------------------
// Schedule handler
// ---------------------------------------------------------------------------

export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  void message;
  const cursor: YoutubeCursor =
    ((await ctx.cursor.read(CURSOR_KEY)) as YoutubeCursor | null) ??
    defaultCursor();
  const config = await resolveConnectionConfig(ctx);

  try {
    const liked = await syncLikedVideos(ctx, cursor, config);
    if (liked.highestLikedAt !== null) {
      cursor.latest_liked_at = liked.highestLikedAt;
    }
    const subs = await syncSubscriptions(ctx, cursor);
    if (subs.highestSubscribedAt !== null) {
      cursor.latest_subscribed_at = subs.highestSubscribedAt;
    }
    const playlists = await syncUserPlaylists(ctx, cursor, config);

    cursor.last_inbound_at = new Date().toISOString();
    cursor.seeded = true;
    await ctx.cursor.write(CURSOR_KEY, cursor);

    await ctx.activity.emit({
      severity: "info",
      summary: `google-youtube inbound: liked_upserted=${String(
        liked.upserted,
      )} subscriptions_upserted=${String(
        subs.upserted,
      )} playlists_upserted=${String(
        playlists.upserted,
      )} playlist_videos_materialised=${String(
        playlists.videos_materialised,
      )} edges_created=${String(liked.edges + playlists.edges)}`,
      detail: {
        liked_upserted: liked.upserted,
        subscriptions_upserted: subs.upserted,
        playlists_upserted: playlists.upserted,
        playlist_videos_materialised: playlists.videos_materialised,
        edges_created: liked.edges + playlists.edges,
        materialise_playlists: config.materialise_playlists,
      },
    });

    return { ok: true };
  } catch (err) {
    const reason = errorMessage(err);
    // YouTube Data API quota-exceeded surfaces as 403 with a
    // `quotaExceeded` reason in the response body.
    if (reason.includes("quotaExceeded")) {
      await ctx.activity.emit({
        severity: "action_required",
        summary:
          "google-youtube: YouTube Data API daily quota exceeded — sweep partial; resumes next sweep window",
        detail: { reason },
      });
      // Persist whatever cursor progress we made before the quota hit.
      await ctx.cursor.write(CURSOR_KEY, cursor);
      return { ok: true };
    }
    await ctx.activity.emit({
      severity: "action_required",
      summary: "google-youtube: sweep failed",
      detail: { error: reason },
    });
    return { ok: false, retry: true, reason };
  }
}

export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
}

// Test-only exports.
export const __internals = {
  defaultCursor,
  buildVideoInput,
  buildChannelInput,
  buildPlaylistInput,
  pickThumbnail,
  chunk,
};
