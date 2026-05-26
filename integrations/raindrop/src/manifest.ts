/**
 * Manifest for the Raindrop inbound integration
 * (`raindrop.bookmarks`).
 *
 * Token-credential consumer of the T-241 PR1 substrate. Uses
 * Raindrop's REST API (`GET /rest/v1/collections`,
 * `GET /rest/v1/collections/childrens`, `GET /rest/v1/raindrops/0`)
 * as the inbound rail. Outbound is out of scope (`direction: "read"`).
 *
 * Raindrop accepts `Authorization: Bearer <key>` — the default
 * scheme on `kind:api_token` credentials — so no `auth_scheme: "Token"`
 * override is needed at install time.
 *
 * 10-minute cron — Raindrop bookmarks are moderately time-sensitive
 * (operators expect newly-saved items to land relatively quickly).
 */
import type { IntegrationManifest } from "@withmarfa/shared";

export const RAINDROP_MANIFEST: IntegrationManifest = {
  name: "raindrop.bookmarks",
  version: "0.1.0",
  manifest_schema_version: "1.1.0",
  publisher: "raindrop",
  description:
    "Inbound sync of Raindrop bookmarks + collections via the REST API. Polls every 10 minutes; lands raindrops as raindrop.raindrop items with parent-of edges to raindrop.collection items.",
  direction: "read",
  runtime_compatibility: ["hosted", "local"],
  target_types: ["raindrop.raindrop", "raindrop.collection"],
  triggers: [{ type: "schedule", config: { cron: "*/10 * * * *" } }],
  bidirectional_handling: {
    echo_ttl_seconds: 1,
    lag_window_seconds: 1,
    tombstone_mapping: "ignore",
    partial_write_mode: "accept-partial",
  },
  oauth_requirements: {},
  token_requirements: { raindrop: "required" },
  webhook_verification: { method: "hmac-sha256" },
  permissions: {
    extension: { "connection.runtime": "write" },
    edge: { "parent-of": "write" },
  },
};

export const INTEGRATION_NAME = RAINDROP_MANIFEST.name;
export const COLLECTIONS_PATH = "/rest/v1/collections";
export const COLLECTION_CHILDREN_PATH = "/rest/v1/collections/childrens";
/** Collection id `0` is Raindrop's "all except trash" sentinel —
 *  cheapest single endpoint that returns every raindrop the user has. */
export const ALL_RAINDROPS_PATH = "/rest/v1/raindrops/0";
