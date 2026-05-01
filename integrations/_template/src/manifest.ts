/**
 * Template Integration manifest. Each real integration ships its own
 * with the same shape — the contract is defined in @mymehq/shared
 * (`IntegrationManifestSchema`) and Plan B's install pipeline persists
 * it onto the `system.connection` row.
 *
 * For Layer 1 this is a typed object with the minimal fields the
 * runtime cares about; the full schema lands in Plan B when the
 * server-side install endpoint validates it.
 */
export const TEMPLATE_MANIFEST = {
  name: "myme.template",
  version: "0.0.1",
  publisher: "myme",
  description:
    "Skeleton Integration. No external service. Exists to exercise the runtime substrate end-to-end during Layer 1 acceptance.",
  manifest_schema_version: "1.0.0",
  direction: "read" as const,
  runtime_compatibility: ["hosted"] as const,
  target_types: ["core.note"] as const,
  triggers: [
    {
      type: "schedule",
      cron: "*/5 * * * *", // every 5 minutes
      cursor_strategy: "incremental",
    },
  ] as const,
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "trash" as const,
    partial_write_mode: "all_or_nothing" as const,
  },
  oauth_requirements: {} as Record<string, "proxy" | "leased">,
  webhook_verification: { type: "hmac-sha256" as const },
  permissions: {
    extension: { "connection.runtime": "write" as const },
    edge: {},
  },
};

export const INTEGRATION_NAME = TEMPLATE_MANIFEST.name;
