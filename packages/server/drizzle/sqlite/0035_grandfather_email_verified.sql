-- Wave C PR2: grandfather pre-existing accounts so `requireEmailVerification`
-- doesn't lock them out. SQLite peer of the PG migration; same shape.
--
-- SQLite stores `auth_user.created_at` as a Unix-epoch integer
-- (Drizzle timestamp mode). `unixepoch()` is the SQLite equivalent of
-- `NOW()` for that representation.
UPDATE "auth_user"
SET "email_verified" = 1
WHERE "created_at" < unixepoch();
