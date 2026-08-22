-- The session-delete hook queries auth_oauth_access_token and
-- auth_oauth_refresh_token by session_id on every sign-out. Neither table had
-- an index on that column, so each sign-out ran two sequential scans.
--
-- The auth plugin's own declared schema marks sessionId as indexed; the
-- hand-maintained Drizzle schema had diverged from it. Additive, so nothing
-- reads differently afterwards.
CREATE INDEX IF NOT EXISTS "idx_auth_oauth_access_token_session_id" ON "auth_oauth_access_token" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auth_oauth_refresh_token_session_id" ON "auth_oauth_refresh_token" ("session_id");
