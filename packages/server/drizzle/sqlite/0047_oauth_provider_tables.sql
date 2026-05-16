-- T-131: @better-auth/oauth-provider plugin tables.
-- Four tables owned by the OAuth Provider plugin: client registrations,
-- consent grants, opaque access tokens, opaque refresh tokens.
-- Naming matches the auth_* convention; the plugin's model→table mapping
-- is wired in `auth/instance.ts` via the `schema` override.
--
-- Cross-table foreign keys on `client_id` (the unique business key, not
-- the PK `id`) are application-enforced — the plugin's own queries
-- maintain integrity. FKs on user_id / session_id reference PKs.
--
-- Token columns store the OUTPUT of `storeTokens.hash` — wired in
-- `auth/instance.ts` to `hashApiKey(token, salt)` so bearer middleware
-- can compute the same value at lookup time.

CREATE TABLE `auth_oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`disabled` integer DEFAULT 0 NOT NULL,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
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
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_client_client_id_unique` ON `auth_oauth_client` (`client_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_oauth_client_client_id` ON `auth_oauth_client` (`client_id`);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_client_user_id` ON `auth_oauth_client` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_client_reference_id` ON `auth_oauth_client` (`reference_id`);
--> statement-breakpoint
CREATE TABLE `auth_oauth_refresh_token` (
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
	FOREIGN KEY (`session_id`) REFERENCES `auth_session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_refresh_token_token` ON `auth_oauth_refresh_token` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_refresh_token_client_id` ON `auth_oauth_refresh_token` (`client_id`);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_refresh_token_user_id` ON `auth_oauth_refresh_token` (`user_id`);
--> statement-breakpoint
CREATE TABLE `auth_oauth_access_token` (
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
	FOREIGN KEY (`session_id`) REFERENCES `auth_session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `auth_oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_oauth_access_token_token_unique` ON `auth_oauth_access_token` (`token`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_oauth_access_token_token` ON `auth_oauth_access_token` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_access_token_client_id` ON `auth_oauth_access_token` (`client_id`);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_access_token_user_id` ON `auth_oauth_access_token` (`user_id`);
--> statement-breakpoint
CREATE TABLE `auth_oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`scopes` text NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_consent_user_client` ON `auth_oauth_consent` (`user_id`,`client_id`);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_consent_reference_id` ON `auth_oauth_consent` (`reference_id`);
