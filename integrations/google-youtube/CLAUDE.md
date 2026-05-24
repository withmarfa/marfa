# google-youtube

Inbound-only YouTube sync via the YouTube Data API v3. Fourth
instance of the `google.*` publisher family — sibling to
`google.calendar`, `google.tasks`, and `google.contacts`.

Schedule-only — YouTube Data API has no push-notification surface for
the liked-videos / subscriptions / playlists collections this
integration consumes. Hourly cron (`0 * * * *`) is well under any
quota ceiling.

## Identity

- Manifest name: **`google.youtube`** (publisher `google`).
- Target types: `google.youtube.video`, `google.youtube.playlist`,
  `google.youtube.channel`. Default written type for videos is
  `google.youtube.video` — when a future ticket adds a `core.media`
  shape, install-time `target_type` can switch to that.
- Direction: `read` — consumer surface only. Liking videos,
  subscribing, and writing playlists is out of scope for v1.

## OAuth scopes

One scope only, declared in `manifest.ts` as
`RECOMMENDED_OAUTH_SCOPES`:

- `https://www.googleapis.com/auth/youtube.readonly` — read-only
  consumer scope. Covers likes, subs, and playlists in a single
  grant.

The broader `https://www.googleapis.com/auth/youtube` (read + write)
scope is deliberately NOT requested — outbound surface is out of
scope for v1.

## YouTube Data API v3 specifics

Three operationally significant points the handler honours:

- **Liked-playlist discovery.** Likes are surfaced via the magic
  playlist returned by `channels.list?part=contentDetails&mine=true`
  under `items[0].contentDetails.relatedPlaylists.likes`. The handler
  resolves this id on first sweep and caches it on the cursor under
  `liked_playlist_id`. Subsequent sweeps skip the resolution call.

- **No API-level sync tokens.** YouTube has no equivalent of the
  People-API `syncToken`. Incremental sync uses logical watermarks:
  `snippet.publishedAt` on liked-playlist items (which records the
  time the user liked the video, not the video's publish date) for
  liked videos, and `subscriberSnippet.subscribedAt` for
  subscriptions. Every sweep paginates forward newest-first and stops
  when an item's watermark is `<=` the stored watermark.

- **Batch-of-50 video lookups.** `videos.list?id=<csv>` accepts up to
  50 ids per call. The handler batches new likes into chunks of 50
  before fetching full video metadata. `BATCH_FETCH_MAX = 50` in
  `manifest.ts` is the cap.

## Per-connection upstream_base_url

YouTube Data API v3 lives at `https://www.googleapis.com`, the same
host as Calendar / Tasks / Drive. The shared google.\* OAuth
credential row (`upstream_base_url = "https://www.googleapis.com"`)
works without a T-254 per-connection
`upstream_base_url_override`. Reuse the existing credential via
`credential_ref` on `POST /connections/install`.

## Configuration

Driven by `connection.properties.configuration`:

- `target_type: string` — `google.youtube.video` (default) or, once
  added, a `core.media` type for cross-app interop.
- `materialise_playlists: boolean` — default `false`
  (ticket-recommended). When `true`, the handler walks each
  user-created playlist's video membership and lands those videos
  too, with `playlist parent-of video` edges. When `false`, only
  liked videos are materialised; playlist items metadata captures
  membership counts only (no per-video walk).

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```ts
interface YoutubeCursor {
  seeded: boolean;
  liked_playlist_id: string | null;
  latest_liked_at: string | null;
  latest_subscribed_at: string | null;
  /** etag per user-created playlist, keyed by playlist id. */
  playlist_etags: Record<string, string>;
  mappings: {
    videos: Record<string, string>; // youtube video id -> myme item id
    channels: Record<string, string>; // youtube channel id -> myme item id
    playlists: Record<string, string>; // youtube playlist id -> myme item id
  };
  last_inbound_at: string | null;
}
```

## Quota math

Per hourly sweep:

- 1 unit for `channels.list?mine=true` (only on first sweep; cached
  thereafter as `liked_playlist_id`).
- 1 unit per page of `playlistItems.list` for the likes scan.
  Typically 1–2 pages in steady state.
- 1 unit per page of `subscriptions.list?mine=true`.
- 1 unit per page of `playlists.list?mine=true`.
- 1 unit per `videos.list?id=<csv>` batch (one batch covers up to 50
  videos).

Steady-state per-sweep cost is ~3–5 units. 24 sweeps/day = 72–120
units against the default 10,000-unit daily quota. Materialising
playlists on a sweep where playlist etags change adds 1 unit per
playlist's pagination page + 1 per 50 video hydrate batch — still
small compared to the ceiling.

## Edges authored at upsert

- `channel parent-of video` — every video carries its owning channel.
  Channels are upserted on demand via `ensureChannel` (cached in
  `cursor.mappings.channels`).
- `channel parent-of playlist` — every user-created playlist carries
  its owning channel.
- `playlist parent-of video` — only when
  `config.materialise_playlists === true`.

`liked_at` is a property on the video item (set from the
liked-playlist item's `snippet.publishedAt`), NOT modelled as an
edge. The liked-playlist itself is the implicit container.

Edge direction follows the core convention: `parent-of` source =
parent, target = child.

## Account isolation

The first upstream call on every sweep is `channels.list?mine=true`
(needed to resolve the liked-playlist id on cold start, and a sanity
ping thereafter). External validation harnesses should assert the
returned channel matches the test account; mismatch → exit 1
`account_isolation_breach`.

## Skip-on-unchanged playlist

`syncUserPlaylists` records `pl.etag` per playlist on every sweep.
When `config.materialise_playlists === true`, the per-playlist
video walk runs ONLY when the prior cached etag differs from the
current one — unchanged playlists skip the walk entirely, capping
the per-sweep cost at one `playlists.list` call.
