-- Convert the @better-auth/oauth-provider plugin's `string[]`-typed
-- columns from plain `text` to native PG `text[]`.
--
-- The plugin's drizzleAdapter hardcodes `supportsArrays: true` on the
-- pg provider, which assumes the schema columns are native arrays.
-- The previous `text` columns silently JSON-stringified on insert and
-- returned strings on read, breaking the plugin's `.find(...)` callers
-- with `TypeError: client.redirectUris?.find is not a function`. See
-- the schema comment above `auth_oauth_client.scopes`.
--
-- Existing rows store JSON-stringified arrays (e.g. `["https://..."]`)
-- via the previous shape; each USING clause parses the row through a
-- helper that calls `jsonb_array_elements_text`. The helper is needed
-- because PG rejects subqueries in `ALTER ... USING` transform
-- expressions (`cannot use subquery in transform expression`,
-- SQLSTATE 0A000) — wrapping the subquery in a function moves it out
-- of the transform-expression slot. NULL and empty-string rows
-- collapse to NULL arrays (the empty-string branch is defensive; the
-- prior writer always emits `'[]'` for empty arrays).
--
-- The function is created in `pg_temp` so it's scoped to the migrator
-- session and cleaned up implicitly on session close — no DROP needed
-- and no risk of leaking the helper into application code.

CREATE FUNCTION pg_temp.oauth_text_to_text_array(t text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t IS NULL OR t = '' THEN NULL::text[]
    ELSE ARRAY(SELECT jsonb_array_elements_text(t::jsonb))
  END;
$$;
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "scopes" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("scopes");
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "contacts" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("contacts");
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "redirect_uris" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("redirect_uris");
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "post_logout_redirect_uris" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("post_logout_redirect_uris");
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "grant_types" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("grant_types");
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "response_types" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("response_types");
--> statement-breakpoint

ALTER TABLE "auth_oauth_refresh_token"
  ALTER COLUMN "scopes" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("scopes");
--> statement-breakpoint

ALTER TABLE "auth_oauth_access_token"
  ALTER COLUMN "scopes" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("scopes");
--> statement-breakpoint

ALTER TABLE "auth_oauth_consent"
  ALTER COLUMN "scopes" TYPE text[]
    USING pg_temp.oauth_text_to_text_array("scopes");
