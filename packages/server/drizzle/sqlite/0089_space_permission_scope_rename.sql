-- The eleven verb-less space permissions move from `capability.<name>` to
-- `space.<name>` on the wire, and two of them drop a prefix that only existed
-- to say which thing they were about under the old root: `space_settings` and
-- `space_usage` become `settings` and `usage`. The other nine keep their
-- suffix exactly.
--
-- Eight stored places can hold one of the eleven, and all of them move
-- together or a grant made before this migration stops matching the check
-- that reads it. A held scope that no longer parses is not a refusal anybody
-- can act on: the door answers 403 naming a literal the client never asked
-- for.
--
--   1. `auth_oauth_client.scopes` — a registered client's ceiling.
--   2. `auth_oauth_client.client_credentials_scopes` — the same ceiling for
--      the machine-to-machine grant type, which is a separate column rather
--      than a subset of the first.
--   3. `auth_oauth_access_token.scopes` — live tokens.
--   4. `auth_oauth_refresh_token.scopes` — the tokens those are renewed from.
--   5. `auth_oauth_consent.scopes` — what the person actually ticked, which
--      is what a re-consent screen diffs against.
--   6. `oauth_device_codes.scope` — the device flow's pending request, a
--      space-separated string rather than a list.
--   7. `auth_verification.value` — the pending authorization code, whose
--      JSON carries the verbatim authorize query including its scope.
--   8. `items.properties.scopes` on the `system.connection { kind: "app" }`
--      projection — the row the keys page and the revoke doors read.
--
-- The five `auth_oauth_*` columns hold a JSON array as text, written by the
-- auth library's own adapter, so they are rebuilt with `json_group_array`.
-- `items.properties` holds SQLite's binary JSONB instead, so that rewrite goes
-- through `json(...)` and back through `jsonb(...)` rather than any text
-- replacement over the stored bytes.
--
-- Exact match per literal, never a pattern. A `LIKE 'capability.%'` sweep
-- would also rewrite an integration manifest's capability, which is a
-- different concept under the same English word and does not move.
--
-- Idempotent: a second run matches nothing.
--
-- **The append-only history is deliberately not rewritten.** `versions`,
-- `audit_log`, `event_log` and `outbound_webhook_deliveries` all carry a
-- superseded scope list under the old spelling, and all four are records of
-- what happened rather than state anything authorizes against. Editing them
-- would make the trail disagree with itself: a grant audited as carrying
-- `capability.keys` did carry it under that name.
WITH renames(old_scope, new_scope) AS (VALUES
  ('capability.webhooks',        'space.webhooks'),
  ('capability.connections',     'space.connections'),
  ('capability.upstream_access', 'space.upstream_access'),
  ('capability.credentials',     'space.credentials'),
  ('capability.keys',            'space.keys'),
  ('capability.app_grants',      'space.app_grants'),
  ('capability.schema',          'space.schema'),
  ('capability.item_purge',      'space.item_purge'),
  ('capability.audit_read',      'space.audit_read'),
  ('capability.space_settings',  'space.settings'),
  ('capability.space_usage',     'space.usage')
)
UPDATE auth_oauth_client
SET scopes = (
  SELECT json_group_array(COALESCE(r.new_scope, e.value))
    FROM json_each(auth_oauth_client.scopes) e
    LEFT JOIN renames r ON r.old_scope = e.value
)
WHERE json_valid(scopes)
  AND EXISTS (
    SELECT 1 FROM json_each(auth_oauth_client.scopes) e
      JOIN renames r ON r.old_scope = e.value
  );
