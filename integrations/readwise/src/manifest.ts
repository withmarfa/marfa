/**
 * Manifest for the Readwise inbound integration (`readwise.highlights`).
 *
 * Token-credential consumer of the T-241 PR1 substrate. Uses Readwise's
 * Export API (`GET /api/v2/export/?updatedAfter=...&pageCursor=...`)
 * as the inbound rail; outbound is out of scope (manifest direction is
 * `read`).
 *
 * Readwise requires `Authorization: Token <key>` (not Bearer), so the
 * credential is minted via `POST /credentials/api-token` with
 * `auth_scheme: "Token"` (T-246).
 *
 * Hourly cron — highlights aren't time-critical and Readwise's
 * per-token rate limit (240 req/min on Export) is generous but worth
 * conserving.
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const READWISE_MANIFEST: IntegrationManifest = {
  name: "readwise.highlights",
  version: "0.1.0",
  manifest_schema_version: "1.1.0",
  publisher: "readwise",
  description:
    "Inbound sync of Readwise highlights + parent books via the Export API. Polls hourly with an `updatedAfter` watermark; lands highlights as readwise.highlight items with parent-of edges to readwise.book items.",
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  target_types: ["readwise.highlight", "readwise.book"],
  triggers: [
    { type: "schedule", config: { cron: "0 * * * *" } }, // hourly
  ],
  bidirectional_handling: {
    // Inbound-only — echo/lag windows are functionally inert but the
    // schema requires the fields. Set to 1s minimums (the schema's
    // `.positive()` validator rejects zero).
    echo_ttl_seconds: 1,
    lag_window_seconds: 1,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  token_requirements: { readwise: "required" },
  // `webhook_verification` is schema-required even though no webhook
  // trigger is declared. The hmac-sha256 placeholder matches the
  // schedule-only convention used by google-tasks, rss-watcher, etc.
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: { "parent-of": "write" },
  },
};

export const INTEGRATION_NAME = READWISE_MANIFEST.name;

/** Readwise's Export API base path. */
export const EXPORT_PATH = "/api/v2/export/";

/** First-run sentinel — Readwise omits `updatedAfter` for a full
 *  export. We use a far-past timestamp so the cursor field is always a
 *  string (simpler than an optional). */
export const UPDATED_AFTER_INITIAL = "1970-01-01T00:00:00Z";

/** Default page size when paginating Readwise's Export API. Not a
 *  Readwise field — the server caps internally and returns
 *  `nextPageCursor` when more pages exist. */
