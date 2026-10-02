-- Generated from src/storage/sqlite/schema.ts by scripts/generate-schema-sql.ts; do not edit.
-- Regenerate with: pnpm --filter @withmarfa/server schema-sql:generate
--
-- Applied in full at every database open. Every statement is idempotent, so
-- an existing database is left as it is. The FTS5 virtual table lives in
-- sqlite/connection.ts, which drizzle-kit cannot express.

CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`label` text NOT NULL,
	`source` text NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`default_tier` text DEFAULT 'library' NOT NULL,
	`is_operator` integer DEFAULT false NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`type_permissions` text DEFAULT '{"*":"write"}' NOT NULL,
	`extension_permissions` text DEFAULT '{}' NOT NULL,
	`edge_permissions` text DEFAULT '{}' NOT NULL,
	`metadata_permissions` text DEFAULT '{}' NOT NULL,
	`enforcement_override` text,
	`profile_permissions` text DEFAULT '{}' NOT NULL,
	`oauth_client_id` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_used_at` text,
	CONSTRAINT "api_keys_operator_holds_nothing" CHECK("api_keys"."is_operator" <> 1 OR (
        "api_keys"."type_permissions" = '{}' AND
        "api_keys"."edge_permissions" = '{}' AND
        "api_keys"."metadata_permissions" = '{}' AND
        "api_keys"."extension_permissions" = '{}' AND
        "api_keys"."profile_permissions" = '{}' AND
        "api_keys"."permissions" = '[]' AND
        "api_keys"."sources" = '[]'))
);

CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_api_keys_source_unrevoked` ON `api_keys` (`source`) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`key_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`client_ip` text,
	`details` text DEFAULT '{}' NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_audit_log_created_at` ON `audit_log` (`created_at`);
