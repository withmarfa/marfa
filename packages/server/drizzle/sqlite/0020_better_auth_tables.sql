-- Better Auth tables (auth_* prefix, isolated from myme's own users table).
-- Owned by the better-auth library; schema mirrors what
-- `npx @better-auth/cli generate` produces for the email + password core.
-- Timestamps stored as INTEGER (Unix seconds) to match Drizzle
-- integer(mode:timestamp) Date round-trip.

CREATE TABLE `auth_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_user_email_unique` ON `auth_user` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_user_email` ON `auth_user` (`email`);
--> statement-breakpoint
CREATE TABLE `auth_session` (
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
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_session_token_unique` ON `auth_session` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_auth_session_user_id` ON `auth_session` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_session_token` ON `auth_session` (`token`);
--> statement-breakpoint
CREATE TABLE `auth_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
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
--> statement-breakpoint
CREATE INDEX `idx_auth_account_user_id` ON `auth_account` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_account_provider` ON `auth_account` (`provider_id`,`account_id`);
--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auth_verification_identifier` ON `auth_verification` (`identifier`);
