-- T-052: per-tenant resource quotas. See sqlite/0033 for design notes.

CREATE TABLE "tenant_quotas" (
  "tenant_id" text PRIMARY KEY NOT NULL,
  "items_limit" integer,
  "webhooks_limit" integer,
  "blobs_limit" integer,
  "storage_bytes_limit" bigint,
  "rate_per_minute_limit" integer,
  "updated_at" text NOT NULL
);