CREATE INDEX IF NOT EXISTS `idx_audit_log_action` ON `audit_log` (`action`);
CREATE INDEX IF NOT EXISTS `idx_audit_log_resource_type` ON `audit_log` (`resource_type`);
CREATE TABLE IF NOT EXISTS `auth_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_auth_account_user_id` ON `auth_account` (`user_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auth_account_provider` ON `auth_account` (`provider_id`,`account_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auth_account_issuer_account_id` ON `auth_account` (`issuer`,`account_id`);
CREATE TABLE IF NOT EXISTS `auth_jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`alg` text,
	`crv` text
);

CREATE TABLE IF NOT EXISTS `auth_oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`refresh_id` text,
	`expires_at` integer,
	`created_at` integer,
	`scopes` text NOT NULL,
	`authorization_code_id` text,
	`confirmation` text,
	`requested_user_info_claims` text,
	`resources` text,
	`revoked` integer,
	FOREIGN KEY (`session_id`) REFERENCES `auth_session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `auth_oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS `auth_oauth_access_token_token_unique` ON `auth_oauth_access_token` (`token`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auth_oauth_access_token_token` ON `auth_oauth_access_token` (`token`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_access_token_client_id` ON `auth_oauth_access_token` (`client_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_access_token_user_id` ON `auth_oauth_access_token` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_access_token_authorization_code_id` ON `auth_oauth_access_token` (`authorization_code_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_access_token_session_id` ON `auth_oauth_access_token` (`session_id`);
CREATE TABLE IF NOT EXISTS `auth_oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`disabled` integer DEFAULT false NOT NULL,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`client_credentials_scopes` text,
	`application_type` text,
	`backchannel_logout_session_required` integer,
	`backchannel_logout_uri` text,
	`client_discovery_id` text,
	`dpop_bound_access_tokens` integer,
	`jwks` text,
	`jwks_uri` text,
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`token_endpoint_auth_method` text,
	`grant_types` text,
	`response_types` text,
	`public` integer,
	`type` text,
	`require_pkce` integer,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS `auth_oauth_client_client_id_unique` ON `auth_oauth_client` (`client_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auth_oauth_client_client_id` ON `auth_oauth_client` (`client_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_client_user_id` ON `auth_oauth_client` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_client_reference_id` ON `auth_oauth_client` (`reference_id`);
CREATE TABLE IF NOT EXISTS `auth_oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`scopes` text NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	`requested_user_info_claims` text,
	`resources` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS `uq_auth_oauth_consent_client_user` ON `auth_oauth_consent` (`client_id`,`user_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_consent_reference_id` ON `auth_oauth_consent` (`reference_id`);
CREATE TABLE IF NOT EXISTS `auth_oauth_device_code` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	`oauth_client_id` text,
	`resources` text
);

CREATE UNIQUE INDEX IF NOT EXISTS `uq_auth_oauth_device_code_device_code` ON `auth_oauth_device_code` (`device_code`);
CREATE UNIQUE INDEX IF NOT EXISTS `uq_auth_oauth_device_code_user_code` ON `auth_oauth_device_code` (`user_code`);
CREATE TABLE IF NOT EXISTS `auth_oauth_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`expires_at` integer,
	`created_at` integer,
	`revoked` integer,
	`auth_time` integer,
	`scopes` text NOT NULL,
	`authorization_code_id` text,
	`confirmation` text,
	`requested_user_info_claims` text,
	`resources` text,
	`rotated_at` integer,
	`rotation_replay_expires_at` integer,
	`rotation_replay_response` text,
	FOREIGN KEY (`session_id`) REFERENCES `auth_session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_auth_oauth_refresh_token_token` ON `auth_oauth_refresh_token` (`token`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_refresh_token_client_id` ON `auth_oauth_refresh_token` (`client_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_refresh_token_user_id` ON `auth_oauth_refresh_token` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_refresh_token_authorization_code_id` ON `auth_oauth_refresh_token` (`authorization_code_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_oauth_refresh_token_session_id` ON `auth_oauth_refresh_token` (`session_id`);
CREATE TABLE IF NOT EXISTS `auth_passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_auth_passkey_user_id` ON `auth_passkey` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_auth_passkey_credential_id` ON `auth_passkey` (`credential_id`);
CREATE TABLE IF NOT EXISTS `auth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS `auth_session_token_unique` ON `auth_session` (`token`);
CREATE INDEX IF NOT EXISTS `idx_auth_session_user_id` ON `auth_session` (`user_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auth_session_token` ON `auth_session` (`token`);
CREATE TABLE IF NOT EXISTS `auth_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `auth_user_email_unique` ON `auth_user` (`email`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auth_user_email` ON `auth_user` (`email`);
CREATE TABLE IF NOT EXISTS `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_auth_verification_identifier` ON `auth_verification` (`identifier`);
CREATE TABLE IF NOT EXISTS `blob_locations` (
	`hash` text NOT NULL,
	`store_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`verified_at` text,
	PRIMARY KEY(`hash`, `store_id`),
	FOREIGN KEY (`hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `blob_stores`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX IF NOT EXISTS `idx_blob_locations_store_verified` ON `blob_locations` (`store_id`,`verified_at`);
CREATE TABLE IF NOT EXISTS `blob_orphans` (
	`hash` text PRIMARY KEY NOT NULL,
	`reported_at` text NOT NULL,
	FOREIGN KEY (`hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `blob_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`locator` text NOT NULL,
	`policy` text DEFAULT 'all' NOT NULL,
	`attached_at` text NOT NULL,
	`detached_at` text
);

CREATE TABLE IF NOT EXISTS `blob_uploaders` (
	`hash` text NOT NULL,
	`uploader` text NOT NULL,
	PRIMARY KEY(`hash`, `uploader`),
	FOREIGN KEY (`hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `bulk_action_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text,
	`status` text NOT NULL,
	`action` text NOT NULL,
	`input` text NOT NULL,
	`matched_ids` text NOT NULL,
	`matched_count` integer DEFAULT 0 NOT NULL,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`succeeded_count` integer DEFAULT 0 NOT NULL,
	`errored_count` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`worker_id` text,
	`worker_heartbeat_at` text,
	`idempotency_key` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);

CREATE INDEX IF NOT EXISTS `idx_bulk_action_jobs_status` ON `bulk_action_jobs` (`status`);
CREATE INDEX IF NOT EXISTS `idx_bulk_action_jobs_gc` ON `bulk_action_jobs` (`status`,`finished_at`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_bulk_action_jobs_idempotency` ON `bulk_action_jobs` (`idempotency_key`) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS `cascade_marks` (
	`item_id` text PRIMARY KEY NOT NULL,
	`trashed_with` text NOT NULL,
	`trashed_with_type` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `connector_agreements` (
	`source` text NOT NULL,
	`item_id` text NOT NULL,
	`waiting` integer NOT NULL,
	`record` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`source`, `item_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_connector_agreements_waiting` ON `connector_agreements` (`source`,`waiting`,`updated_at`,`item_id`);
CREATE INDEX IF NOT EXISTS `idx_connector_agreements_updated` ON `connector_agreements` (`source`,`updated_at`,`item_id`);
CREATE INDEX IF NOT EXISTS `idx_connector_agreements_item` ON `connector_agreements` (`item_id`);
CREATE TABLE IF NOT EXISTS `connector_holds` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`process` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `connector_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`outcome` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`summary` text,
	`error` text,
	`reported_at` text NOT NULL,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_connector_runs_connector_reported` ON `connector_runs` (`connector_id`,`reported_at`);
CREATE TABLE IF NOT EXISTS `connector_states` (
	`source` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`registered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_heartbeat_at` text
);

CREATE UNIQUE INDEX IF NOT EXISTS `connectors_key_id_unique` ON `connectors` (`key_id`);
CREATE TABLE IF NOT EXISTS `edge_types` (
	`id` text PRIMARY KEY NOT NULL,
	`schema` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`edge_type` text NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_edges_source` ON `edges` (`source_id`,`edge_type`);
CREATE INDEX IF NOT EXISTS `idx_edges_target` ON `edges` (`target_id`,`edge_type`);
CREATE INDEX IF NOT EXISTS `idx_edges_updated_at_id` ON `edges` (`updated_at`,`id`);
CREATE TABLE IF NOT EXISTS `enrichment_state` (
	`item_id` text PRIMARY KEY NOT NULL,
	`blob_ref` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`config_signature` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`item_id` text,
	`edge_id` text,
	`payload` text NOT NULL,
	`enable_fanout` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_event_log_created_at` ON `event_log` (`created_at`);
CREATE INDEX IF NOT EXISTS `idx_event_log_edge_id` ON `event_log` (`edge_id`);
CREATE TABLE IF NOT EXISTS `housekeeping` (
	`name` text PRIMARY KEY NOT NULL,
	`interval_ms` integer NOT NULL,
	`next_run_at` text NOT NULL,
	`running_since` text,
	`last_started_at` text,
	`last_finished_at` text,
	`last_outcome` text,
	`last_error` text,
	`last_result` text
);

CREATE TABLE IF NOT EXISTS `idempotency_records` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`response_status` integer,
	`response_content_type` text,
	`response_body` text,
	`created_at` text NOT NULL,
	`completed_at` text
);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_idempotency_records_key` ON `idempotency_records` (`idempotency_key`);
CREATE INDEX IF NOT EXISTS `idx_idempotency_records_gc` ON `idempotency_records` (`created_at`);
CREATE TABLE IF NOT EXISTS `inbound_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`received_at` text NOT NULL,
	`method` text NOT NULL,
	`query` text NOT NULL,
	`headers` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`dedupe_key` text,
	`handled_at` text,
	`outcome` text,
	FOREIGN KEY (`endpoint_id`) REFERENCES `inbound_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_inbound_deliveries_connector_handled` ON `inbound_deliveries` (`connector_id`,`handled_at`,`received_at`,`id`);
CREATE INDEX IF NOT EXISTS `idx_inbound_deliveries_endpoint_dedupe` ON `inbound_deliveries` (`endpoint_id`,`dedupe_key`);
CREATE INDEX IF NOT EXISTS `idx_inbound_deliveries_received` ON `inbound_deliveries` (`received_at`);
CREATE TABLE IF NOT EXISTS `inbound_delivery_bodies` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`body` blob NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `inbound_deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `inbound_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_last4` text NOT NULL,
	`label` text,
	`duplicate_header` text,
	`created_at` text NOT NULL,
	`retired_at` text,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS `inbound_endpoints_token_hash_unique` ON `inbound_endpoints` (`token_hash`);
CREATE INDEX IF NOT EXISTS `idx_inbound_endpoints_connector` ON `inbound_endpoints` (`connector_id`);
CREATE TABLE IF NOT EXISTS `item_blob_references` (
	`hash` text NOT NULL,
	`item_id` text NOT NULL,
	`lends` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`hash`, `item_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_item_blob_references_item` ON `item_blob_references` (`item_id`);
CREATE TABLE IF NOT EXISTS `item_links` (
	`type` text NOT NULL,
	`value` text NOT NULL,
	`item_id` text NOT NULL,
	PRIMARY KEY(`type`, `value`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS `idx_item_links_item` ON `item_links` (`item_id`);
CREATE TABLE IF NOT EXISTS `items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`tier` text DEFAULT 'library' NOT NULL,
	`trashed_at` text,
	`properties` blob NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source` text,
	`source_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer,
	`capture_latitude` real,
	`capture_longitude` real,
	`starts_at` text,
	`ends_at` text
);

CREATE INDEX IF NOT EXISTS `idx_items_type` ON `items` (`type`);
CREATE INDEX IF NOT EXISTS `idx_items_state` ON `items` (`state`);
CREATE INDEX IF NOT EXISTS `idx_items_created_at` ON `items` (`created_at`);
CREATE INDEX IF NOT EXISTS `idx_items_occurred_at` ON `items` (`occurred_at`);
CREATE INDEX IF NOT EXISTS `idx_items_updated_at_id` ON `items` (`updated_at`,`id`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_items_source_dedup` ON `items` (`source`,`source_id`) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS `idx_items_source_id_prefix` ON `items` ("source_id" COLLATE NOCASE) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS `idx_items_starts_at` ON `items` (`starts_at`) WHERE starts_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS `idx_items_enrichment_queue` ON `items` (`created_at`) WHERE state <> 'trashed' AND json_extract(properties, '$.blob_ref') IS NOT NULL;
CREATE TABLE IF NOT EXISTS `link_tombstones` (
	`type` text NOT NULL,
	`value` text NOT NULL,
	`purged_at` text NOT NULL,
	`settled_at` text NOT NULL,
	PRIMARY KEY(`type`, `value`)
);

CREATE TABLE IF NOT EXISTS `metadata` (
	`item_id` text PRIMARY KEY NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`extensions` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS `natural_key_tombstones` (
	`type` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`purged_at` text NOT NULL,
	`settled_at` text NOT NULL,
	PRIMARY KEY(`type`, `source`, `source_id`)
);

CREATE INDEX IF NOT EXISTS `idx_natural_key_tombstones_key` ON `natural_key_tombstones` (`source`,`source_id`);
CREATE TABLE IF NOT EXISTS `outbound_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_type` text NOT NULL,
	`status_code` integer,
	`attempt` integer NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`next_attempt_at` text,
	`payload` text,
	`webhook_url` text,
	`webhook_secret` text,
	`max_attempts` integer DEFAULT 4 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_outbound_webhook_deliveries_webhook_id` ON `outbound_webhook_deliveries` (`webhook_id`);
CREATE INDEX IF NOT EXISTS `idx_outbound_webhook_deliveries_pending` ON `outbound_webhook_deliveries` (`next_attempt_at`) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS `outbound_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`type_filter` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `rate_limit_windows` (
	`family` text NOT NULL,
	`window_key` text NOT NULL,
	`count` integer NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`family`, `window_key`)
);

CREATE INDEX IF NOT EXISTS `idx_rate_limit_windows_expires_at` ON `rate_limit_windows` (`expires_at`);
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `trash_cascades` (
	`item_id` text PRIMARY KEY NOT NULL,
	`trashed_with` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trashed_with`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_trash_cascades_with` ON `trash_cascades` (`trashed_with`);
CREATE TABLE IF NOT EXISTS `types` (
	`id` text PRIMARY KEY NOT NULL,
	`schema` text NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`family` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_types_origin` ON `types` (`origin`);
CREATE TABLE IF NOT EXISTS `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`version` integer NOT NULL,
	`properties` text NOT NULL,
	`tier` text,
	`occurred_at` text,
	`source_id` text,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS `idx_versions_item_id` ON `versions` (`item_id`);
