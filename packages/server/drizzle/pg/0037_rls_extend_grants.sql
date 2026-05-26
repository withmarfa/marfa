-- T-025 part 2: extend `marfa_app` GRANTs so the role can satisfy every
-- request path the application takes.
--
-- Part 1 (#161) granted CRUD on the eleven tenant-scoped tables that have
-- RLS policies (items, edges, versions, metadata, api_keys, blobs,
-- custom_types, custom_edge_types, outbound_webhooks, audit_log,
-- event_log) plus tenants/settings (instance-wide read paths). That was
-- enough to verify the schema scaffold via the smoke test, but it was
-- short of what a real request needs once the connection-pool wiring
-- (this PR) starts switching role-on-checkout per request.
--
-- The remaining tables fall into two buckets:
--
--   1. **Tenant-scoped via direct column** — `inbound_webhooks`,
--      `connection_oauth_tokens`, `connection_leased_tokens`. Each has
--      a `tenant_id` column. RLS policies on these tables are filed as
--      a follow-on (the schema-scaffold extension is mechanical, but
--      kept out of this PR to keep the wiring change focused). Until
--      then, GRANTs alone make marfa_app reads/writes work; the
--      application-layer fence remains the load-bearing protection,
--      just like the eleven Part 1 tables before policies landed.
--
--   2. **Indirectly tenant-scoped** — `inbound_webhook_events`
--      (joined via inbound_webhooks), `outbound_webhook_deliveries`
--      (joined via outbound_webhooks), `oauth_clients`, `oauth_codes`,
--      `oauth_tokens`, `oauth_device_codes` (joined via items via
--      connection_item_id), and `users` (hosted-mode user records).
--      marfa_app needs CRUD to satisfy auth + connector + OAuth flows;
--      the application layer continues to enforce tenant boundaries.
--
-- **Better Auth tables** (`auth_user`, `auth_session`, `auth_account`,
-- `auth_verification`, `auth_passkey`) are deliberately NOT granted to
-- marfa_app. Better Auth runs on the unwrapped owner connection (see
-- `pg/index.ts:betterAuthDb = baseDb`) so it bypasses the RLS
-- middleware entirely.
--
-- **Sequences.** `event_log.id` is `BIGINT GENERATED ALWAYS AS
-- IDENTITY`, which creates an implicit sequence. marfa_app needs USAGE
-- on it to insert. Granting on ALL SEQUENCES IN SCHEMA public covers
-- this and any future identity columns.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "inbound_webhooks",
  "inbound_webhook_events",
  "connection_oauth_tokens",
  "connection_leased_tokens",
  "oauth_clients",
  "oauth_codes",
  "oauth_tokens",
  "oauth_device_codes",
  "users",
  "tenant_quotas"
TO "marfa_app";
--> statement-breakpoint

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "marfa_app";