--> statement-breakpoint
WITH renames(old_scope, new_scope) AS (VALUES
  ('capability.webhooks',        'space.webhooks'),
  ('capability.connections',     'space.connections'),
  ('capability.upstream_access', 'space.upstream_access'),
  ('capability.credentials',     'space.credentials'),
  ('capability.keys',            'space.keys'),
  ('capability.app_grants',      'space.app_grants'),
  ('capability.schema',          'space.schema'),
  ('capability.item_purge',      'space.item_purge'),
  ('capability.audit_read',      'space.audit_read'),
  ('capability.space_settings',  'space.settings'),
  ('capability.space_usage',     'space.usage')
)
UPDATE auth_oauth_client
SET client_credentials_scopes = (
  SELECT json_group_array(COALESCE(r.new_scope, e.value))
    FROM json_each(auth_oauth_client.client_credentials_scopes) e
    LEFT JOIN renames r ON r.old_scope = e.value
)
WHERE json_valid(client_credentials_scopes)
  AND EXISTS (
    SELECT 1 FROM json_each(auth_oauth_client.client_credentials_scopes) e
      JOIN renames r ON r.old_scope = e.value
  );
--> statement-breakpoint
WITH renames(old_scope, new_scope) AS (VALUES
  ('capability.webhooks',        'space.webhooks'),
  ('capability.connections',     'space.connections'),
  ('capability.upstream_access', 'space.upstream_access'),
  ('capability.credentials',     'space.credentials'),
  ('capability.keys',            'space.keys'),
  ('capability.app_grants',      'space.app_grants'),
  ('capability.schema',          'space.schema'),
  ('capability.item_purge',      'space.item_purge'),
  ('capability.audit_read',      'space.audit_read'),
  ('capability.space_settings',  'space.settings'),
  ('capability.space_usage',     'space.usage')
)
UPDATE auth_oauth_access_token
SET scopes = (
  SELECT json_group_array(COALESCE(r.new_scope, e.value))
    FROM json_each(auth_oauth_access_token.scopes) e
    LEFT JOIN renames r ON r.old_scope = e.value
)
WHERE json_valid(scopes)
  AND EXISTS (
    SELECT 1 FROM json_each(auth_oauth_access_token.scopes) e
      JOIN renames r ON r.old_scope = e.value
  );
--> statement-breakpoint
WITH renames(old_scope, new_scope) AS (VALUES
  ('capability.webhooks',        'space.webhooks'),
  ('capability.connections',     'space.connections'),
  ('capability.upstream_access', 'space.upstream_access'),
  ('capability.credentials',     'space.credentials'),
  ('capability.keys',            'space.keys'),
  ('capability.app_grants',      'space.app_grants'),
  ('capability.schema',          'space.schema'),
  ('capability.item_purge',      'space.item_purge'),
  ('capability.audit_read',      'space.audit_read'),
  ('capability.space_settings',  'space.settings'),
  ('capability.space_usage',     'space.usage')
)
UPDATE auth_oauth_refresh_token
SET scopes = (
  SELECT json_group_array(COALESCE(r.new_scope, e.value))
    FROM json_each(auth_oauth_refresh_token.scopes) e
    LEFT JOIN renames r ON r.old_scope = e.value
)
WHERE json_valid(scopes)
  AND EXISTS (
    SELECT 1 FROM json_each(auth_oauth_refresh_token.scopes) e
      JOIN renames r ON r.old_scope = e.value
  );
--> statement-breakpoint
WITH renames(old_scope, new_scope) AS (VALUES
  ('capability.webhooks',        'space.webhooks'),
  ('capability.connections',     'space.connections'),
  ('capability.upstream_access', 'space.upstream_access'),
  ('capability.credentials',     'space.credentials'),
  ('capability.keys',            'space.keys'),
  ('capability.app_grants',      'space.app_grants'),
  ('capability.schema',          'space.schema'),
  ('capability.item_purge',      'space.item_purge'),
  ('capability.audit_read',      'space.audit_read'),
  ('capability.space_settings',  'space.settings'),
  ('capability.space_usage',     'space.usage')
)
UPDATE auth_oauth_consent
SET scopes = (
  SELECT json_group_array(COALESCE(r.new_scope, e.value))
    FROM json_each(auth_oauth_consent.scopes) e
    LEFT JOIN renames r ON r.old_scope = e.value
)
WHERE json_valid(scopes)
  AND EXISTS (
    SELECT 1 FROM json_each(auth_oauth_consent.scopes) e
      JOIN renames r ON r.old_scope = e.value
  );
