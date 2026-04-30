-- Passkey credentials (one per registered authenticator).
-- Required by the @better-auth/passkey plugin (PR 2 of workstream 1).

CREATE TABLE `auth_passkey` (
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
--> statement-breakpoint
CREATE INDEX `idx_auth_passkey_user_id` ON `auth_passkey` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_auth_passkey_credential_id` ON `auth_passkey` (`credential_id`);
