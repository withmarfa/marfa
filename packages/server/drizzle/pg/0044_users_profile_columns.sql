-- T-074: introduce system.profile.
--
-- The users table grows the profile fields (first_name, last_name, bio,
-- avatar_blob_hash) plus a Better Auth FK (auth_user_id) that becomes the
-- canonical bridge between the auth identity and the Myme profile.
--
-- The previous user/auth split kept a `email` column on `users` AND on
-- `auth_user`. That was the shadow-copy hazard the wave plan called out:
-- a Better Auth email rotation would silently leave `users.email` stale.
-- After this migration the only canonical email lives on auth_user; every
-- profile read goes through `users.auth_user_id` -> `auth_user.email`.
--
-- Order matters:
--   1. Add the new columns + the unique index on auth_user_id.
--   2. Backfill auth_user_id by case-insensitive email match against the
--      existing `users.email` snapshot — done WHILE that column still exists.
--   3. Drop `email` and `avatar_url` (semantic break — `avatar_url` becomes
--      `avatar_blob_hash`; existing values are external OAuth profile-pic
--      URLs that don't survive the model change).
--
-- The grandfather script (`grandfather-profiles-t074.ts`) handles the
-- residue: rows where the email match found nothing (created users
-- without a Better Auth account), and rows where `handle IS NULL` (new
-- requirement at sign-up going forward; legacy users get an auto-handle).

-- 1. Add new columns + index.
ALTER TABLE "users" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_blob_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_user_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_auth_user_id" ON "users" ("auth_user_id");--> statement-breakpoint

-- 2. Backfill auth_user_id from auth_user.email (case-insensitive).
-- NULL stays for rows with no matching auth_user (legacy bootstrap admin,
-- pre-Better-Auth signups). The grandfather script handles those.
UPDATE "users" u
SET "auth_user_id" = au."id"
FROM "auth_user" au
WHERE LOWER(au."email") = LOWER(u."email")
  AND u."auth_user_id" IS NULL;--> statement-breakpoint

-- 3. Drop the legacy columns. After this point, profile reads MUST go
-- through auth_user_id; getByEmail no longer exists on UserStore.
ALTER TABLE "users" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "avatar_url";
