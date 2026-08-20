-- The platform's first-party types now live under the `marfa.*` root, and
-- captured emails move from `withmarfa.captured_email` to
-- `marfa.captured_email`. Unlike the podcast pair, which renamed in place
-- with no rows anywhere, captured emails exist in live databases, so the
-- stored rows are rewritten here and the old identifier stays registered
-- as documented legacy. Three shapes carry the identifier: `items.type`
-- (plain string), `api_keys.type_permissions` (a JSON object stored as
-- text, keyed by type pattern), and the OAuth scope lists on the Better
-- Auth provider tables (JSON arrays stored as text on this dialect,
-- holding literals such as 'withmarfa.captured_email:read').
--
-- Idempotent: re-running over already-renamed rows finds zero matches and
-- no-ops. Fresh DBs match zero rows on first run.
UPDATE items
SET type = 'marfa.captured_email'
WHERE type = 'withmarfa.captured_email';
--> statement-breakpoint
-- Rename the permission-map key, preserving its value. Only rows where
-- the new key is absent take this path, so a map that somehow carries
-- both keeps the grant already made under the new one.
UPDATE api_keys
SET type_permissions = json_set(
  json_remove(type_permissions, '$."withmarfa.captured_email"'),
  '$."marfa.captured_email"',
  json_extract(type_permissions, '$."withmarfa.captured_email"')
)
WHERE json_extract(type_permissions, '$."withmarfa.captured_email"') IS NOT NULL
  AND json_extract(type_permissions, '$."marfa.captured_email"') IS NULL;
--> statement-breakpoint
-- Any row still carrying the old key at this point also carries the new
-- one, so the old key is simply dropped.
UPDATE api_keys
SET type_permissions = json_remove(type_permissions, '$."withmarfa.captured_email"')
WHERE json_extract(type_permissions, '$."withmarfa.captured_email"') IS NOT NULL;
--> statement-breakpoint
-- OAuth scope literals on the provider tables. Consent rows are the
-- standing grants, access tokens are what the bearer middleware projects
-- into permissions, and refresh tokens seed the scopes of every token
-- they rotate into. All three carry the same `<type>:<verb>` literals,
-- so all three are rewritten or a refresh would resurrect the old scope.
-- The scopes column is a JSON array serialized to text; replacing the
-- quoted literal is exact because the identifier needs no JSON escaping.
UPDATE auth_oauth_consent
SET scopes = replace(
  replace(scopes, '"withmarfa.captured_email:read"', '"marfa.captured_email:read"'),
  '"withmarfa.captured_email:write"', '"marfa.captured_email:write"'
)
WHERE scopes LIKE '%"withmarfa.captured_email:%';
--> statement-breakpoint
UPDATE auth_oauth_access_token
SET scopes = replace(
  replace(scopes, '"withmarfa.captured_email:read"', '"marfa.captured_email:read"'),
  '"withmarfa.captured_email:write"', '"marfa.captured_email:write"'
)
WHERE scopes LIKE '%"withmarfa.captured_email:%';
--> statement-breakpoint
UPDATE auth_oauth_refresh_token
SET scopes = replace(
  replace(scopes, '"withmarfa.captured_email:read"', '"marfa.captured_email:read"'),
  '"withmarfa.captured_email:write"', '"marfa.captured_email:write"'
)
WHERE scopes LIKE '%"withmarfa.captured_email:%';
