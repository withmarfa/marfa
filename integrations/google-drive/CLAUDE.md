# google-drive

Inbound-only Google Drive (v3 API) integration. Fourth instance of
the `google.*` publisher family. Two ingest modes: `metadata`
(default — file metadata only) and `all-files` (T-239 — bytes
ingested into the Marfa blob store and stamped as `blob_ref` on
`core.file` items). `glob:<pattern>` is declared but still falls
through to `metadata` semantics pending a separate follow-on.

## Identity

- Manifest name: **`google.drive`** (publisher `google`).
- Target types: `core.file` AND `google.drive.file`.
- **Direction:** `inbound` only in v1. Outbound writes to Drive
  (uploads, MIME conversions, folder picking, conflict handling) are
  a separate follow-on; flipping `direction` to `"both"` is that
  ticket's first change.

## OAuth scopes

One scope only:

- `https://www.googleapis.com/auth/drive.readonly` — read-only across
  the user's Drive (files + metadata + changes).

The outbound follow-on will widen to `drive.file` (per-file write
created by this app) or `drive` (full Drive access).

## Drive v3 specifics

- **Incremental sync via `changes.list`.** First call seeds the
  cursor from `changes.getStartPageToken`. Every subsequent call
  passes the stored `pageToken`. `nextPageToken` advances pagination
  within a sweep; `newStartPageToken` is what gets persisted as the
  cursor's pageToken for the next sweep.
- **Push notifications via `changes.watch`.** One whole-account
  channel per Connection. Renewal cron runs inside the schedule
  trigger — zero-downtime ordering (create new channel first, then
  stop old). Same shape as Calendar's `events/watch` pattern; the
  `google-channel` webhook adapter from T-231 PR4 verifies the
  channel token.
- **Initial sync via `files.list`** — paginated under
  `q=trashed=false`. Capped at 50 pages × 100 = 5000 files on first
  connect to keep the seed bounded; production deployments would
  want a configurable bound via
  `connection.properties.configuration.initial_sync_max_files`.

## Configuration

Driven by `connection.properties.configuration`:

- `target_type: string` — `google.drive.file` (default) or
  `core.file`. Acts as the operator's _preferred_ target when bytes
  are available. When bytes aren't ingested (metadata mode, or
  any all-files skip / failure), the handler routes to
  `google.drive.file` regardless — that's the only honest shape
  without a `blob_ref`. See "Blob handling" below.
- `download_mode: string` — `metadata` (default), `all-files`, or
  `glob:<pattern>`. `metadata` and `all-files` are both wired;
  `glob:<pattern>` is declared but currently falls through to
  `metadata` semantics — pattern grammar is a separate ticket.
- `max_file_size_bytes: number` — per-file ceiling for `all-files`
  mode. Default 25 MB. Files over the ceiling skip the byte ingest
  and land as `google.drive.file` with `blob_ref` absent. See
  "Blob handling" for why the default is 25 MB rather than the
  server's 50 MB `MAX_BLOB_SIZE`.
- `inbound_webhook_url?: string` — set when an inbound subscription
  has been minted at install time; enables `changes.watch` push.
  Absent → schedule-only.

## Cursor shape

Per `CURSOR_KEY = "main"` in the `connection.runtime` extension:

```
{
  mappings: Record<drive_file_id, myme_id>,
  pageToken: string | null,            // changes.list cursor
  seeded: boolean,                     // initial files.list completed
  last_inbound_at: string | null,
  channel?: {                          // active watch channel
    channel_id, resource_id, expiration_ms, channel_token
  },
  retired_channels?: ChannelState[]    // transient renewal stash
}
```

## changes.watch — zero-downtime renewal

Active when `connection.properties.configuration.inbound_webhook_url`
is set. The schedule cron doubles as the renewal cron:

- On each tick, check if the active channel is within 1 day of
  expiry (`CHANNEL_RENEW_LEEWAY_MS`).
- If renewal needed: create a NEW channel via
  `POST /drive/v3/changes/watch?pageToken=<current>`, persist its
  state, THEN call `POST /drive/v3/channels/stop` for the old. If
  stop fails the new channel keeps Google delivering pushes; the
  dangling old channel expires within its own TTL.

Channel TTL: 6 days requested (Drive max for full-account scope is
7 days; 6 leaves a margin).

Webhook handler: `X-Goog-Resource-State` is the only signal — body
is empty. The handler re-runs the incremental sweep (same path as
the schedule trigger) so push and poll converge.

## Tombstones

