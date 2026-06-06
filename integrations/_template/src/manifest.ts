/**
 * Template Integration manifest. Each real integration ships its own
 * with the same shape — the contract is defined in @withmarfa/shared
 * (`IntegrationManifestSchema`) and the install pipeline persists it
 * onto the `system.connection` row.
 *
 * §2.3 fix: this file was out of date with the canonical schema. The shape now
 * matches it exactly:
 *   - `triggers[0]` carries cron under a nested `config: { cron }`
 *   - `tombstone_mapping` uses the canonical `state-trashed` value
 *   - `partial_write_mode` uses the hyphenated `all-or-nothing` value
 *   - `webhook_verification` discriminates on `method` (not `type`)
 *
 * The `manifest.test.ts` sibling parses this object through
 * `IntegrationManifestSchema` so future drift is caught locally.
 */
export const TEMPLATE_MANIFEST = {
  name: "marfa.template",
  version: "0.0.1",
  publisher: "marfa",
  description:
    "Skeleton Integration. No external service. Exists to exercise the runtime substrate end-to-end.",
  manifest_schema_version: "1.0.0",
  direction: "read" as const,
  runtime_compatibility: ["hosted", "local"] as const,
  target_types: ["core.note"] as const,
  triggers: [
    {
      type: "schedule" as const,
      config: { cron: "*/5 * * * *" }, // every 5 minutes
    },
  ] as const,
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "state-trashed" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  oauth_requirements: {} as Record<string, "proxy" | "leased">,
  webhook_verification: { method: "hmac-sha256" as const },
  permissions: {
    extension: { "connection.runtime": "write" as const },
    edge: {},
  },
};

export const INTEGRATION_NAME = TEMPLATE_MANIFEST.name;
