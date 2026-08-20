-- The platform's first-party types now live under the `marfa.*` root, and
-- captured emails move from `withmarfa.captured_email` to
-- `marfa.captured_email`. Unlike the podcast pair, which renamed in place
-- with no rows anywhere, captured emails exist in live databases, so the
-- stored rows are rewritten here and the old identifier stays registered
-- as documented legacy. Three shapes carry the identifier: `items.type`
-- (plain string), `api_keys.type_permissions` (a JSON object serialized
-- into a text column, keyed by type pattern), and the OAuth scope arrays
-- on the Better Auth provider tables (`text[]`, holding literals such as
-- 'withmarfa.captured_email:read').
--
-- Idempotent: re-running over already-renamed rows finds zero matches and
-- no-ops. Fresh DBs match zero rows on first run.
UPDATE "items"
SET "type" = 'marfa.captured_email'
WHERE "type" = 'withmarfa.captured_email';
--> statement-breakpoint
-- Rename the permission-map key, preserving its value. Only rows where
-- the new key is absent take this path, so a map that somehow carries
-- both keeps the grant already made under the new one.
UPDATE "api_keys"
SET "type_permissions" = jsonb_set(
  "type_permissions"::jsonb - 'withmarfa.captured_email',
  '{marfa.captured_email}',
  "type_permissions"::jsonb -> 'withmarfa.captured_email'
)::text
WHERE "type_permissions"::jsonb ? 'withmarfa.captured_email'
  AND NOT "type_permissions"::jsonb ? 'marfa.captured_email';
--> statement-breakpoint
-- Any row still carrying the old key at this point also carries the new
-- one, so the old key is simply dropped.
UPDATE "api_keys"
SET "type_permissions" = ("type_permissions"::jsonb - 'withmarfa.captured_email')::text
WHERE "type_permissions"::jsonb ? 'withmarfa.captured_email';
--> statement-breakpoint
-- OAuth scope literals on the provider tables. Consent rows are the
-- standing grants, access tokens are what the bearer middleware projects
-- into permissions, and refresh tokens seed the scopes of every token
-- they rotate into. All three carry the same `<type>:<verb>` literals,
-- so all three are rewritten or a refresh would resurrect the old scope.
UPDATE "auth_oauth_consent"
SET "scopes" = array_replace(
  array_replace("scopes", 'withmarfa.captured_email:read', 'marfa.captured_email:read'),
  'withmarfa.captured_email:write', 'marfa.captured_email:write'
)
WHERE "scopes" && ARRAY['withmarfa.captured_email:read', 'withmarfa.captured_email:write'];
--> statement-breakpoint
UPDATE "auth_oauth_access_token"
SET "scopes" = array_replace(
  array_replace("scopes", 'withmarfa.captured_email:read', 'marfa.captured_email:read'),
  'withmarfa.captured_email:write', 'marfa.captured_email:write'
)
WHERE "scopes" && ARRAY['withmarfa.captured_email:read', 'withmarfa.captured_email:write'];
--> statement-breakpoint
UPDATE "auth_oauth_refresh_token"
SET "scopes" = array_replace(
  array_replace("scopes", 'withmarfa.captured_email:read', 'marfa.captured_email:read'),
  'withmarfa.captured_email:write', 'marfa.captured_email:write'
)
WHERE "scopes" && ARRAY['withmarfa.captured_email:read', 'withmarfa.captured_email:write'];