A `change.removed: true` or `change.file.trashed: true` triggers
`transitionItem(myme_id, "trashed")` and removes the mapping entry.

## Blob handling

Two modes, picked via `connection.properties.configuration.download_mode`:

- **`metadata` (default)** — every Drive file lands as
  `google.drive.file` with `blob_ref` absent. Drive's own
  checksums (`md5_checksum`, `sha256_checksum`) and the
  `drive_file_id` are still captured as independent properties;
  no synthesised `blob_ref` (the prior synthesised refs —
  `sha256:<sha256Checksum>`, `md5:<md5Checksum>`, `drive:<id>` —
  weren't fetchable via `GET /blobs/{ref}`, so they're gone).
- **`all-files`** — for each non-Google-native file within the
  configured ceiling, the handler proxies
  `GET /drive/v3/files/{id}?alt=media` to download the bytes,
  buffers them in the Worker, then calls
  `ctx.marfa.uploadBlob({ content, mime_type })` (T-239). On
  success the item lands as `core.file` with
  `properties.blob_ref = sha256:<hex>` — a real, retrievable
  blob ref.

**Programmatic invariant** consumers can rely on:
`typeof item.properties.blob_ref === "string"` ⇔ bytes are
fetchable via `GET /blobs/{blob_ref}`. The item type reinforces
the same signal: `core.file` always has a real `blob_ref`;
`google.drive.file` never has a synthesised one.

### All-files fallback paths

Three things route an item back to `google.drive.file`
(`blob_ref` absent) even when `download_mode: all-files` is set:

- **Google-native files** (`application/vnd.google-apps.*` — Docs,
  Sheets, Slides, Drawings) need export rather than `alt=media`
  download. Counted in the run summary as
  `skipped_google_native=N` at `info`; no per-file rows (the
  policy is whole-class). Wiring per-source-mime export is a
  separate follow-on.
- **Oversize files** — declared size exceeds
  `max_file_size_bytes` (default 25 MB). Per-file `info` activity
  carries the file id, size, and ceiling so the operator can see
  which were skipped; run summary counts `oversize=N`. The
  operator may raise the ceiling, but no action is required.
- **Per-file download failure** — proxy non-2xx or network /
  parse / SDK error. Per-file `info` activity captures the
  reason; run summary counts `download_failed=N`. The next
  schedule run retries automatically.

`action_required` severity is reserved for whole-run operator-
actionable failures (proxy 401 / reauth, credential rejection) —
consistent with neighbour integrations
(`task-auto-archive`, `rss-watcher`, `google-calendar`).

### Why a 25 MB per-file ceiling

The Workers isolate carries a 128 MB memory ceiling. The
all-files path transiently holds the file twice: once as the
`arrayBuffer()` from the proxy response, then again as the
Buffer passed to `uploadBlob` (fetch consumes the source body
asynchronously). Peak ≈ `2 × file_size + handler_state(~10 MB) + isolate_baseline(~30 MB)`.
25 MB keeps the transient peak under ~90 MB with ~40 MB
headroom. The server's `MAX_BLOB_SIZE` (50 MB default) is the
upper bound from the other side — 25 MB is the Worker-side
constraint that bites first. Raising past ~25 MB risks Worker
OOM until the paired stream-accepting SDK overload + server-side
streaming follow-up lands.

## Outbound — deferred

Outbound writes to Drive are explicitly out of scope. The manifest's
`direction: "inbound"` reflects that. The outbound follow-on needs
to address:

- Destination folder picking (where do new Marfa `google.drive.file`
  items land — root? a designated folder? a per-tenant folder
  configured at install?).
- MIME conversion (Google Docs / Sheets / Slides have native types
  that don't accept raw byte uploads; need export-format mapping).
- Upload chunking for files >5MB.
- Conflict handling (Drive's `If-Match` header isn't supported on
  uploads; conflicts surface differently than Calendar's etag flow).

## Validation

The TS-harness validation log against the Oblix throwaway account
lives at the bottom of T-238 in the vault project. T-239 validates
the `all-files` round-trip end-to-end against staging — drop a
small binary (PDF) into a watched folder, confirm the item lands
as `core.file` with `properties.blob_ref = sha256:<hex>`, then
`my -i admin blobs get <hash>` round-trips the bytes. Negative
cases (oversize, Google-native) verify the item lands as
`google.drive.file` with `blob_ref` absent and the run summary
counters reflect the skip reasons.

Use `gog drive --account oblix.cyzr@gmail.com --client oblix-gcp ...`
for seed + teardown.
