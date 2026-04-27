-- TSC42 §8: handle field on User. Lowercase alphanumeric + hyphens, 3-32
-- chars, optional (users claim through UX rather than at signup). Unique
-- index keys collisions; user_id stays the immutable PK so foreign refs
-- continue to point at id rather than handle.
ALTER TABLE `users` ADD COLUMN `handle` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_handle` ON `users` (`handle`);
