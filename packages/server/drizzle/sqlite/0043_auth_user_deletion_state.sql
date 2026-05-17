-- T-116: account-lifecycle state on auth_user. See pg/0050 for the full note.
ALTER TABLE `auth_user` ADD COLUMN `deletion_state` text NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `auth_user` ADD COLUMN `pending_deletion_at` text;
