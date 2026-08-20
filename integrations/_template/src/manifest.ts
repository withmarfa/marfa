/**
 * Template Integration manifest. Each real integration ships its own
 * with the same shape — the contract is defined in @withmarfa/shared
 * (`IntegrationManifestSchema`) and the install pipeline persists it
 * onto the `system.connection` row.
 *
 * The `manifest.test.ts` sibling parses this object through
 * `IntegrationManifestSchema` so future drift is caught locally.
 *
 * The name is deliberately a third party's, not the platform's: this is
 * what a contributor copies, and the shape they should copy is
 * `<their-handle>/<name>` rather than anything under `marfa/`.
 */
export const TEMPLATE_MANIFEST = {
  name: "acme/template",
  version: "0.0.1",
  publisher: "acme",
  description:
    "Skeleton Integration. No external service. Exists to exercise the runtime substrate end-to-end.",
  manifest_schema_version: "1.2.0",
  direction: "read" as const,
  runtime_compatibility: ["local"] as const,
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
