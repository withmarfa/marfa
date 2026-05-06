-- T-052: per-tenant resource quotas (Wave B PR4).
--
-- Stores per-tenant ceilings; missing rows / NULL columns fall back to
-- env defaults (`MYME_DEFAULT_QUOTA_*`). Counts are computed on-demand
-- from the underlying tables at quota-check time so no eager-increment
-- columns or daily reconcile job is required for v1.

CREATE TABLE `tenant_quotas` (
  `tenant_id` text PRIMARY KEY NOT NULL,
  `items_limit` integer,
  `webhooks_limit` integer,
  `blobs_limit` integer,
  `storage_bytes_limit` integer,
  `rate_per_minute_limit` integer,
  `updated_at` text NOT NULL
);
