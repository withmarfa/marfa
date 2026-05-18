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
-- via the previous shape; the `USING` clause parses each row through
-- `jsonb_array_elements_text` to extract the array values. NULL and
-- empty rows produce NULL / empty arrays accordingly.

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "scopes" TYPE text[]
    USING CASE WHEN "scopes" IS NULL OR "scopes" = '' THEN NULL
               ELSE ARRAY(SELECT jsonb_array_elements_text("scopes"::jsonb)) END;
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "contacts" TYPE text[]
    USING CASE WHEN "contacts" IS NULL OR "contacts" = '' THEN NULL
               ELSE ARRAY(SELECT jsonb_array_elements_text("contacts"::jsonb)) END;
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "redirect_uris" TYPE text[]
    USING ARRAY(SELECT jsonb_array_elements_text("redirect_uris"::jsonb));
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "post_logout_redirect_uris" TYPE text[]
    USING CASE WHEN "post_logout_redirect_uris" IS NULL OR "post_logout_redirect_uris" = '' THEN NULL
               ELSE ARRAY(SELECT jsonb_array_elements_text("post_logout_redirect_uris"::jsonb)) END;
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "grant_types" TYPE text[]
    USING CASE WHEN "grant_types" IS NULL OR "grant_types" = '' THEN NULL
               ELSE ARRAY(SELECT jsonb_array_elements_text("grant_types"::jsonb)) END;
--> statement-breakpoint

ALTER TABLE "auth_oauth_client"
  ALTER COLUMN "response_types" TYPE text[]
    USING CASE WHEN "response_types" IS NULL OR "response_types" = '' THEN NULL
               ELSE ARRAY(SELECT jsonb_array_elements_text("response_types"::jsonb)) END;
--> statement-breakpoint

ALTER TABLE "auth_oauth_refresh_token"
  ALTER COLUMN "scopes" TYPE text[]
    USING ARRAY(SELECT jsonb_array_elements_text("scopes"::jsonb));
--> statement-breakpoint

ALTER TABLE "auth_oauth_access_token"
  ALTER COLUMN "scopes" TYPE text[]
    USING ARRAY(SELECT jsonb_array_elements_text("scopes"::jsonb));
--> statement-breakpoint

ALTER TABLE "auth_oauth_consent"
  ALTER COLUMN "scopes" TYPE text[]
    USING ARRAY(SELECT jsonb_array_elements_text("scopes"::jsonb));
