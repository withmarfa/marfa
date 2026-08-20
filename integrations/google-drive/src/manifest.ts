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
 *     (new channel first, then stop old) — same shape as Calendar.
 *   - **Initial sync via `files.list`.** Paginates through the
 *     user's Drive (filtered by `trashed=false`). A throwaway test
 *     account is small; production deployments would want a
 *     configurable initial-sync bound.
 *   - **Blob handling — `metadata` and `all-files` modes.**
 *     `download_mode = "metadata"` (the default) reads file metadata
 *     into Marfa `google.drive.file` items with `blob_ref` absent.
 *     `download_mode = "all-files"` downloads non-Google-native
 *     files within the per-file size ceiling and uploads the bytes
 *     into the Marfa blob store via `ctx.marfa.uploadBlob`; those land
 *     as `core.file` with `properties.blob_ref = sha256:<hex>`.
 *     Google-native types, oversize files, and per-file download
 *     failures all fall back to `google.drive.file` (`blob_ref`
 *     absent). `glob:<pattern>` is declared but still falls through
 *     to `metadata` semantics — pattern grammar is a separate
 *     follow-on. Configurable ceiling via
 *     `connection.properties.configuration.max_file_size_bytes`
 *     (default 25 MB; see `DEFAULT_MAX_FILE_SIZE_BYTES` in handlers
 *     for the Worker-memory reasoning).
 *
 * OAuth uses the proxy mode. Drive v3 paths resolve under the
 * shared `https://www.googleapis.com` host (no per-credential
 * `upstream_base_url` override needed, unlike Contacts).
 */
import type { IntegrationManifest } from "@withmarfa/shared";

/**
 * The two families a connection chooses between, declared once and carried
 * on the manifest itself so the platform validates family coherence
 * centrally and the configure surface derives the chooser.
 */
const FAMILY_DEFINITIONS: Record<
  "google" | "core",
  { description: string; types: { file: string } }
> = {
  google: {
    description:
      "The Google Drive type, which keeps the full Drive metadata set; bytes are not required.",
    types: { file: "google.drive.file" },
  },
  core: {
    description:
      "The core file type, readable by any app that understands core files; requires ingested bytes, so it behaviorally pairs with download_mode: all-files.",
    types: { file: "core.file" },
  },
};

/** Role maps the handlers index; same object the manifest declares. */
export const WRITE_FAMILIES = {
  google: FAMILY_DEFINITIONS.google.types,
  core: FAMILY_DEFINITIONS.core.types,
} as const;

export type WriteFamily = keyof typeof WRITE_FAMILIES;

export const DEFAULT_WRITE_FAMILY: WriteFamily = "google";

export const GOOGLE_DRIVE_MANIFEST: IntegrationManifest = {
  name: "google.drive",
  version: "0.2.0",
  manifest_schema_version: "1.3.0",
  configuration_schema: {
    write_family: {
      type: "string",
      description:
        "Item family synced files land as. The google family keeps the full Drive metadata set; the core family is the cross-app shape other apps read, and needs file bytes, so it behaviorally pairs with download_mode: all-files.",
      from_write_families: true,
      default: DEFAULT_WRITE_FAMILY,
    },
    download_mode: {
      type: "string",
      description: "Whether file bytes are ingested or only metadata.",
      values: ["metadata", "all-files"],
      default: "metadata",
    },
    initial_sync_max_files: {
      type: "number",
      description: "Ceiling on files the first full sync ingests.",
    },
    max_file_size_bytes: {
      type: "number",
      description: "Per-file byte ceiling for downloaded content.",
    },
    inbound_webhook_url: {
      type: "string",
      description:
        "Push-notification receipt URL the changes watch registers against.",
    },
  },
  publisher: "google",
  description:
    "Inbound-only sync from Google Drive into Marfa. Seeds via files.list, incremental via changes.list with persisted pageToken cursor, push notifications via changes.watch with a renewal cron. Supports `download_mode: metadata` (default — google.drive.file items) and `download_mode: all-files` (non-Google-native, within-ceiling files ingested as core.file with blob_ref).",
  // INBOUND-only in v1 — schema's "read" maps to inbound-only ingest.
  // Flipping to "both" is the outbound follow-on's first change
  // (manifest direction + handlers + tests). Documented in CLAUDE.md.
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  // Both families' types are granted so the install-time configuration
  // can pick. `core.file` requires a real `blob_ref`, so the handler
  // routes byte-less files to `google.drive.file` whatever the family
  // says (cross-field constraints stay out of the manifest).
  target_types: [WRITE_FAMILIES.core.file, WRITE_FAMILIES.google.file],
  write_families: {
    families: FAMILY_DEFINITIONS,
    default: DEFAULT_WRITE_FAMILY,
  },
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
  // google-channel adapter in @withmarfa/webhooks).
  webhook_verification: { method: "google-channel" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: {},
  },
};

export const INTEGRATION_NAME = GOOGLE_DRIVE_MANIFEST.name;
export const DRIVE_API_BASE = "/drive/v3";

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
  // optionally with `?.` so a missing field is harmless.
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
