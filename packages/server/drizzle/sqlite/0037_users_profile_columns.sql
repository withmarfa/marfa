-- T-074: introduce system.profile.
--
-- SQLite mirror of drizzle/pg/0044_users_profile_columns.sql. Same shape:
-- add profile columns + auth_user_id, backfill from email, drop the legacy
-- email + avatar_url columns. SQLite supports `ALTER TABLE … DROP COLUMN`
-- since 3.35; better-sqlite3 ships modern enough to handle this.
--
-- Order matters: backfill while users.email still exists, then drop.

-- 1. Add new columns + index.
ALTER TABLE `users` ADD COLUMN `first_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `last_name` text;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `bio` text;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `avatar_blob_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `auth_user_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_auth_user_id` ON `users` (`auth_user_id`);--> statement-breakpoint

-- 2. Backfill auth_user_id from auth_user.email (case-insensitive).
-- Uses the SQLite-friendly correlated-subquery shape since SQLite's
-- UPDATE…FROM support varies across versions.
UPDATE `users`
SET `auth_user_id` = (
  SELECT `id` FROM `auth_user`
  WHERE LOWER(`auth_user`.`email`) = LOWER(`users`.`email`)
)
WHERE `auth_user_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `auth_user`
    WHERE LOWER(`auth_user`.`email`) = LOWER(`users`.`email`)
  );--> statement-breakpoint

-- 3. Drop the legacy columns.
ALTER TABLE `users` DROP COLUMN `email`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `avatar_url`;
