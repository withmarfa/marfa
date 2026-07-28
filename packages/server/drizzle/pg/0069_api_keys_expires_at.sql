-- Runtime credentials get a hard lifetime bound.
--
-- `expires_at` is NULL for human-minted keys (they never expire) and always
-- stamped on runtime-credential mints. The bearer gate refuses a key past its
-- `expires_at` exactly like a revoked one, and the retention reaper revokes
-- and eventually hard-deletes expired runtime-credential rows. Nullable and
-- additive, so existing rows are untouched; pre-existing runtime credentials
-- with NULL `expires_at` are drained by the reaper's age-based sweep.
ALTER TABLE "api_keys" ADD COLUMN "expires_at" text;