--> statement-breakpoint
-- The device flow's pending request is one space-separated string. Chained
-- exact replacement is safe here because no literal in the set is a prefix or
-- a substring of another, so no rewrite can consume part of a neighbor.
UPDATE oauth_device_codes
SET scope = replace(replace(replace(replace(replace(replace(replace(replace(
              replace(replace(replace(scope,
              'capability.space_settings',  'space.settings'),
              'capability.space_usage',     'space.usage'),
              'capability.upstream_access', 'space.upstream_access'),
              'capability.app_grants',      'space.app_grants'),
              'capability.audit_read',      'space.audit_read'),
              'capability.credentials',     'space.credentials'),
              'capability.connections',     'space.connections'),
              'capability.item_purge',      'space.item_purge'),
              'capability.webhooks',        'space.webhooks'),
              'capability.schema',          'space.schema'),
              'capability.keys',            'space.keys')
WHERE scope LIKE '%capability.%';
--> statement-breakpoint
-- The pending authorization code. The auth library stores the verbatim
-- `/oauth2/authorize` query inside this row's JSON `value`, so the requested
-- scope string rides along at `$.query.scope`. The rows live ten minutes, so
-- the population is small — but a code redeemed after the roll mints a
-- refresh token that then rotates indefinitely, which is long enough to
-- matter.
--
-- Replaced as text rather than through the JSON functions, because the same
-- column holds non-JSON values for the library's other verification types
-- and parsing them would fail rather than skip. The substitution changes no
-- structure and introduces no character needing an escape, so a document that
-- was valid JSON still is.
UPDATE auth_verification
SET value = replace(replace(replace(replace(replace(replace(replace(replace(
              replace(replace(replace(value,
              'capability.space_settings',  'space.settings'),
              'capability.space_usage',     'space.usage'),
              'capability.upstream_access', 'space.upstream_access'),
              'capability.app_grants',      'space.app_grants'),
              'capability.audit_read',      'space.audit_read'),
              'capability.credentials',     'space.credentials'),
              'capability.connections',     'space.connections'),
              'capability.item_purge',      'space.item_purge'),
              'capability.webhooks',        'space.webhooks'),
              'capability.schema',          'space.schema'),
              'capability.keys',            'space.keys')
WHERE value LIKE '%capability.%';
--> statement-breakpoint
-- The grant projection a person reads on the keys page. `properties` is
-- binary JSONB, so the array is rebuilt and written back through `jsonb(...)`
-- rather than replaced as text over the stored bytes.
WITH renames(old_scope, new_scope) AS (VALUES
  ('capability.webhooks',        'space.webhooks'),
  ('capability.connections',     'space.connections'),
  ('capability.upstream_access', 'space.upstream_access'),
  ('capability.credentials',     'space.credentials'),
  ('capability.keys',            'space.keys'),
  ('capability.app_grants',      'space.app_grants'),
  ('capability.schema',          'space.schema'),
  ('capability.item_purge',      'space.item_purge'),
  ('capability.audit_read',      'space.audit_read'),
  ('capability.space_settings',  'space.settings'),
  ('capability.space_usage',     'space.usage')
)
UPDATE items
SET properties = jsonb(json_set(json(items.properties), '$.scopes', json((
      SELECT json_group_array(COALESCE(r.new_scope, e.value))
        FROM json_each(json_extract(items.properties, '$.scopes')) e
        LEFT JOIN renames r ON r.old_scope = e.value
    ))))
WHERE type = 'system.connection'
  AND json_extract(properties, '$.kind') = 'app'
  AND json_type(properties, '$.scopes') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(json_extract(items.properties, '$.scopes')) e
      JOIN renames r ON r.old_scope = e.value
  );
