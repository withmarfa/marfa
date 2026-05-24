# google-drive

Inbound-only Google Drive (v3 API) integration. Fourth instance of
the `google.*` publisher family. v1 ships **metadata-only** because
the SDK doesn't yet expose a blob-upload primitive — the `all-files`
download mode is gated on a follow-on substrate PR.

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
  `core.file`.
- `download_mode: string` — `metadata` (default), `all-files`, or
  `glob:<pattern>`. Only `metadata` is wired in v1; the other two
  values flow through but emit a `system.activity` note that v1 is
  metadata-only (see substrate gap below).
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

## Blob handling — metadata-only in v1 (substrate gap)

[!] **The SDK's `ConnectionClient` does NOT expose a blob-upload
primitive yet.** v1 reads file metadata into Myme
`google.drive.file` items but does NOT download binary content. The
`download_mode` field is declared in `connection.properties.configuration`
and surfaces in activity logs, but `all-files` and `glob:<pattern>`
modes are no-ops in v1.

**Follow-on substrate ticket** (out of T-238 scope, blocks
`download_mode=all-files`):

1. Add `uploadBlob(content: ReadableStream | ArrayBuffer, mime: string): Promise<{ blob_ref: string }>`
   to `@mymehq/runtime-sdk`'s `ConnectionClient`. Server-side:
   forward to `POST /blobs` on the connection's tenant using the
   runtime credential.
2. T-238.1: wire `download_mode=all-files` in the Drive handler —
   for each non-Google-native file, fetch via
   `GET /drive/v3/files/{id}?alt=media`, pipe to `uploadBlob`,
   stamp `properties.blob_ref` on the item.

For `core.file` writes the required `blob_ref` field is synthesised
in v1 from `sha256Checksum` / `md5Checksum` / fall-through to
`drive:<file_id>` — a stable but non-content-addressed reference
that signals "metadata-only mode" to a careful reader. Once the
substrate addition lands, real `sha256:<hex>` references replace
these.

## Outbound — deferred

Outbound writes to Drive are explicitly out of scope. The manifest's
`direction: "inbound"` reflects that. The outbound follow-on needs
to address:

- Destination folder picking (where do new Myme `google.drive.file`
  items land — root? a designated folder? a per-tenant folder
  configured at install?).
- MIME conversion (Google Docs / Sheets / Slides have native types
  that don't accept raw byte uploads; need export-format mapping).
- Upload chunking for files >5MB.
- Conflict handling (Drive's `If-Match` header isn't supported on
  uploads; conflicts surface differently than Calendar's etag flow).

## Validation

The TS-harness validation log against the Oblix throwaway account
lives at the bottom of T-238 in the vault project. v1 validates
metadata mode: initial seed, incremental via changes.list,
changes.watch creation + renewal, tombstone mapping. The
`download_mode=all-files` round-trip is documented as the substrate
dependency.

Use `gog drive --account oblix.cyzr@gmail.com --client oblix-gcp ...`
for seed + teardown.
