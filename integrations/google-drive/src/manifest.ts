/**
 * Manifest for the Google Drive integration (`google.drive`).
 *
 * Fourth instance of the `google.*` publisher family. INBOUND-only
 * in v1 — outbound writes to Drive (file uploads, MIME conversions,
 * folder picking, conflict handling) are a separate follow-on
 * ticket. The manifest's `direction: "inbound"` reflects that;
 * flipping to `"both"` is the follow-on's first change.
 *
 * Drive v3 specifics:
 *
 *   - **Incremental via `changes.list` with `pageToken`.** First
 *     sync calls `changes.getStartPageToken` to seed the cursor,
 *     then the schedule + webhook handlers both call `changes.list?pageToken=...`
 *     for incremental.
 *   - **Push notifications via `changes.watch`.** Whole-account
 *     scope — one channel per Connection. Channels expire at 24
 *     hours by default (max 7 days for full Drive). Renewal cron
 *     runs inside the schedule trigger with zero-downtime ordering
 *     (new channel first, then stop old) — same shape as Calendar
 *     PR4.
 *   - **Initial sync via `files.list`.** Paginates through the
 *     user's Drive (filtered by `trashed=false`). The harness
 *     against Oblix is small; production deployments would want a
 *     configurable initial-sync bound.
 *   - **Blob handling — metadata-only in v1.** Default
 *     `download_mode = "metadata"` reads file metadata into Myme
 *     `google.drive.file` items but does NOT download binary
 *     content. The `all-files` and `glob:<pattern>` modes are
 *     declared in `connection.properties.configuration` shape but
 *     **gated on a substrate addition**: ConnectionClient does not
 *     yet expose `uploadBlob`. Documented in
 *     `integrations/google-drive/CLAUDE.md`.
 *
 * OAuth uses the proxy mode. Drive v3 paths resolve under the
 * shared `https://www.googleapis.com` host (no per-credential
 * `upstream_base_url` override needed, unlike Contacts).
 */
import type { IntegrationManifest } from "@mymehq/shared";

export const GOOGLE_DRIVE_MANIFEST: IntegrationManifest = {
  name: "google.drive",
  version: "0.1.0",
  manifest_schema_version: "1.0.0",
  publisher: "google",
  description:
    "Inbound-only sync from Google Drive into Myme. Seeds via files.list, incremental via changes.list with persisted pageToken cursor, push notifications via changes.watch with a renewal cron. v1 is metadata-only; all-files blob mode pending a substrate addition.",
  // INBOUND-only in v1 — schema's "read" maps to inbound-only ingest.
  // Flipping to "both" is the outbound follow-on's first change
  // (manifest direction + handlers + tests). Documented in CLAUDE.md.
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  // `google.drive.file` is the upstream-fidelity type. `core.file`
  // is the cross-app shared shape. Both granted so the install-time
  // configuration can pick.
  target_types: ["core.file", "google.drive.file"],
  triggers: [
    { type: "schedule", config: { cron: "*/10 * * * *" } },
    { type: "item-event" },
    // Real webhook trigger — changes.watch push notifications. Uses
    // the existing google-channel adapter (same as Calendar).
    { type: "webhook" },
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 120,
    lag_window_seconds: 600,
    tombstone_mapping: "state-trashed",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: { drive: "proxy" },
  // Drive push notifications use the same shared-secret-header echo
  // shape as Calendar (X-Goog-Channel-Token verified by the
  // google-channel adapter in @mymehq/webhooks).
  webhook_verification: { method: "google-channel" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = GOOGLE_DRIVE_MANIFEST.name;
export const DRIVE_API_BASE = "/drive/v3";

/** Default target type — upstream-fidelity. */
export const DEFAULT_TARGET_TYPE = "google.drive.file";

/**
 * `files.list` field mask. Comprehensive enough to populate every
 * field declared on `google.drive.file`. The wider mask costs no
 * extra Drive API quota (files.list charges per request, not per
 * field).
 */
export const FILES_FIELDS = [
  "id",
  "name",
  "mimeType",
  "size",
  "createdTime",
  "modifiedTime",
  "owners(emailAddress,displayName)",
  "parents",
  "trashed",
  "webViewLink",
  "iconLink",
  "thumbnailLink",
  "md5Checksum",
  // NOTE: Drive v3 does NOT expose `etag` or `sha256Checksum` on the
  // file resource — requesting them in a `fields` mask returns HTTP
  // 400 `Invalid field selection`. Both are kept as TYPE fields on
  // `google.drive.file.json` because the type doc treats them as
  // "future fidelity" placeholders; the handler reads them
  // optionally with `?.` so a missing field is harmless. Surfaced
  // by the T-238 TS-harness when `files.list` 400'd on every cold-
  // start sweep — patch lands inside PR #304.
].join(",");

/**
 * `changes.list` field mask. The full shape is `nextPageToken,newStartPageToken,changes(...)`
 * where the inner `changes` list carries `fileId`, `removed`, `time`, and
 * `file(...)` with the same per-file mask used above.
 */
export const CHANGES_FIELDS = `nextPageToken,newStartPageToken,changes(fileId,removed,time,file(${FILES_FIELDS}))`;

/** Channel renewal leeway — refresh a watch channel when it's within
 *  this many ms of expiry. Matches Calendar's 24h leeway. */
export const CHANNEL_RENEW_LEEWAY_MS = 24 * 60 * 60 * 1000;

/** Channel TTL request — ask for 6 days (Drive max for full-account
 *  scope is 7 days; 6 leaves a one-day margin). */
export const CHANNEL_TTL_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * OAuth scopes this integration requests. One scope only —
 * `drive.readonly` — because v1 is inbound-only. The outbound
 * follow-on may widen to `drive.file` (per-file write created by
 * this app) or `drive` (full Drive access); deliberately deferred.
 */
export const RECOMMENDED_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

export const GOOGLE_DRIVE_OAUTH_SCOPES_STRING =
  RECOMMENDED_OAUTH_SCOPES.join(" ");
